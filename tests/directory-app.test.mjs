import test from 'node:test';import assert from 'node:assert/strict';
import app,{context,TOOLS} from '../worker/app.js';import {runtime} from './fixtures/runtime.mjs';import {contract} from './fixtures/cloud-context.mjs';
test('folder workflow tools expose separate proposal, confirmation, and tree reads',()=>{
 for(const name of ['ima_folder_plan','ima_folder_apply','ima_list_directories'])assert.ok(TOOLS.find(t=>t.name===name),name);
 const apply=TOOLS.find(t=>t.name==='ima_folder_apply');assert.ok(apply.inputSchema.required.includes('confirmation'));assert.ok(apply.inputSchema.required.includes('revision'));
});
test('raw managed-library folder creation cannot bypass batch confirmation',async()=>{
 const env=runtime(),ctx=context(env);await ctx.store.put('settings','policy',contract.policy);await ctx.store.put('settings','bindings',contract.bindings);await ctx.store.put('settings','service',{ready:true,publication_enabled:true});
 const result=await ctx.invoke('kb',{action:'folder.create',kb_id:contract.bindings.kb_id,folder_id:contract.bindings.categories.learning.folder_id,name:'01_绕过询问',request_id:'bypass',execute:true});
 assert.equal(result.status,'blocked');assert.equal(await ctx.store.get('operations','bypass'),null);
});
test('formal context cannot bypass the isolated managed-library confirmation',async()=>{
 const env=runtime(),ctx=context(env),isolated=context(env,'isolated');await ctx.store.put('settings','bindings',contract.bindings);await ctx.store.put('settings','service',{ready:true,publication_enabled:true});
 await isolated.store.put('settings','bindings',{...contract.bindings,kb_id:'isolated-managed-kb'});
 const result=await ctx.invoke('kb',{action:'folder.create',kb_id:'isolated-managed-kb',folder_id:'isolated-parent',name:'01_未确认',request_id:'cross-workspace-bypass',execute:true});
 assert.equal(result.status,'blocked');assert.equal(await ctx.store.get('operations','cross-workspace-bypass'),null);
});
