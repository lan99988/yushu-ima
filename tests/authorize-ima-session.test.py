import importlib.util
import base64
from contextlib import contextmanager
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ima_authorizer", Path(__file__).resolve().parents[1] / "scripts/authorize-ima-session.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
ROOT = Path(__file__).resolve().parents[1]
SEALER = ROOT / "scripts/seal-ima-session.mjs"
FIELDS = {"installation_id", "issued_at", "key_id", "wrapped_key", "iv", "ciphertext"}
ACCOUNT = {"userId": "synthetic-user", "token": "synthetic-access-secret",
           "refreshToken": "synthetic-refresh-secret"}
DEVICE = {"qua": "synthetic-browser"}


def node(source, value=None):
    flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
    return subprocess.run(["node", "--input-type=module", "-e", source],
                          input=json.dumps(value).encode() if value is not None else None,
                          capture_output=True, timeout=30, **flags)


class RelayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        generated = node("""
            import {generateKeyPairSync, createHash} from 'node:crypto';
            function pair() {
              const {publicKey, privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
              const spki = publicKey.export({type:'spki', format:'der'});
              return {key:{key_id:createHash('sha256').update(spki).digest('hex'),
                public_key_spki:spki.toString('base64'), algorithm:'RSA-OAEP-SHA256+A256GCM'},
                private_key:privateKey.export({type:'pkcs8',format:'der'}).toString('base64')};
            }
            console.log(JSON.stringify({first:pair(), second:pair()}));
        """)
        if generated.returncode:
            raise RuntimeError("synthetic_key_generation_failed")
        cls.keys = json.loads(generated.stdout)

    def seal(self, payload):
        flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
        return subprocess.run(["node", str(SEALER)], input=json.dumps(payload).encode(),
                              capture_output=True, timeout=30, **flags)

    def payload(self):
        return {"key": self.keys["first"]["key"], "installation_id": "a" * 32,
                "account_info": ACCOUNT, "device_info": DEVICE}

    def decrypt(self, envelope, private_key=None):
        result = node("""
            import {privateDecrypt, createDecipheriv, constants} from 'node:crypto';
            let raw=''; for await(const chunk of process.stdin) raw+=chunk;
            const {envelope:e,private_key} = JSON.parse(raw);
            try {
              const aes=privateDecrypt({key:Buffer.from(private_key,'base64'),format:'der',
                type:'pkcs8',padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},
                Buffer.from(e.wrapped_key,'base64'));
              const packed=Buffer.from(e.ciphertext,'base64');
              const d=createDecipheriv('aes-256-gcm',aes,Buffer.from(e.iv,'base64'));
              d.setAAD(Buffer.from(JSON.stringify({installation_id:e.installation_id,
                issued_at:e.issued_at,key_id:e.key_id})));
              d.setAuthTag(packed.subarray(-16));
              const plain=Buffer.concat([d.update(packed.subarray(0,-16)),d.final()]);
              console.log(JSON.stringify({ok:true,value:JSON.parse(plain)}));
            } catch { console.log(JSON.stringify({ok:false})); }
        """, {"envelope": envelope, "private_key": private_key or self.keys["first"]["private_key"]})
        self.assertEqual(result.returncode, 0)
        return json.loads(result.stdout)

    @contextmanager
    def fresh_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            run_id = "a" * 32
            path = root / run_id
            path.mkdir()
            (path / "run.json").write_text(json.dumps({"run_id": run_id, "fresh_profile": True}))
            (path / "browse.json").write_text(json.dumps({"port": 43123, "token": "synthetic-daemon"}))
            key_file = root / "public.json"
            key_file.write_text(json.dumps(self.keys["first"]["key"]))
            def browse(p, conf, *args):
                self.assertEqual(p, path)
                self.assertTrue(conf.get("_existing_browser_only"))
                if args == ("url",): return "https://ima.qq.com/"
                if args == ("stop",):
                    (path / "browse.json").unlink(missing_ok=True)
                    return "stopped"
                if "logged_in:" in args[1]: return '{"logged_in":true}'
                return json.dumps({"account_info": ACCOUNT, "device_info": DEVICE})
            with patch.object(setup, "RUNS", root), \
                 patch.object(setup, "protect") as protect, \
                 patch.object(setup, "browser", side_effect=browse) as browser, \
                 patch.object(setup, "bridge_post", side_effect=AssertionError("no_network")):
                yield path, run_id, key_file, browser, protect

    def test_node_roundtrip_exact_protocol_and_fresh_randomness(self):
        self.assertTrue(SEALER.is_file(), "Node sealing implementation is missing")
        first = self.seal(self.payload())
        self.assertEqual(first.returncode, 0)
        self.assertEqual(first.stderr, b"")
        envelope = json.loads(first.stdout)
        self.assertEqual(set(envelope), FIELDS)
        self.assertEqual(envelope["installation_id"], "a" * 32)
        self.assertEqual(envelope["key_id"], self.keys["first"]["key"]["key_id"])
        self.assertRegex(envelope["issued_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertEqual(len(base64.b64decode(envelope["iv"])), 12)
        self.assertEqual(len(base64.b64decode(envelope["wrapped_key"])), 256)
        self.assertEqual(self.decrypt(envelope), {"ok": True, "value": {
            "account_info": ACCOUNT, "device_info": DEVICE}})
        second = json.loads(self.seal(self.payload()).stdout)
        for field in ("iv", "ciphertext", "wrapped_key"):
            self.assertNotEqual(envelope[field], second[field])
        self.assertNotIn(ACCOUNT["token"].encode(), first.stdout)

    def test_aad_tampering_wrong_key_and_ciphertext_are_rejected(self):
        self.assertTrue(SEALER.is_file(), "Node sealing implementation is missing")
        envelope = json.loads(self.seal(self.payload()).stdout)
        for field, value in (("installation_id", "b" * 32),
                             ("issued_at", "2000-01-01T00:00:00.000Z"),
                             ("key_id", "0" * 64)):
            with self.subTest(field=field):
                self.assertEqual(self.decrypt({**envelope, field: value}), {"ok": False})
        self.assertEqual(self.decrypt(envelope, self.keys["second"]["private_key"]), {"ok": False})
        packed = bytearray(base64.b64decode(envelope["ciphertext"]))
        packed[-1] ^= 1
        self.assertEqual(self.decrypt({**envelope, "ciphertext": base64.b64encode(packed).decode()}), {"ok": False})

    def test_node_invalid_inputs_report_only_generic_errors(self):
        self.assertTrue(SEALER.is_file(), "Node sealing implementation is missing")
        key = self.keys["first"]["key"]
        bad = [None, {**self.payload(), "installation_id": "../profile"},
               {**self.payload(), "account_info": []},
               {**self.payload(), "device_info": None}]
        for changes in ({"key_id": "0" * 64}, {"algorithm": "wrong"},
                        {"public_key_spki": "synthetic-access-secret"}):
            bad.append({**self.payload(), "key": {**key, **changes}})
        for value in bad:
            with self.subTest(value_type=type(value).__name__):
                result = self.seal(value)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(result.stderr, b"ima_session_seal_failed\n")
        flags = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
        result = subprocess.run(["node", str(SEALER)], input=b'{synthetic-access-secret',
                                capture_output=True, timeout=30, **flags)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"ima_session_seal_failed\n")

    def test_python_seals_only_ciphertext_and_stops_only_this_run(self):
        self.assertTrue(hasattr(setup, "relay_capture"), "relay-capture implementation is missing")
        with self.fresh_run() as (path, run_id, key_file, browser, protect):
            result = setup.relay_capture(path, {}, run_id, key_file)
            self.assertEqual(set(result), {"status", "envelope"})
            self.assertEqual(result["status"], "sealed")
            self.assertEqual(set(result["envelope"]), FIELDS)
            self.assertEqual(self.decrypt(result["envelope"])["value"]["account_info"], ACCOUNT)
            self.assertEqual(json.loads((path / "sealed.json").read_text()), result["envelope"])
            protect.assert_called_once_with(path)
            self.assertEqual(browser.call_args_list[-1].args[-1], "stop")
            for text in [json.dumps(result), *[p.read_text() for p in path.rglob("*") if p.is_file()]]:
                for secret in ACCOUNT.values(): self.assertNotIn(secret, text)
            browser.reset_mock()
            self.assertEqual(setup.relay_capture(path, {}, run_id, key_file), result)
            browser.assert_not_called()

    def test_relay_requires_matching_fresh_metadata_and_official_logged_in_page(self):
        self.assertTrue(hasattr(setup, "relay_capture"), "relay-capture implementation is missing")
        for mark in (False, None):
            with self.fresh_run() as (path, run_id, key_file, browser, _):
                (path / "run.json").write_text(json.dumps({"run_id": run_id, "fresh_profile": mark}))
                with self.assertRaises(setup.SetupError): setup.relay_capture(path, {}, run_id, key_file)
                browser.assert_not_called()
        for responses, count in ((["https://attacker.invalid/ima.qq.com"], 1),
                                 (["https://ima.qq.com/", '{"logged_in":false}'], 2)):
            with self.fresh_run() as (path, run_id, key_file, browser, _):
                browser.side_effect = responses
                with self.assertRaises(setup.SetupError): setup.relay_capture(path, {}, run_id, key_file)
                self.assertEqual(browser.call_count, count)
                self.assertFalse((path / "sealed.json").exists())

    def test_node_failure_and_unexpected_output_cannot_escape_or_close_browser(self):
        self.assertTrue(hasattr(setup, "relay_capture"), "relay-capture implementation is missing")
        for output in (json.dumps({"account_info": ACCOUNT}), "synthetic-access-secret"):
            with self.fresh_run() as (path, run_id, key_file, browser, _), \
                 patch.object(setup, "native_run", return_value=output):
                with self.assertRaises(setup.SetupError) as error:
                    setup.relay_capture(path, {}, run_id, key_file)
                self.assertNotIn("synthetic", str(error.exception))
                self.assertFalse((path / "sealed.json").exists())
                self.assertNotEqual(browser.call_args.args[-1], "stop")

    def test_stop_disconnect_with_removed_state_returns_saved_envelope(self):
        with self.fresh_run() as (path, run_id, key_file, browser, _):
            original = browser.side_effect
            def disconnected_stop(p, conf, *args):
                if args == ("stop",):
                    (path / "browse.json").unlink()
                    raise setup.SetupError("fresh_login_browser_unavailable")
                return original(p, conf, *args)
            browser.side_effect = disconnected_stop
            result = setup.relay_capture(path, {}, run_id, key_file)
            self.assertEqual(result["status"], "sealed")
            self.assertTrue((path / "sealed.json").is_file())
            self.assertFalse((path / "browse.json").exists())

    def test_stop_failure_can_retry_saved_ciphertext_without_recapturing(self):
        with self.fresh_run() as (path, run_id, key_file, browser, _):
            original = browser.side_effect
            def fail_stop(p, conf, *args):
                if args == ("stop",): raise setup.SetupError("fresh_login_browser_unavailable")
                return original(p, conf, *args)
            browser.side_effect = fail_stop
            with self.assertRaises(setup.SetupError): setup.relay_capture(path, {}, run_id, key_file)
            self.assertTrue((path / "sealed.json").is_file())
            browser.reset_mock()
            browser.side_effect = original
            with patch.object(setup, "read_capture", side_effect=AssertionError("no_recapture")):
                self.assertEqual(setup.relay_capture(path, {}, run_id, key_file)["status"], "sealed")
            self.assertEqual(browser.call_count, 1)
            self.assertEqual(browser.call_args.args[-1], "stop")

    def test_node_process_failure_does_not_forward_sensitive_diagnostics(self):
        with self.fresh_run() as (path, run_id, key_file, browser, _):
            failed = subprocess.CompletedProcess(["synthetic-node"], 1,
                stdout=b"synthetic-access-secret", stderr=b"synthetic-refresh-secret")
            with patch.object(setup.subprocess, "run", return_value=failed):
                with self.assertRaises(setup.SetupError) as error:
                    setup.relay_capture(path, {}, run_id, key_file)
            self.assertEqual(str(error.exception), "ima_session_seal_failed")
            self.assertFalse((path / "sealed.json").exists())
            self.assertNotEqual(browser.call_args.args[-1], "stop")

    def test_existing_daemon_transport_is_loopback_scoped_and_never_uses_cli(self):
        with self.fresh_run() as (path, _, _, _, _):
            class Response:
                def __enter__(self): return self
                def __exit__(self, *_): pass
                def read(self, _): return b'https://ima.qq.com/'
            class Opener:
                def open(self, req, **_):
                    self.request = req
                    return Response()
            opener = Opener()
            with patch.object(setup.urllib.request, "build_opener", return_value=opener), \
                 patch.object(setup, "native_run", side_effect=AssertionError("no_cli")):
                self.assertEqual(setup.existing_browser(path, "url"), "https://ima.qq.com/")
                self.assertEqual(opener.request.full_url, "http://127.0.0.1:43123/command")
                self.assertEqual(json.loads(opener.request.data), {"command": "url", "args": []})
                self.assertEqual(opener.request.get_header("Authorization"), "Bearer synthetic-daemon")

    def test_missing_existing_daemon_never_invokes_browse_cli(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(setup, "native_run") as native:
            with self.assertRaises(setup.SetupError):
                setup.browser(Path(directory), {"_existing_browser_only": True}, "url")
            native.assert_not_called()

    def test_cli_relay_capture_and_post_seal_status_are_redacted(self):
        self.assertTrue(hasattr(setup, "relay_capture"), "relay-capture implementation is missing")
        with self.fresh_run() as (path, run_id, key_file, browser, _), patch.object(setup, "HOME", path):
            (path / "config.json").write_text('{}')
            argv = ["authorize-ima-session.py", "relay-capture", "--run", run_id,
                    "--relay-key-file", str(key_file)]
            with patch.object(sys, "argv", argv):
                self.assertEqual(setup.main()["status"], "sealed")
            browser.reset_mock()
            with patch.object(sys, "argv", ["authorize-ima-session.py", "status", "--run", run_id]):
                result = setup.main()
            self.assertNotIn("synthetic", json.dumps(result))
            browser.assert_not_called()


class AuthorizerTests(unittest.TestCase):
    def test_an_existing_or_unmarked_browser_run_cannot_be_captured(self):
        with tempfile.TemporaryDirectory() as directory:
            run = 'a' * 32
            path = Path(directory) / run
            path.mkdir()
            with patch.object(setup, "RUNS", Path(directory)):
                with self.assertRaises(setup.SetupError):
                    setup.metadata(run)
                (path / "run.json").write_text(json.dumps({"run_id": run, "fresh_profile": False}))
                with self.assertRaises(setup.SetupError):
                    setup.metadata(run)

    def test_capture_never_reads_storage_when_the_page_is_not_official(self):
        with patch.object(setup, "browser", return_value="https://attacker.invalid/ima.qq.com") as browse:
            with self.assertRaises(setup.SetupError):
                setup.capture(Path("unused"), {}, 'a' * 32)
            self.assertEqual(browse.call_count, 1)

    def test_capture_requires_new_login_before_asking_for_account_data(self):
        with patch.object(setup, "browser", side_effect=['https://ima.qq.com/', '{"logged_in":false}']) as browse:
            with self.assertRaises(setup.SetupError):
                setup.capture(Path("unused"), {}, 'a' * 32)
            self.assertEqual(browse.call_count, 2)

    def test_session_transfer_uses_only_the_selected_private_site_and_filters_its_response(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            cloud = {"IMA_CLOUD_URL": setup.SITE, "IMA_CLOUD_BRIDGE_TOKEN": "synthetic-bridge", "IMA_CLOUD_SERVICE_TOKEN": "synthetic-service"}
            (home / "cloud-client.json").write_text(json.dumps(cloud))
            class Response:
                def __enter__(self): return self
                def __exit__(self, *_): pass
                def read(self, _): return json.dumps({"status": "succeeded", "session": {"state": "received", "move_verified": False, "token": "must-not-escape", "userId": "private-id"}, "raw": "must-not-escape"}).encode()
            class Opener:
                def open(self, request, **_):
                    self.request = request
                    return Response()
            opener = Opener()
            with patch.object(setup, "HOME", home), patch.object(setup.urllib.request, "build_opener", return_value=opener):
                result = setup.bridge_post({}, {"action": "status"})
                self.assertEqual(opener.request.full_url, setup.SITE + "/bridge/v1/session")
                self.assertNotIn("must-not-escape", json.dumps(result))
                self.assertNotIn("private-id", json.dumps(result))
                cloud["IMA_CLOUD_URL"] = "https://attacker.invalid/"
                (home / "cloud-client.json").write_text(json.dumps(cloud))
                with self.assertRaises(setup.SetupError): setup.bridge_post({}, {"action": "status"})

    def test_native_subprocess_failure_does_not_forward_page_credentials_to_errors(self):
        class Failure:
            returncode = 1
            stdout = "sensitive-account-result"
            stderr = "sensitive-upstream-message"
        with patch.object(setup.subprocess, "run", return_value=Failure()):
            with self.assertRaises(setup.SetupError) as error: setup.native_run(["synthetic-browser"])
            self.assertNotIn("sensitive", str(error.exception))

    def test_windows_codepage_output_is_decoded_without_reader_thread_errors(self):
        class Success:
            returncode = 0
            stdout = '已处理'.encode('gbk')
            stderr = b''
        with patch.object(setup.subprocess, 'run', return_value=Success()):
            self.assertIsInstance(setup.native_run(['synthetic-acl-utility']), str)


if __name__ == '__main__':
    unittest.main()
