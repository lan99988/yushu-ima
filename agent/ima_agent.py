#!/usr/bin/env python3
"""Dependency-free Python 3.11+ JSON-RPC bridge. Never retries requests.

Use stdio for MCP hosts; CLI call/tools emit the complete remote RPC envelope.
Exit codes: 0 success, 1 configuration/transport/input failure, 2 remote RPC
error or tools/call isError (including verification_pending; reconcile in host).
The host must retain original tool arguments/request numbers for reconciliation.

Recommended IMA_MCP_URL: https://your-server.example/bridge/v1/mcp.
That exact path requires IMA_CLOUD_BRIDGE_TOKEN (X-IMA-Bridge-Token header);
the bridge token is forbidden on all other paths. IMA_CLOUD_SERVICE_TOKEN is
optional outer gateway authentication (OAI-Sites-Authorization: Bearer TOKEN).
For an OAuth gateway /mcp, configure legitimate Authorization via
IMA_MCP_AUTH_HEADER/IMA_MCP_AUTH_SCHEME; owner identity headers are forbidden.
URLs and tool arguments are never rewritten. Responses must have jsonrpc=2.0
and the same id value and type as the request. Notifications produce no output.
"""

import argparse
import http.client
import ipaddress
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_BYTES = 4 * 1024 * 1024
TOKEN = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+\Z")


class AdapterError(Exception):
    def __init__(self, kind, message, status=None):
        super().__init__(message)
        self.kind = kind
        self.status = status

    def data(self):
        result = {'kind': self.kind}
        if self.status is not None:
            result['http_status'] = self.status
        if self.kind in ('transport_error', 'http_error', 'invalid_response', 'response_too_large'):
            result['reconcile_required'] = True
            result['retry_performed'] = False
        return result


