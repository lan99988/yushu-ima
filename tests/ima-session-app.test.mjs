import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../worker/app.js';
import {runtime} from './fixtures/runtime.mjs';

const owner={'oai-authenticated-user-id':'owner'};
const bridge={'x-ima-bridge-token':'bridge-test','content-type':'application/json'};
function env(){return {...runtime(),IMA_SESSION_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')};}
function req(path,options={}){return new Request('https://site.test'+path,options);}

test('native connection status is owner-only and says missing before fresh authorization',async()=>{
 const e=env();
 assert.equal((await app.fetch(req('/api/ima-session/status'),e)).status,401);
 const response=await app.fetch(req('/api/ima-session/status',{headers:owner}),e);
 assert.equal(response.status,200);
 const d=await response.json();
 assert.equal(d.session.state,'missing');
 assert.equal(d.session.move_verified,false);
 assert.equal(d.session.reauthorization_required,true);
 e.close();
});

test('web callers cannot inject credentials, even with owner identity',async()=>{
 const e=env();
 const r=await app.fetch(req('/api/ima-session/install',{method:'POST',headers:{...owner,'content-type':'application/json'},body:JSON.stringify({token:'do-not-save'})}),e);
 assert.equal(r.status,404);
 const rows=e.DB.prepare("SELECT payload FROM documents WHERE collection='private_ima_sessions'");
 assert.equal((await rows.all()).results.length,0);
 e.close();
});

test('trusted installer stores a fresh session but does not claim verified movement',async()=>{
 const e=env(),account_info={userId:'fresh-user',token:'fresh-access-secret',refreshToken:'fresh-refresh-secret',tokenExpiredTime:Date.now()+3600000,refreshTokenExpiredTime:Date.now()+86400000,tokenType:14,idType:2};
 const r=await app.fetch(req('/bridge/v1/session',{method:'POST',headers:bridge,body:JSON.stringify({action:'install',installation_id:'synthetic-installation-0001',account_info,device_info:{qua:'test-browser'}})}),e);
 assert.equal(r.status,200);const d=await r.json();
 assert.equal(d.status,'succeeded');assert.equal(d.session.move_verified,false);
 const output=JSON.stringify(d);assert.ok(!output.includes(account_info.token));assert.ok(!output.includes(account_info.refreshToken));assert.ok(!output.includes(account_info.userId));
 const db=JSON.stringify((await e.DB.prepare('SELECT payload FROM documents').all()).results);
 assert.ok(!db.includes(account_info.token));assert.ok(!db.includes(account_info.refreshToken));assert.ok(!db.includes(account_info.userId));
 e.close();
});

test('revoke rejects cross-origin calls and removes the stored session for its owner',async()=>{
 const e=env();
 await app.fetch(req('/bridge/v1/session',{method:'POST',headers:bridge,body:JSON.stringify({action:'install',installation_id:'synthetic-installation-0001',account_info:{userId:'u',token:'a',refreshToken:'r',tokenExpiredTime:Date.now()+300000}})}),e);
 const cross=await app.fetch(req('/api/ima-session/revoke',{method:'POST',headers:{...owner,origin:'https://attacker.invalid'}}),e);
 assert.equal(cross.status,403);
 const own=await app.fetch(req('/api/ima-session/revoke',{method:'POST',headers:{...owner,origin:'https://site.test'}}),e);
 assert.equal((await own.json()).session.state,'missing');e.close();
});

test('MCP exposes only sanitized session status, never an install or raw credential tool',async()=>{
 const e=env();const call=async(method,params={})=>(await (await app.fetch(req('/mcp',{method:'POST',headers:{...owner,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),e)).json()).result;
 const names=(await call('tools/list')).tools.map(t=>t.name);
 assert.ok(names.includes('ima_connection_status'));
 assert.ok(names.includes('ima_begin_connection'));
 assert.ok(names.includes('ima_finish_connection'));
 assert.ok(names.includes('ima_verify_connection'));
 assert.ok(!names.some(n=>/session_install|session_export|raw_move/.test(n)));
 const result=await call('tools/call',{name:'ima_connection_status',arguments:{}});
 assert.equal(JSON.parse(result.content[0].text).session.move_verified,false);e.close();
});

test('MCP authorization refuses plaintext fields before any session installation',async()=>{
 const e=env();
 const response=await app.fetch(req('/mcp',{method:'POST',headers:{...owner,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ima_finish_connection',arguments:{account_info:{token:'not-allowed-plaintext'}}}})}),e);
 const d=await response.json();assert.equal(d.result.isError,true);assert.ok(!JSON.stringify(d).includes('not-allowed-plaintext'));
 assert.equal((await e.DB.prepare("SELECT * FROM documents WHERE collection='private_ima_sessions'").all()).results.length,0);e.close();
});
