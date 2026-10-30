"""One-time fresh official ima login. Never print or save captured credentials.

The isolated gstack browser holds the new login only for this setup. Capture
uses subprocess pipes in memory, then the existing owner-private bridge. It
does not read any user's pre-existing browser/ima profiles.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import uuid

SITE = os.environ.get("IMA_CLOUD_URL", "https://your-ima-server.example").rstrip("/")
STORAGE_KEY = "ima-universal-local-storage-accountInfo"
HOME = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "KnowledgeCardFlow"
RUNS = HOME / "ima-login"
NOW = lambda: dt.datetime.now(dt.timezone.utc).isoformat()


class SetupError(Exception):
    pass


def native_run(args, *, env=None, timeout=45, input=None):
    flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    try:
        p = subprocess.run(args, env=env, input=input, capture_output=True,
                           timeout=timeout, **flags)
    except (OSError, subprocess.TimeoutExpired):
        raise SetupError("login_browser_unavailable") from None
    if p.returncode:
        # Browser output may contain page data. Never forward it into errors.
        raise SetupError("login_browser_command_failed")
    # Windows ACL utilities use the active console code page; browser JSON
    # is UTF-8. Decode here, not in subprocess reader threads that could emit
    # uncontrolled tracebacks. Account tokens themselves are ASCII.
    return p.stdout.decode("utf-8", errors="replace")


def protect(path):
    path.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        sid = json.loads(native_run([
            "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
            "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value | ConvertTo-Json"
        ]))
        native_run(["icacls.exe", str(path), "/inheritance:r", "/grant:r",
                    f"*{sid}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"])


def metadata(run_id):
    if not re.fullmatch(r"[a-f0-9]{32}", run_id):
        raise SetupError("invalid_login_run")
    path = RUNS / run_id
    try:
        data = json.loads((path / "run.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise SetupError("login_run_missing") from None
    if data.get("run_id") != run_id or data.get("fresh_profile") is not True:
        raise SetupError("login_run_not_fresh")
    return path, data


def browse_env(path, conf):
    env = os.environ.copy()
    env["BROWSE_STATE_FILE"] = str(path / "browse.json")
    env["CHROMIUM_PROFILE"] = str(path / "chromium-profile")
    env.pop("BROWSE_HEADED", None)
    env["PYTHONUTF8"] = "1"
    proxy = conf.get("browse_proxy")
    if proxy:
        env["BROWSE_PROXY_URL"] = proxy
        env["HTTPS_PROXY"] = env["HTTP_PROXY"] = env["ALL_PROXY"] = proxy
    return env


def browser(path, conf, *args):
    if conf.get("_existing_browser_only"):
        return existing_browser(path, *args)
    exe = conf.get("browse_executable")
    if not exe or not Path(exe).is_file():
        raise SetupError("configured_browse_executable_missing")
    return native_run([exe, *args], env=browse_env(path, conf))


def existing_browser(path, *args):
    """Use only this run's daemon, without the CLI's auto-start/restart path."""
    try:
        state = json.loads((path / "browse.json").read_text(encoding="utf-8"))
        port, token = state["port"], state["token"]
        if type(port) is not int or not 1 <= port <= 65535 or not isinstance(token, str) or not token:
            raise ValueError()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        req = urllib.request.Request(f"http://127.0.0.1:{port}/command",
            data=json.dumps({"command": args[0], "args": list(args[1:])}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
            method="POST")
        with opener.open(req, timeout=45) as response:
            return response.read(1024 * 1024 + 1).decode("utf-8")
    except (OSError, ValueError, KeyError, TypeError, urllib.error.URLError):
        raise SetupError("fresh_login_browser_unavailable") from None


def official_origin(path, conf):
    url = browser(path, conf, "url").strip()
    u = urlsplit(url)
    if u.scheme != "https" or u.netloc != "ima.qq.com":
        raise SetupError("official_ima_page_required")


def status(path, conf):
    official_origin(path, conf)
    expression = "(() => {try {const a=JSON.parse(localStorage.getItem(" + json.dumps(STORAGE_KEY) + ")||'null');return {logged_in:!!(a&&a.userId&&a.token&&a.refreshToken)};}catch{return {logged_in:false}}})()"
    try:
        result = json.loads(browser(path, conf, "js", expression))
    except ValueError:
        raise SetupError("login_status_unavailable") from None
    return {"status": "succeeded", "logged_in": result.get("logged_in") is True}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def bridge_post(conf, payload):
    cloud = json.loads((HOME / "cloud-client.json").read_text(encoding="utf-8-sig"))
    if str(cloud.get("IMA_CLOUD_URL", "")).rstrip("/") != SITE:
        raise SetupError("selected_private_site_mismatch")
    service = cloud.get("IMA_CLOUD_SERVICE_TOKEN")
    bridge = cloud.get("IMA_CLOUD_BRIDGE_TOKEN")
    if not service or not bridge:
        raise SetupError("private_bridge_credentials_missing")
    opener = urllib.request.build_opener(
        # This selected private Site is directly reachable. The ima-specific
        # local browser proxy must not be reused for cloud session transfer.
        urllib.request.ProxyHandler({}),
        NoRedirect())
    req = urllib.request.Request(SITE + "/bridge/v1/session",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json; charset=utf-8",
                 "OAI-Sites-Authorization": "Bearer " + service,
                 "x-ima-bridge-token": bridge})
    try:
        with opener.open(req, timeout=45) as response:
            data = json.loads(response.read(65537))
    except (OSError, ValueError, urllib.error.URLError):
        # No exception/body is surfaced: they could include provider secrets.
        raise SetupError("private_session_transfer_unavailable") from None
    # Deliberately reconstruct only allowed, non-sensitive output fields.
    session = data.get("session") or {}
    return {"status": data.get("status", "unavailable"), "session": {
        key: session[key] for key in ("state", "connection_state", "authenticated",
            "account_bound", "move_verified", "reauthorization_required", "expires_at", "revision")
        if key in session}}


def read_capture(path, conf):
    if not status(path, conf)["logged_in"]:
        raise SetupError("scan_official_qr_first")
    expression = "(() => {if(location.origin!=='https://ima.qq.com')return null;const a=JSON.parse(localStorage.getItem(" + json.dumps(STORAGE_KEY) + ")||'null');return a?{account_info:a,device_info:{qua:navigator.userAgent.replace(/;/g,',')}}:null})()"
    try:
        # Audit inspected: gstack logs command text, not command results.
        # Keep this stdout captured in memory; never print it or write it.
        fresh = json.loads(browser(path, conf, "js", expression))
    except ValueError:
        raise SetupError("fresh_login_capture_failed") from None
    if not isinstance(fresh, dict) or not isinstance(fresh.get("account_info"), dict):
        raise SetupError("fresh_login_capture_failed")
    fresh["account_info"] = {k: v for k, v in fresh["account_info"].items() if v is not None and v != ""}
    if not isinstance(fresh.get("device_info"), dict):
        raise SetupError("fresh_login_capture_failed")
    return {"account_info": fresh["account_info"], "device_info": fresh["device_info"]}


def capture(path, conf, run_id):
    if (path / "completed.json").is_file():
        return bridge_post(conf, {"action": "status"})
    fresh = read_capture(path, conf)
    try:
        result = bridge_post(conf, {"action": "install", "installation_id": run_id, **fresh})
    finally:
        fresh.clear()
    if result["status"] == "succeeded":
        try:
            browser(path, conf, "stop")
            result["browser_closed"] = True
        except SetupError:
            result["browser_closed"] = False
        # Only a harmless completion receipt remains in the setup directory.
        (path / "completed.json").write_text(json.dumps({"completed_at": NOW(), **result}), encoding="utf-8")
    return result


ENVELOPE_FIELDS = ("installation_id", "issued_at", "key_id", "wrapped_key", "iv", "ciphertext")


def relay_envelope(value, run_id, key_id):
    """Whitelist and validate all output before persisting or returning anything."""
    try:
        if not isinstance(value, dict) or set(value) != set(ENVELOPE_FIELDS):
            raise ValueError()
        if any(not isinstance(value[k], str) for k in ENVELOPE_FIELDS):
            raise ValueError()
        if value["installation_id"] != run_id or value["key_id"] != key_id:
            raise ValueError()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value["issued_at"]):
            raise ValueError()
        dt.datetime.fromisoformat(value["issued_at"].replace("Z", "+00:00"))
        decoded = {}
        for field in ("wrapped_key", "iv", "ciphertext"):
            decoded[field] = base64.b64decode(value[field], validate=True)
            if base64.b64encode(decoded[field]).decode("ascii") != value[field]:
                raise ValueError()
        if len(decoded["iv"]) != 12 or not 256 <= len(decoded["wrapped_key"]) <= 1024:
            raise ValueError()
        if not 16 < len(decoded["ciphertext"]) <= 1024 * 1024:
            raise ValueError()
        return {k: value[k] for k in ENVELOPE_FIELDS}
    except (ValueError, TypeError, binascii.Error):
        raise SetupError("ima_session_seal_failed") from None


def stop_fresh_browser(path, conf):
    try:
        browser(path, conf, "stop")
    except SetupError:
        # The run-scoped daemon removes its state on shutdown before its HTTP
        # response can reach us. No surviving state means there is no daemon
        # to recapture or restart; the already saved ciphertext is recoverable.
        if (path / "browse.json").exists():
            raise


def relay_capture(path, conf, run_id, key_file):
    actual, _ = metadata(run_id)
    if actual.resolve() != path.resolve():
        raise SetupError("invalid_login_run")
    try:
        manifest = json.loads(Path(key_file).read_text(encoding="utf-8-sig"))
        if not isinstance(manifest, dict) or manifest.get("algorithm") != "RSA-OAEP-SHA256+A256GCM":
            raise ValueError()
        key_id = manifest["key_id"]
        if not isinstance(key_id, str) or not re.fullmatch(r"[a-f0-9]{64}", key_id):
            raise ValueError()
        der = base64.b64decode(manifest["public_key_spki"], validate=True)
        if hashlib.sha256(der).hexdigest() != key_id:
            raise ValueError()
    except (OSError, ValueError, KeyError, TypeError, binascii.Error):
        raise SetupError("invalid_relay_public_key") from None
    local_conf = {**conf, "_existing_browser_only": True}
    sealed = path / "sealed.json"
    if sealed.exists():
        try:
            envelope = relay_envelope(json.loads(sealed.read_text(encoding="utf-8")), run_id, key_id)
        except (OSError, ValueError):
            raise SetupError("ima_session_seal_failed") from None
        if (path / "browse.json").exists():
            stop_fresh_browser(path, local_conf)
        return {"status": "sealed", "envelope": envelope}
    if (path / "completed.json").exists():
        raise SetupError("login_run_already_completed")
    fresh = read_capture(path, local_conf)
    payload = None
    try:
        payload = json.dumps({"key": manifest, "installation_id": run_id, **fresh},
                             ensure_ascii=False).encode("utf-8")
        try:
            output = native_run(["node", str(Path(__file__).with_name("seal-ima-session.mjs"))], input=payload)
            envelope = relay_envelope(json.loads(output), run_id, key_id)
        except (SetupError, ValueError, TypeError):
            raise SetupError("ima_session_seal_failed") from None
    finally:
        fresh.clear()
        payload = None
    protect(path)
    # Exclusive creation prevents overwriting a prior sealed receipt. Only the
    # validated ciphertext envelope is written inside the protected run folder.
    try:
        with sealed.open("x", encoding="utf-8") as target:
            target.write(json.dumps(envelope))
    except OSError:
        raise SetupError("sealed_session_save_failed") from None
    # Closing uses the same run-scoped daemon, never an unrelated browser.
    stop_fresh_browser(path, local_conf)
    return {"status": "sealed", "envelope": envelope}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["start", "status", "capture", "relay-capture", "verify", "close"])
    parser.add_argument("--run")
    parser.add_argument("--relay-key-file")
    args = parser.parse_args()
    conf = json.loads((HOME / "config.json").read_text(encoding="utf-8-sig"))
    if args.command == "start":
        run_id = uuid.uuid4().hex
        protect(RUNS)
        path = RUNS / run_id
        if path.exists():
            raise SetupError("fresh_login_directory_collision")
        protect(path)
        data = {"run_id": run_id, "created_at": NOW(), "fresh_profile": True}
        (path / "run.json").write_text(json.dumps(data), encoding="utf-8")
        # The first daemon start can be slow; retry navigation only. It has
        # no account or knowledge write side effects.
        try:
            browser(path, conf, "goto", "https://ima.qq.com/")
        except SetupError:
            browser(path, conf, "goto", "https://ima.qq.com/")
        return {"status": "succeeded", "run_id": run_id, "run_directory": str(path), "logged_in": False}
    if args.command == "verify":
        return bridge_post(conf, {"action": "verify"})
    if not args.run:
        raise SetupError("login_run_required")
    path, _ = metadata(args.run)
    if args.command == "status":
        if (path / "sealed.json").is_file():
            return {"status": "sealed", "logged_in": False}
        return status(path, conf)
    if args.command == "capture":
        return capture(path, conf, args.run)
    if args.command == "relay-capture":
        if not args.relay_key_file:
            raise SetupError("relay_public_key_file_required")
        return relay_capture(path, conf, args.run, args.relay_key_file)
    browser(path, conf, "stop")
    return {"status": "succeeded", "closed": True}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except SetupError as error:
        print(json.dumps({"status": "unavailable", "message": str(error)}))
        sys.exit(1)
    except Exception:
        print(json.dumps({"status": "unavailable", "message": "ima_login_setup_unavailable"}))
        sys.exit(1)
