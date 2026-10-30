import test from 'node:test';import assert from 'node:assert/strict';
import app,{context} from '../worker/app.js';import {runtime} from './fixtures/runtime.mjs';
async function rpc(env,method,params={},auth=true){const r=await app.fetch(new Request('https://site.test/mcp',{method:'POST',headers:{'content-type':'application/json',...(auth?{'oai-authenticated-user-id':'owner'}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),env);return {r,b:await r.json()};}
test('v2 tool discovery exposes retained reads, stable writes, cloud cards and recoverable deletion',async()=>{
 const {b}=await rpc(runtime(),'tools/list');const tools=b.result.tools;
 assert.equal(new Set(tools.map(x=>x.name)).size,tools.length);assert.ok(tools.length>=30);
 assert.ok(tools.find(t=>t.name==='ima_create_note').inputSchema.required.includes('request_id'));
 assert.ok(tools.find(t=>t.name==='ima_card_publish'));
 assert.equal(tools.find(t=>t.name==='ima_delete_note').annotations.destructiveHint,true);
});
test('MCP and bridge do not accept anonymous or cross-origin writes',async()=>{
 const env=runtime();assert.equal((await rpc(env,'tools/call',{name:'ima_list_notes',arguments:{}},false)).r.status,401);
 const no=await app.fetch(new Request('https://site.test/bridge/v1/governance',{method:'POST',body:'{"action":"service.health"}'}),env);assert.equal(no.status,401);
 const cross=await app.fetch(new Request('https://site.test/api/blobs?name=x.txt',{method:'POST',headers:{origin:'https://attacker.invalid','oai-authenticated-user-id':'owner'},body:'x'}),env);assert.equal(cross.status,403);
});
test('missing request ID and unknown fields fail before dispatch',async()=>{
 for(const args of [{content:'text'},{content:'text',request_id:'one',baseUrl:'https://attacker.invalid'}]){const {b}=await rpc(runtime(),'tools/call',{name:'ima_create_note',arguments:args});assert.equal(b.result.isError,true);}
});
test('private blob upload validates bytes and produces only protected downloads',async()=>{
 const env=runtime(),bytes=new TextEncoder().encode('中文正文');const headers={'oai-authenticated-user-id':'owner','content-type':'text/plain','content-length':String(bytes.length)};
 const result=await app.fetch(new Request('https://site.test/api/blobs?name=source.txt',{method:'POST',headers,body:bytes}),env);const data=await result.json();assert.equal(data.status,'succeeded');assert.equal(data.size,bytes.length);
 const anonymous=await app.fetch(new Request('https://site.test/api/blobs/'+data.blob_id),env);assert.equal(anonymous.status,401);
 const protectedRead=await app.fetch(new Request('https://site.test/api/blobs/'+data.blob_id,{headers:{'oai-authenticated-user-id':'owner'}}),env);assert.equal(await protectedRead.text(),'中文正文');assert.equal(protectedRead.headers.get('content-disposition'),'attachment');
 const bad=await app.fetch(new Request('https://site.test/api/blobs?name=bad.txt',{method:'POST',headers:{...headers,'x-content-sha256':'0'.repeat(64)},body:bytes}),env);assert.equal((await bad.json()).status,'invalid_input');assert.equal(env.objects.size,1);
});
test('shared service health and receipt absence are checked against readiness',async()=>{
 const env=runtime();const headers={'x-ima-bridge-token':'bridge-test','content-type':'application/json'};
 const request=q=>app.fetch(new Request('https://site.test/bridge/v1/governance',{method:'POST',headers,body:JSON.stringify(q)}),env);
 assert.equal((await (await request({action:'operation.absence',request_id:'none'})).json()).status,'unavailable');
 await context(env).store.put('settings','service',{ready:true,publication_enabled:false});
 assert.equal((await (await request({action:'operation.absence',request_id:'none'})).json()).absent,true);
 await context(env).store.put('settings','migration',{frozen:true});
 assert.equal((await (await request({action:'operation.absence',request_id:'none'})).json()).status,'unavailable');
});
