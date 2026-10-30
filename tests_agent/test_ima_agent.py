import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
import urllib.error
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('ima_agent', ROOT / 'agent/ima_agent.py')
a = importlib.util.module_from_spec(SPEC) if SPEC.loader and (ROOT / 'agent/ima_agent.py').exists() else None
if a:
    SPEC.loader.exec_module(a)


class Response:
    def __init__(self, payload=None, status=200, raw=None):
        self.status = status
        self.raw = raw if raw is not None else json.dumps(payload).encode()
    def read(self, size=-1):
        return self.raw[:size] if size >= 0 else self.raw
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass


class FakeOpener:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []
    def open(self, request, timeout):
        self.calls.append((request, timeout))
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(a, 'adapter implementation is missing')
    def config(self, **env):
        return a.Config.from_env({'IMA_MCP_URL': 'https://example.test/mcp', **env})
    def client(self, *responses, **env):
        opener = FakeOpener(*responses)
        return a.Client(self.config(**env), opener), opener
    def rpc(self, ident=7):
        return {'jsonrpc': '2.0', 'id': ident, 'method': 'tools/call', 'params': {'name': 'arbitrary', 'arguments': {'request_id': 'original', 'text': '中文'}}}
    def test_defaults(self):
        c = self.config()
        self.assertEqual((c.timeout, c.auth_header, c.auth_scheme, c.token), (120, 'OAI-Sites-Authorization', 'Bearer', ''))
    def test_url_validation(self):
        for url in ['http://example.test/mcp', 'https://u:p@example.test/mcp', 'https://x/mcp?q=1', 'https://x/mcp#x', 'https://x/mcp?', 'https://x/mcp#', 'https://x:bad/mcp', 'https://x/\nmcp', 'file:///mcp', '']:
            with self.subTest(url=url), self.assertRaises(a.AdapterError):
                self.config(IMA_MCP_URL=url)
    def test_loopback_http(self):
        for host in ['localhost', '127.0.0.1', '[::1]']:
            self.assertEqual(self.config(IMA_MCP_URL=f'http://{host}:123/mcp').url, f'http://{host}:123/mcp')
    def test_timeout_validation(self):
        for value in ['0', '3601', 'nan', '1.5', '']:
            with self.subTest(value=value), self.assertRaises(a.AdapterError):
                self.config(IMA_CLOUD_TIMEOUT=value)
        self.assertEqual(self.config(IMA_CLOUD_TIMEOUT='3600').timeout, 3600)
    def test_auth_headers(self):
        client, opener = self.client(Response({'jsonrpc':'2.0','id':7,'result': {}}), IMA_CLOUD_SERVICE_TOKEN='fake-secret')
        client.send(self.rpc())
        req, timeout = opener.calls[0]
        headers = {k.lower(): v for k, v in req.header_items()}
        self.assertEqual(headers['oai-sites-authorization'], 'Bearer fake-secret')
        self.assertFalse(any(k.startswith('oai-authenticated') for k in headers))
        self.assertNotIn('fake-secret', req.data.decode())
        self.assertEqual(timeout, 120)
    def test_optional_token(self):
        client, opener = self.client(Response({'jsonrpc':'2.0','id':7,'result': {}}))
        client.send(self.rpc())
        self.assertNotIn('oai-sites-authorization', dict((k.lower(),v) for k,v in opener.calls[0][0].header_items()))
    def test_custom_gateway(self):
        client, opener = self.client(Response({'jsonrpc':'2.0','id':7,'result': {}}), IMA_CLOUD_SERVICE_TOKEN='fake', IMA_MCP_AUTH_HEADER='Authorization', IMA_MCP_AUTH_SCHEME='Token')
        client.send(self.rpc())
        self.assertEqual(opener.calls[0][0].get_header('Authorization'), 'Token fake')
    def test_forbidden_headers(self):
        for header in ['Host', 'Cookie', 'oai-authenticated-user-id', 'OAI-Authenticated-User-Email', 'X\r\nBad', 'Content-Length', 'Proxy-Authorization', 'Connection', 'Accept', 'Content-Type']:
            with self.subTest(header=header), self.assertRaises(a.AdapterError):
                self.config(IMA_MCP_AUTH_HEADER=header)
    def test_invalid_auth_values(self):
        for env in [{'IMA_CLOUD_SERVICE_TOKEN': 'bad\r\nx'}, {'IMA_MCP_AUTH_SCHEME': 'Bearer\nx'}, {'IMA_MCP_AUTH_SCHEME': ''}]:
            with self.assertRaises(a.AdapterError):
                self.config(**env)
    def test_payload_exact(self):
        rpc = self.rpc()
        client, opener = self.client(Response({'jsonrpc':'2.0', 'id':7, 'result':{}}))
        client.send(rpc)
        self.assertEqual(json.loads(opener.calls[0][0].data), rpc)
    def test_server_error_unchanged(self):
        reply = {'jsonrpc':'2.0', 'id':7, 'error':{'code':-32001, 'message':'server error', 'data':{'x':1}}}
        client, _ = self.client(Response(reply))
        self.assertEqual(client.send(self.rpc()), reply)
    def test_timeout_no_retry(self):
        client, opener = self.client(TimeoutError('fake-secret'), IMA_CLOUD_SERVICE_TOKEN='fake-secret')
        with self.assertRaises(a.AdapterError) as cm:
            client.send(self.rpc())
        self.assertEqual(cm.exception.kind, 'transport_error')
        self.assertNotIn('fake-secret', str(cm.exception))
        self.assertEqual(len(opener.calls), 1)
    def test_http_body_never_leaks(self):
        error = urllib.error.HTTPError('https://fake-secret/', 403, 'fake-secret', {}, io.BytesIO(b'fake-secret and other-credential'))
        client, _ = self.client(error, IMA_CLOUD_SERVICE_TOKEN='fake-secret')
        with self.assertRaises(a.AdapterError) as cm:
            client.send(self.rpc())
        self.assertEqual(cm.exception.kind, 'http_error')
        self.assertEqual(cm.exception.status, 403)
        self.assertNotIn('secret', str(cm.exception))
        self.assertNotIn('credential', str(cm.exception))
    def test_redirect_handler_rejects(self):
        with self.assertRaises(urllib.error.HTTPError):
            a.NoRedirect().redirect_request(None, None, 302, 'redirect', {}, 'https://other.test/')
    def test_redirect_is_error(self):
        client, opener = self.client(Response({}, status=302))
        with self.assertRaises(a.AdapterError):
            client.send(self.rpc())
        self.assertEqual(len(opener.calls), 1)
    def run_stdio(self, data, *responses):
        client, opener = self.client(*responses)
        out = io.StringIO()
        a.serve_stdio(client, io.StringIO(data), out)
        return [json.loads(line) for line in out.getvalue().splitlines()], opener
    def test_stdio_response_and_eof(self):
        reply = {'jsonrpc':'2.0','id':7,'result':{'x':1}}
        output, _ = self.run_stdio(json.dumps(self.rpc())+'\n', Response(reply))
        self.assertEqual(output, [reply])
    def test_notification_no_response(self):
        rpc = {'jsonrpc':'2.0','method':'notifications/initialized'}
        output, opener = self.run_stdio(json.dumps(rpc)+'\n', Response(status=202, raw=b''))
        self.assertEqual(output, [])
        self.assertEqual(len(opener.calls), 1)
    def test_notification_response_ignored(self):
        output, _ = self.run_stdio('{"jsonrpc":"2.0","method":"notify"}\n', Response({'oops':1}))
        self.assertEqual(output, [])
    def test_invalid_json_then_continue(self):
        output, _ = self.run_stdio('bad\n'+json.dumps(self.rpc())+'\n', Response({'jsonrpc':'2.0','id':7,'result':{}}))
        self.assertEqual(output[0]['error']['code'], -32700)
        self.assertEqual(output[1]['id'], 7)
    def test_invalid_ids(self):
        for ident in [True, [], {}, 1.2]:
            output, opener = self.run_stdio(json.dumps(self.rpc(ident))+'\n')
            self.assertEqual(output[0]['error']['code'], -32600)
            self.assertEqual(len(opener.calls), 0)
    def test_null_and_string_ids(self):
        for ident in [None, 'abc']:
            reply = {'jsonrpc':'2.0','id':ident,'result':{}}
            output, _ = self.run_stdio(json.dumps(self.rpc(ident))+'\n', Response(reply))
            self.assertEqual(output, [reply])
    def test_large_line_drained(self):
        output, opener = self.run_stdio('x'*(a.MAX_BYTES+1)+'\n'+json.dumps(self.rpc())+'\n', Response({'jsonrpc':'2.0','id':7,'result':{}}))
        self.assertEqual(output[0]['error']['data']['kind'], 'input_too_large')
        self.assertEqual(len(opener.calls), 1)
    def test_transport_error_preserves_host_request(self):
        rpc = self.rpc('same-id')
        original = json.loads(json.dumps(rpc))
        client, opener = self.client(TimeoutError())
        out = io.StringIO()
        a.serve_stdio(client, io.StringIO(json.dumps(rpc)+'\n'), out)
        reply = json.loads(out.getvalue())
        self.assertEqual(reply['id'], 'same-id')
        self.assertEqual(reply['error']['data']['kind'], 'transport_error')
        self.assertTrue(reply['error']['data']['reconcile_required'])
        self.assertEqual(rpc, original)
        self.assertEqual(json.loads(opener.calls[0][0].data), original)
    def test_empty_response_to_request_is_failure(self):
        client, _ = self.client(Response(status=202, raw=b''))
        with self.assertRaises(a.AdapterError):
            client.send(self.rpc())
    def test_doctor_only_read_operations(self):
        policy = {'enabled':True, 'acceptance_valid':True, 'proof':'long secret proof'}
        client, opener = self.client(Response({'jsonrpc':'2.0','id':1,'result':{'serverInfo':{'version':'2.5.2'}}}), Response({'jsonrpc':'2.0','id':2,'result':{'tools':[{'name':'ima_knowledge_consolidate'}]}}), Response({'jsonrpc':'2.0','id':3,'result':{'content':[{'type':'text','text':json.dumps(policy)}]}}))
        report = a.doctor(client)
        self.assertEqual(report, {'enabled':True,'acceptance_valid':True,'tool_count':1,'server_version':'2.5.2'})
        calls = [json.loads(req.data) for req,_ in opener.calls]
        self.assertEqual([v['method'] for v in calls], ['initialize','tools/list','tools/call'])
        self.assertEqual(calls[-1]['params'], {'name':'ima_knowledge_policy','arguments':{}})
        self.assertNotIn('proof', json.dumps(report))
    def test_doctor_failure_not_success(self):
        client, _ = self.client(Response({'jsonrpc':'2.0','id':1,'error':{'code':-1,'message':'private'}}))
        with self.assertRaises(a.AdapterError):
            a.doctor(client)
    def test_cli_args_file_exact_pending_preserved(self):
        args = {'request_id':'keep-original','nested':{'values':[1,False,None,'中文']}}
        result = {'isError':True,'content':[{'type':'text','text':'{"status":"verification_pending"}'}]}
        client, opener = self.client(Response({'jsonrpc':'2.0','id':1,'result':result}))
        with tempfile.TemporaryDirectory(dir=ROOT/'tests_agent') as folder:
            path = pathlib.Path(folder)/'args.json'
            path.write_text(json.dumps(args), encoding='utf-8')
            out = io.StringIO()
            status = a.main(['call','some_tool','--args-file',str(path)], client=client, stdout=out)
        self.assertEqual(status, 2)
        self.assertEqual(json.loads(out.getvalue())['result'], result)
        self.assertEqual(json.loads(opener.calls[0][0].data)['params'], {'name':'some_tool','arguments':args})
    def test_cli_stdin_args_and_tools(self):
        client, opener = self.client(Response({'jsonrpc':'2.0','id':1,'result':{}}), Response({'jsonrpc':'2.0','id':1,'result':{'tools':[]}}))
        out = io.StringIO()
        self.assertEqual(a.main(['call','anything','--args-file','-'], client=client, stdin=io.StringIO('{"x":1}'), stdout=out), 0)
        self.assertEqual(a.main(['tools'], client=client, stdout=io.StringIO()), 0)
        self.assertEqual(json.loads(opener.calls[0][0].data)['params']['arguments'], {'x':1})
        self.assertEqual(json.loads(opener.calls[1][0].data)['method'], 'tools/list')

    def test_http_connection_failure_is_json_error(self):
        import http.client
        client, opener = self.client(http.client.IncompleteRead(b'fake-secret'))
        out = io.StringIO()
        status = a.main(['tools'], client=client, stdout=out)
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(out.getvalue())['error']['data']['kind'], 'transport_error')
        self.assertNotIn('fake-secret', out.getvalue())
        self.assertEqual(len(opener.calls), 1)

    def test_cli_bad_args_do_not_send(self):
        for raw in ['[]', 'null', '{"x":NaN}', '{bad', 'x'*(a.MAX_BYTES+1)]:
            client, opener = self.client()
            out = io.StringIO()
            self.assertEqual(a.main(['call','arbitrary','--args-file','-'], client=client, stdin=io.StringIO(raw), stdout=out), 1)
            self.assertEqual(json.loads(out.getvalue())['error']['data']['kind'], 'invalid_arguments')
            self.assertEqual(opener.calls, [])

    def test_stdio_bad_requests(self):
        for value in [[], None, {}, {'jsonrpc':'2.0','id':1,'method':'x','params':False}]:
            output, opener = self.run_stdio(json.dumps(value)+'\n')
            self.assertEqual(output[0]['error']['code'], -32600)
            self.assertEqual(opener.calls, [])

    def test_response_limit(self):
        client, _ = self.client(Response(raw=b'x'*(a.MAX_BYTES+1)))
        with self.assertRaises(a.AdapterError) as cm:
            client.send(self.rpc())
        self.assertEqual(cm.exception.kind, 'response_too_large')

    def test_stdio_secret_error_and_notification_failure(self):
        client, opener = self.client(urllib.error.URLError('fake-secret'), TimeoutError('fake-secret'))
        out = io.StringIO()
        source = io.StringIO('{"jsonrpc":"2.0","method":"notify"}\n'+json.dumps(self.rpc())+'\n')
        a.serve_stdio(client, source, out)
        self.assertEqual(len(out.getvalue().splitlines()), 1)
        self.assertNotIn('fake-secret', out.getvalue())
        self.assertEqual(len(opener.calls), 2)

    def test_doctor_missing_policy_is_failure(self):
        client, _ = self.client(Response({'jsonrpc':'2.0','id':1,'result':{'serverInfo':{'version':'2.5.2'}}}), Response({'jsonrpc':'2.0','id':2,'result':{'tools':[]}}), Response({'jsonrpc':'2.0','id':3,'result':{'content':[]}}))
        with self.assertRaises(a.AdapterError):
            a.doctor(client)

    def test_doctor_real_policy_runtime_shape(self):
        policy = {'status':'succeeded','policy':{'long':'policy text'},'runtime':{'consolidation':{'implemented':True,'enabled':False,'acceptance_valid':False,'isolated_acceptance':{'long':'proof'}}}}
        client, _ = self.client(Response({'jsonrpc':'2.0','id':1,'result':{'serverInfo':{'version':'2.5.2'}}}), Response({'jsonrpc':'2.0','id':2,'result':{'tools':[{'name':'ima_knowledge_consolidate'}]}}), Response({'jsonrpc':'2.0','id':3,'result':{'isError':False,'content':[{'type':'text','text':json.dumps(policy)}]}}))
        self.assertEqual(a.doctor(client), {'enabled':False,'acceptance_valid':False,'tool_count':1,'server_version':'2.5.2'})

    def bridge_env(self, **extra):
        return {'IMA_MCP_URL':'https://example.test/bridge/v1/mcp', 'IMA_CLOUD_BRIDGE_TOKEN':'fake-bridge-secret', **extra}

    def test_bridge_two_auth_layers_exact_payload(self):
        reply = {'jsonrpc':'2.0','id':7,'result':{}}
        client, opener = self.client(Response(reply), **self.bridge_env(IMA_CLOUD_SERVICE_TOKEN='fake-service-secret'))
        original = self.rpc()
        self.assertEqual(client.send(original), reply)
        request = opener.calls[0][0]
        headers = {k.lower():v for k,v in request.header_items()}
        self.assertEqual(headers['x-ima-bridge-token'], 'fake-bridge-secret')
        self.assertEqual(headers['oai-sites-authorization'], 'Bearer fake-service-secret')
        self.assertFalse(any(k.startswith('oai-authenticated') for k in headers))
        self.assertEqual(json.loads(request.data), original)
        self.assertEqual(request.full_url, 'https://example.test/bridge/v1/mcp')
        self.assertEqual(len(opener.calls), 1)

    def test_bridge_token_without_outer_service_token(self):
        client, opener = self.client(Response({'jsonrpc':'2.0','id':7,'result':{}}), **self.bridge_env())
        client.send(self.rpc())
        headers = {k.lower():v for k,v in opener.calls[0][0].header_items()}
        self.assertEqual(headers['x-ima-bridge-token'], 'fake-bridge-secret')
        self.assertNotIn('oai-sites-authorization', headers)

    def test_bridge_requires_token(self):
        for token in ['', None]:
            env = {'IMA_MCP_URL':'https://example.test/bridge/v1/mcp'}
            if token is not None:
                env['IMA_CLOUD_BRIDGE_TOKEN'] = token
            with self.subTest(token=token), self.assertRaises(a.AdapterError):
                self.config(**env)

    def test_bridge_token_restricted_to_exact_path(self):
        for path in ['/mcp', '/bridge/v1/mcp/', '/bridge/v1/%6dcp', '/bridge/v1/mcp/..', '/other', '']:
            with self.subTest(path=path):
                with self.assertRaises(a.AdapterError) as cm:
                    self.config(**self.bridge_env(IMA_MCP_URL='https://example.test'+path))
                self.assertEqual(cm.exception.kind, 'configuration_error')
                self.assertNotIn('fake-bridge-secret', str(cm.exception))

    def test_bridge_header_cannot_be_service_auth_override(self):
        for name in ['X-IMA-Bridge-Token', 'x-ima-bridge-token']:
            with self.assertRaises(a.AdapterError):
                self.config(IMA_MCP_AUTH_HEADER=name, IMA_CLOUD_SERVICE_TOKEN='fake')

    def test_bridge_invalid_token_characters(self):
        for token in ['bad\r\nsecret', 'bad secret', '非ASCII', '\x00secret']:
            with self.assertRaises(a.AdapterError):
                self.config(**self.bridge_env(IMA_CLOUD_BRIDGE_TOKEN=token))

    def test_bridge_errors_do_not_echo_tokens(self):
        for error in [urllib.error.URLError('fake-bridge-secret fake-service-secret'), urllib.error.HTTPError('https://fake-bridge-secret/',401,'fake-service-secret',{},io.BytesIO(b'fake-bridge-secret fake-service-secret'))]:
            client, opener = self.client(error, **self.bridge_env(IMA_CLOUD_SERVICE_TOKEN='fake-service-secret'))
            out = io.StringIO()
            self.assertEqual(a.main(['tools'], client=client, stdout=out), 1)
            self.assertNotIn('fake-bridge-secret', out.getvalue())
            self.assertNotIn('fake-service-secret', out.getvalue())
            json.loads(out.getvalue())
            self.assertEqual(len(opener.calls), 1)

    def test_bridge_invalid_payload_does_not_echo_token(self):
        client, opener = self.client(**self.bridge_env())
        with self.assertRaises(a.AdapterError) as cm:
            client.send({'jsonrpc':'2.0','id':1,'method':'test','params':{'fake-bridge-secret':object()}})
        self.assertNotIn('fake-bridge-secret', str(cm.exception))
        out = io.StringIO()
        self.assertEqual(a.main(['call','test','--args-file','-'], client=client, stdin=io.StringIO('{"fake-bridge-secret":bad}'), stdout=out), 1)
        self.assertNotIn('fake-bridge-secret', out.getvalue())
        self.assertEqual(opener.calls, [])

    def test_bridge_config_failure_is_json_without_secret(self):
        with patch.dict('os.environ', self.bridge_env(IMA_MCP_URL='https://example.test/mcp'), clear=True), patch.object(a.urllib.request, 'build_opener', return_value=FakeOpener()):
            out = io.StringIO()
            self.assertEqual(a.main(['tools'], stdout=out), 1)
        self.assertEqual(json.loads(out.getvalue())['error']['data']['kind'], 'configuration_error')
        self.assertNotIn('fake-bridge-secret', out.getvalue())

    def test_rpc_response_requires_matching_version_and_id(self):
        for reply in [
            {'id':7,'result':{}}, {'jsonrpc':'1.0','id':7,'result':{}},
            {'jsonrpc':'2.0','result':{}}, {'jsonrpc':'2.0','id':8,'result':{}},
            {'jsonrpc':'2.0','id':'7','result':{}}, {'jsonrpc':'2.0','id':7.0,'result':{}},
            {'jsonrpc':'2.0','id':None,'error':{'code':-1,'message':'bad'}},
        ]:
            with self.subTest(reply=reply):
                client, opener = self.client(Response(reply))
                with self.assertRaises(a.AdapterError) as cm:
                    client.send(self.rpc())
                self.assertEqual(cm.exception.kind, 'invalid_response')
                self.assertEqual(len(opener.calls), 1)

    def test_rpc_boolean_id_does_not_match_integer(self):
        client, _ = self.client(Response({'jsonrpc':'2.0','id':True,'result':{}}))
        with self.assertRaises(a.AdapterError):
            client.send(self.rpc(1))

    def test_rpc_missing_id_does_not_match_null(self):
        client, _ = self.client(Response({'jsonrpc':'2.0','result':{}}))
        with self.assertRaises(a.AdapterError):
            client.send(self.rpc(None))

    def test_rpc_invalid_response_uses_original_stdio_id(self):
        output, opener = self.run_stdio(json.dumps(self.rpc('original'))+'\n', Response({'jsonrpc':'2.0','id':'wrong','result':{}}))
        self.assertEqual(output[0]['id'], 'original')
        self.assertEqual(output[0]['error']['data']['kind'], 'invalid_response')
        self.assertEqual(len(opener.calls), 1)


if __name__ == '__main__':
    unittest.main()