class Config:
    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        c = cls()
        c.url = env.get('IMA_MCP_URL', '')
        try:
            if not c.url or any(ord(ch) <= 32 or ord(ch) == 127 for ch in c.url):
                raise ValueError()
            url = urllib.parse.urlsplit(c.url)
            host = url.hostname
            url.port  # Validate port without echoing the supplied URL.
            if not host or url.username is not None or url.password is not None or '?' in c.url or '#' in c.url or '\\' in c.url:
                raise ValueError()
            loopback = host.lower() == 'localhost'
            try:
                loopback = loopback or ipaddress.ip_address(host).is_loopback
            except ValueError:
                pass
            if url.scheme != 'https' and not (url.scheme == 'http' and loopback):
                raise ValueError()
        except (ValueError, TypeError):
            raise AdapterError('configuration_error', 'IMA_MCP_URL must be HTTPS (HTTP loopback only), without credentials, query or fragment.') from None
        try:
            c.timeout = int(env.get('IMA_CLOUD_TIMEOUT', '120'))
            if not 1 <= c.timeout <= 3600:
                raise ValueError()
        except (ValueError, TypeError):
            raise AdapterError('configuration_error', 'IMA_CLOUD_TIMEOUT must be an integer from 1 to 3600.') from None
        c.token = env.get('IMA_CLOUD_SERVICE_TOKEN', '')
        c.bridge_token = env.get('IMA_CLOUD_BRIDGE_TOKEN', '')
        if bool(c.bridge_token) != (url.path == '/bridge/v1/mcp'):
            raise AdapterError('configuration_error', 'IMA_CLOUD_BRIDGE_TOKEN is required only for the exact /bridge/v1/mcp path and forbidden on other paths.')
        c.auth_header = env.get('IMA_MCP_AUTH_HEADER', 'OAI-Sites-Authorization')
        c.auth_scheme = env.get('IMA_MCP_AUTH_SCHEME', 'Bearer')
        header = c.auth_header.lower()
        forbidden = {'host', 'cookie', 'cookie2', 'set-cookie', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect', 'proxy-authorization', 'proxy-connection', 'x-ima-bridge-token'}
        if not TOKEN.fullmatch(c.auth_header) or header in forbidden or header.startswith(('proxy-', 'sec-')) or (header.startswith('oai-') and header != 'oai-sites-authorization'):
            raise AdapterError('configuration_error', 'IMA_MCP_AUTH_HEADER is not an allowed authentication header.')
        if not TOKEN.fullmatch(c.auth_scheme) or any(ord(ch) < 33 or ord(ch) > 126 for token in (c.token, c.bridge_token) for ch in token):
            raise AdapterError('configuration_error', 'Invalid authentication scheme or token characters.')
        return c


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError('', code, 'Redirect refused', {}, None)


def parse_json(raw):
    def invalid_constant(value):
        raise ValueError('Non-JSON numeric constant')
    return json.loads(raw, parse_constant=invalid_constant)


class Client:
    def __init__(self, config, opener=None):
        self.config = config
        self.opener = opener if opener is not None else urllib.request.build_opener(NoRedirect())

    def send(self, payload):
        try:
            raw = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
        except (ValueError, TypeError, UnicodeError):
            raise AdapterError('invalid_request', 'Request must contain valid JSON.') from None
        if len(raw) > MAX_BYTES:
            raise AdapterError('input_too_large', 'Request exceeds 4 MiB.')
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
        if self.config.token:
            headers[self.config.auth_header] = self.config.auth_scheme + ' ' + self.config.token
        if self.config.bridge_token:
            headers['X-IMA-Bridge-Token'] = self.config.bridge_token
        req = urllib.request.Request(self.config.url, data=raw, headers=headers, method='POST')
        try:
            with self.opener.open(req, timeout=self.config.timeout) as response:
                if not 200 <= response.status < 300:
                    raise AdapterError('http_error', 'Remote HTTP request failed.', response.status)
                body = response.read(MAX_BYTES + 1)
        except urllib.error.HTTPError as error:
            # Never read or include the response body, URL, reason or headers.
            status = error.code
            error.close()
            raise AdapterError('http_error', 'Remote HTTP request failed.', status) from None
        except (OSError, urllib.error.URLError, ValueError, http.client.HTTPException):
            raise AdapterError('transport_error', 'Transport failed; retain original arguments and reconcile without resending.') from None
        if 'id' not in payload:
            return None
        if len(body) > MAX_BYTES:
            raise AdapterError('response_too_large', 'Remote response exceeds 4 MiB; reconcile in host.')
        try:
            result = parse_json(body)
            if not isinstance(result, dict) or not ('result' in result or 'error' in result):
                raise ValueError()
            if result.get('jsonrpc') != '2.0' or 'id' not in result:
                raise ValueError()
            if type(result['id']) is not type(payload['id']) or result['id'] != payload['id']:
                raise ValueError()
            return result
        except (ValueError, UnicodeError, RecursionError):
            raise AdapterError('invalid_response', 'Remote response is missing or invalid; reconcile in host.') from None


def error_reply(ident, error, code=-32098):
    return {'jsonrpc': '2.0', 'id': ident, 'error': {'code': code, 'message': str(error), 'data': error.data()}}


def emit(out, value):
    out.write(json.dumps(value, ensure_ascii=True, allow_nan=False) + '\n')
    out.flush()


def validate_request(value):
    if not isinstance(value, dict) or value.get('jsonrpc') != '2.0' or not isinstance(value.get('method'), str) or not value['method']:
        return False
    if 'params' in value and not isinstance(value['params'], (dict, list)):
        return False
    if 'id' in value and value['id'] is not None and (isinstance(value['id'], bool) or not isinstance(value['id'], (str, int))):
        return False
    return True


def serve_stdio(client, source, out):
    while True:
        line = source.readline(MAX_BYTES + 2)
        if not line:
            return
        if len(line) > MAX_BYTES or len(line.encode('utf-8', errors='replace')) > MAX_BYTES:
            while line and not line.endswith('\n'):
                line = source.readline(MAX_BYTES + 2)
            emit(out, error_reply(None, AdapterError('input_too_large', 'Input exceeds 4 MiB.'), -32600))
            continue
        try:
            request = parse_json(line)
        except (ValueError, UnicodeError, RecursionError):
            emit(out, error_reply(None, AdapterError('parse_error', 'Invalid JSON.'), -32700))
            continue
        if not validate_request(request):
            emit(out, error_reply(None, AdapterError('invalid_request', 'Invalid JSON-RPC request.'), -32600))
            continue
        try:
            response = client.send(request)
        except AdapterError as error:
            response = error_reply(request.get('id'), error)
        if 'id' in request:
            emit(out, response)


def rpc(method, params=None, ident=1):
    result = {'jsonrpc': '2.0', 'id': ident, 'method': method}
    if params is not None:
        result['params'] = params
    return result


def successful_result(reply):
    result = reply.get('result')
    if 'error' in reply or not isinstance(result, dict) or result.get('isError'):
        raise AdapterError('remote_error', 'Remote read-only diagnostic failed.')
    return result


def doctor(client):
    initialized = successful_result(client.send(rpc('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'ima-agent', 'version': '1.0.0'}}, 1)))
    listed = successful_result(client.send(rpc('tools/list', ident=2)))
    tools = listed.get('tools')
    if not isinstance(tools, list):
        raise AdapterError('invalid_response', 'Invalid tool inventory.')
    count = len(tools)
    seen = set()
    while listed.get('nextCursor'):
        cursor = listed['nextCursor']
        if not isinstance(cursor, str) or cursor in seen or len(seen) >= 100:
            raise AdapterError('invalid_response', 'Invalid tool inventory pagination.')
        seen.add(cursor)
        listed = successful_result(client.send(rpc('tools/list', {'cursor': cursor}, 2)))
        if not isinstance(listed.get('tools'), list):
            raise AdapterError('invalid_response', 'Invalid tool inventory.')
        count += len(listed['tools'])
    result = successful_result(client.send(rpc('tools/call', {'name': 'ima_knowledge_policy', 'arguments': {}}, 3)))
    policy = result.get('structuredContent')
    if not isinstance(policy, dict):
        policy = None
        for block in result.get('content', []):
            if isinstance(block, dict) and block.get('type') == 'text':
                try:
                    candidate = parse_json(block.get('text', ''))
                    if isinstance(candidate, dict):
                        policy = candidate
                        break
                except (ValueError, TypeError, RecursionError):
                    pass
    if isinstance(policy, dict) and isinstance(policy.get('runtime'), dict):
        policy = policy['runtime'].get('consolidation')
    if not isinstance(policy, dict) or not isinstance(policy.get('enabled'), bool) or not isinstance(policy.get('acceptance_valid'), bool):
        raise AdapterError('invalid_response', 'Policy response lacks boolean enabled/acceptance_valid fields.')
    version = initialized.get('serverInfo', {}).get('version')
    if not isinstance(version, str):
        raise AdapterError('invalid_response', 'Server version is missing.')
    return {'enabled': policy['enabled'], 'acceptance_valid': policy['acceptance_valid'], 'tool_count': count, 'server_version': version}


def main(argv=None, *, client=None, stdin=None, stdout=None):
    source = sys.stdin if stdin is None else stdin
    out = sys.stdout if stdout is None else stdout
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('stdio', 'doctor', 'tools'):
        sub.add_parser(name)
    call = sub.add_parser('call')
    call.add_argument('tool')
    call.add_argument('--args-file', required=True, help='UTF-8 JSON object file, or - for stdin')
    options = parser.parse_args(argv)
    try:
        client = Client(Config.from_env()) if client is None else client
        if options.command == 'stdio':
            serve_stdio(client, source, out)
            return 0
        if options.command == 'doctor':
            emit(out, doctor(client))
            return 0
        if options.command == 'tools':
            request = rpc('tools/list')
        else:
            try:
                if options.args_file == '-':
                    raw = source.read(MAX_BYTES + 1)
                else:
                    with open(options.args_file, 'r', encoding='utf-8') as handle:
                        raw = handle.read(MAX_BYTES + 1)
                if len(raw.encode('utf-8')) > MAX_BYTES:
                    raise ValueError()
                arguments = parse_json(raw)
                if not isinstance(arguments, dict):
                    raise ValueError()
            except (OSError, ValueError, UnicodeError, RecursionError):
                raise AdapterError('invalid_arguments', 'Arguments must be a UTF-8 JSON object of at most 4 MiB.') from None
            request = rpc('tools/call', {'name': options.tool, 'arguments': arguments})
        reply = client.send(request)
        emit(out, reply)
        result = reply.get('result')
        return 2 if 'error' in reply or (isinstance(result, dict) and result.get('isError') is True) else 0
    except AdapterError as error:
        emit(out, error_reply(None, error))
        return 1


if __name__ == '__main__':
    # MCP line framing and args-file stdin are UTF-8 on Windows as well.
    sys.stdin.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
