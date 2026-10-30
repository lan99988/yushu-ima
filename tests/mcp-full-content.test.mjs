import test from 'node:test';
import assert from 'node:assert/strict';
import app,{context} from '../worker/app.js';
import {runtime} from './fixtures/runtime.mjs';
import {contract,draft} from './fixtures/cloud-context.mjs';
async function call(env,name,args){
 const r=await app.fetch(new Request('https://site.test/mcp',{method:'POST',headers:{'oai-authenticated-user-id':'owner','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),env);
 const b=await r.json();assert.equal(b.result.isError,undefined,JSON.stringify(b));return JSON.parse(b.result.content[0].text);
}
test('MCP returns the entire formal policy including checksum',async()=>{
 const env=runtime(),ctx=context(env);await ctx.store.put('settings','policy',contract.policy);await ctx.store.put('settings','bindings',contract.bindings);
 const r=await call(env,'ima_governance',{action:'policy.get'});
 assert.deepEqual(r.policy,contract.policy);assert.equal(r.policy_sha256,contract.policy_sha256);
});
test('MCP status preserves long original and reviewed content without silent truncation',async()=>{
 const env=runtime(),ctx=context(env);await ctx.store.put('settings','policy',contract.policy);await ctx.store.put('settings','bindings',contract.bindings);
 const content='完整原稿中文末尾校验。'.repeat(1000)+'END原文';
 const added=await call(env,'ima_card_intake',{...draft(),content});
 const r=await call(env,'ima_card_status',{card_id:added.card.card_id,include_content:true});
 assert.equal(r.card.content,content);assert.equal(r.card.original.content,content);
});
