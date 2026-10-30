import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/app.js';
import {runtime} from './fixtures/runtime.mjs';
const rpc=(path,token,method='tools/call',params={name:'ima_knowledge_policy',arguments:{}})=>new Request('https://service.example'+path,{method:'POST',headers:{'content-type':'application/json',...(token?{'x-ima-bridge-token':token}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});

test('controlled bridge MCP authenticates without accepting an external owner identity',async()=>{
 const env=runtime();
 try{
  const response=await worker.fetch(rpc('/bridge/v1/mcp',env.IMA_CLOUD_BRIDGE_TOKEN),env),body=await response.json();
  assert.equal(response.status,200);assert.equal(body.result.isError,undefined);
  assert.equal(JSON.parse(body.result.content[0].text).status,'succeeded');
 }finally{env.close();}
});
test('bridge MCP rejects missing and incorrect tokens, including initialization',async()=>{
 const env=runtime();try{for(const token of [undefined,'incorrect']){const r=await worker.fetch(rpc('/bridge/v1/mcp',token,'initialize',{}),env);assert.equal(r.status,401);}}finally{env.close();}
});
test('the normal MCP endpoint still requires platform owner identity for tool calls',async()=>{
 const env=runtime();try{const r=await worker.fetch(rpc('/mcp',env.IMA_CLOUD_BRIDGE_TOKEN),env);assert.equal(r.status,401);}finally{env.close();}
});
