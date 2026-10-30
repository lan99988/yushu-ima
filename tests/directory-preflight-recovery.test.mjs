import test from 'node:test';
import assert from 'node:assert/strict';
import {context} from '../worker/app.js';
import {directoryAction} from '../worker/directories.js';
import {upgradePolicy} from '../worker/governance.js';
import {stable} from '../worker/storage.js';
import {runtime} from './fixtures/runtime.mjs';
import {contract} from './fixtures/cloud-context.mjs';

const paths=[{topics:['恢复测试'],purpose:'验证原目录请求的安全恢复'}];
async function fixture(t,{enabled=true,topics=paths[0].topics}={}){
 const env=runtime(),ctx=context(env),folders=new Map(),writes=[];
 t.after(()=>env.close());
 await ctx.store.put('settings','policy',contract.policy);
 await ctx.store.put('settings','bindings',contract.bindings);
 await ctx.store.put('settings','service',{ready:true,publication_enabled:enabled});
 assert.equal((await upgradePolicy(ctx)).status,'succeeded');
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  const endpoint=new URL(url).pathname.split('/').at(-1),q=JSON.parse(init.body);
  if(endpoint==='get_knowledge_base')return Response.json({code:0,data:{infos:{[q.ids[0]]:{name:contract.bindings.kb_name}}}});
  if(endpoint==='get_knowledge_list')return Response.json({code:0,data:{knowledge_list:folders.get(q.folder_id)||[],is_end:true}});
  assert.equal(endpoint,'create_folder','no unmocked external calls');
  writes.push(q);const id='folder_created_'+writes.length;
  folders.set(q.folder_id,[...(folders.get(q.folder_id)||[]),{folder_id:id,title:q.name}]);
  return Response.json({code:0,data:{media_id:id}});
 });
 const proposal=await directoryAction('plan',{primary_category:'learning',paths:[{topics,purpose:paths[0].purpose}]},ctx);
 assert.equal(proposal.status,'preview');
 const q={plan_id:proposal.plan.plan_id,revision:1,decision:'confirm',confirmation:'确认本批完整路径'};
 const resource=stable({domain:'knowledge',note_id:'ima-kb:'+contract.bindings.kb_id},true);
 return {ctx,env,folders,writes,q,resource};
}
async function blockedByLock(f){
 await f.ctx.store.acquireLock(f.resource,'other-upload');
 const r=await directoryAction('apply',f.q,f.ctx);
 assert.equal(r.status,'conflict');assert.equal(r.plan.nodes[0].receipt.message,'resource_locked_by_another_request');
 const id=r.plan.nodes[0].request_id,op=await f.ctx.store.get('operations',id);
 assert.equal(op.status,'blocked');assert.equal(op.dispatched_at,undefined);assert.deepEqual(op.state,{});
 await f.ctx.store.releaseLock(f.resource,'other-upload');
 return {id,op};
}

test('a library lock conflict resumes the original plan and request after the lock clears',async t=>{
 const f=await fixture(t),{id}=await blockedByLock(f);
 const r=await directoryAction('apply',f.q,f.ctx);
 assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.plan.nodes[0].request_id,id);
 assert.equal(f.writes.length,1);assert.equal((await f.ctx.store.get('operations',id)).status,'succeeded');
 assert.equal((await directoryAction('apply',f.q,f.ctx)).status,'succeeded');assert.equal(f.writes.length,1);
});

test('publication gate without an operation resumes under the same request when enabled',async t=>{
 const f=await fixture(t,{enabled:false}),first=await directoryAction('apply',f.q,f.ctx);
 assert.equal(first.status,'blocked');const id=first.plan.nodes[0].request_id;
 assert.equal(await f.ctx.store.get('operations',id),null);assert.equal(f.writes.length,0);
 await f.ctx.store.put('settings','service',{ready:true,publication_enabled:true});
 const r=await directoryAction('apply',{...f.q,reconcile:true},f.ctx);
 assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.plan.nodes[0].request_id,id);assert.equal(f.writes.length,1);
});

test('a crash after directory intent but before runOperation can resume the same request',async t=>{
 const f=await fixture(t),write=f.ctx.baseStore.fencedWrite.bind(f.ctx.baseStore);
 let id;
 f.ctx.baseStore.fencedWrite=async(method,col,key,value,...rest)=>{
  const result=await write(method,col,key,value,...rest);
  if(col==='directory_plans'&&value.nodes[0].request_id&&!id){id=value.nodes[0].request_id;throw Error('crash after intent');}
  return result;
 };
 assert.equal((await directoryAction('apply',f.q,f.ctx)).status,'unavailable');
 f.ctx.baseStore.fencedWrite=write;
 assert.equal(await f.ctx.store.get('operations',id),null);
 const r=await directoryAction('apply',f.q,f.ctx);
 assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.plan.nodes[0].request_id,id);assert.equal(f.writes.length,1);
});

test('a reserved operation with no dispatch evidence can continue under the original request',async t=>{
 const f=await fixture(t),{id,op}=await blockedByLock(f);
 await f.ctx.store.put('operations',id,{...op,status:'reserved'});
 const r=await directoryAction('apply',{...f.q,reconcile:true},f.ctx);
 assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.plan.nodes[0].request_id,id);assert.equal(f.writes.length,1);
});

for(const missing of [false,true])for(const decision of ['decline','revise']){
 test(`an entirely undispatched plan permits ${decision} with ${missing?'no operation':'a blocked operation'}`,async t=>{
  const f=await fixture(t,{enabled:!missing});
  const first=missing?await directoryAction('apply',f.q,f.ctx):null;
  const id=missing?first.plan.nodes[0].request_id:(await blockedByLock(f)).id;
  const r=decision==='decline'?await directoryAction('apply',{...f.q,decision:'decline',confirmation:'不创建'},f.ctx):await directoryAction('plan',{primary_category:'learning',paths:[{topics:['修改后的主题'],purpose:'修改安全方案'}],plan_id:f.q.plan_id,expected_revision:1},f.ctx);
  assert.equal(r.status,decision==='decline'?'succeeded':'preview',JSON.stringify(r));assert.equal(f.writes.length,0);
  if(decision==='revise'){
   assert.equal(r.plan.revision,2);assert.equal(r.plan.confirmation,undefined);
   assert.equal((await directoryAction('apply',f.q,f.ctx)).status,'conflict');
  }
  assert.equal((await f.ctx.store.get('operations',id))?.dispatched_at,undefined);
 });
}

const unsafe=[
 ['unknown',{status:'unknown'}],
 ['unavailable',{status:'unavailable'}],
 ['dispatched',{status:'blocked',dispatched_at:'2026-10-26T00:00:00Z'}],
 ['active invocation',{status:'reserved',running_until:Date.now()+300000}],
 ['write stage',{status:'blocked',state:{stage:'create_folder',receipt:{stages:{create_folder:'before'}}}}],
 ['serialized receipt stage',{status:'reserved',receipt:JSON.stringify({receipt:{stages:{create_folder:'before'}}})}],
 ['recorded resource',{status:'reserved',state:{resource:{folder_id:'folder_existing'}}}],
 ['receipt resource',{status:'blocked',receipt:{status:'blocked',resource:{folder_id:'folder_existing'}}}],
];
for(const [name,patch] of unsafe)test(`persistent ${name} never becomes a fresh create, decline, or revision`,async t=>{
 const f=await fixture(t),{id,op}=await blockedByLock(f);
 await f.ctx.store.put('operations',id,{...op,...patch});
 assert.equal((await directoryAction('apply',f.q,f.ctx)).status,'verification_pending');
 await directoryAction('apply',{...f.q,reconcile:true},f.ctx);
 assert.equal(f.writes.length,0);assert.equal((await f.ctx.store.get('directory_plans',f.q.plan_id)).nodes[0].request_id,id);
 assert.equal((await directoryAction('apply',{...f.q,decision:'decline'},f.ctx)).status,'conflict');
 assert.equal((await directoryAction('plan',{primary_category:'learning',paths,plan_id:f.q.plan_id,expected_revision:1},f.ctx)).status,'conflict');
 assert.equal(f.writes.length,0);
});

test('a sibling consuming the number before safe recovery requires a new revision and confirmation',async t=>{
 const f=await fixture(t),{id}=await blockedByLock(f);
 f.folders.set(contract.bindings.categories.learning.folder_id,[{folder_id:'folder_other',title:'01_占用编号'}]);
 const conflict=await directoryAction('apply',f.q,f.ctx);
 assert.equal(conflict.status,'conflict');assert.equal(conflict.message,'directory_parent_changed_replan_required');assert.equal(f.writes.length,0);
 const revised=await directoryAction('plan',{primary_category:'learning',paths,plan_id:f.q.plan_id,expected_revision:1},f.ctx);
 assert.equal(revised.status,'preview');assert.equal(revised.plan.revision,2);assert.equal(revised.plan.nodes[0].name,'02_恢复测试');assert.equal(revised.plan.confirmation,undefined);
 assert.equal((await directoryAction('apply',f.q,f.ctx)).status,'conflict');
 assert.equal((await f.ctx.store.get('operations',id)).status,'blocked');assert.equal(f.writes.length,0);
});

test('a partially created plan cannot be declined or revised even if its remaining node is undispatched',async t=>{
 const f=await fixture(t,{topics:['父层','子层']}),invoke=f.ctx.invoke;
 f.ctx.invoke=async(d,q)=>{
  const result=await invoke(d,q);
  if(q.action==='folder.create'&&result.status==='succeeded')await f.ctx.store.put('settings','service',{ready:true,publication_enabled:false});
  return result;
 };
 const first=await directoryAction('apply',f.q,f.ctx);
 assert.equal(first.status,'blocked');assert.equal(f.writes.length,1);assert.equal(first.plan.nodes[0].state,'ready');
 const id=first.plan.nodes[1].request_id;assert.equal(await f.ctx.store.get('operations',id),null);
 assert.equal((await directoryAction('apply',{...f.q,decision:'decline'},f.ctx)).status,'conflict');
 assert.equal((await directoryAction('plan',{primary_category:'learning',paths,plan_id:f.q.plan_id,expected_revision:1},f.ctx)).status,'conflict');
 f.ctx.invoke=invoke;await f.ctx.store.put('settings','service',{ready:true,publication_enabled:true});
 const r=await directoryAction('apply',f.q,f.ctx);
 assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.plan.nodes[1].request_id,id);assert.equal(f.writes.length,2);
});

test('a failed operations read cannot be treated as an absent operation',async t=>{
 const f=await fixture(t),{id}=await blockedByLock(f),get=f.ctx.baseStore.get.bind(f.ctx.baseStore);
 f.ctx.baseStore.get=async(col,key)=>{if(col==='operations')throw Error('ledger unavailable');return get(col,key);};
 try{
  assert.equal((await directoryAction('apply',f.q,f.ctx)).status,'unavailable');
  assert.equal((await directoryAction('apply',{...f.q,reconcile:true},f.ctx)).status,'unavailable');
  assert.equal((await directoryAction('apply',{...f.q,decision:'decline'},f.ctx)).status,'unavailable');
  assert.equal((await directoryAction('plan',{primary_category:'learning',paths,plan_id:f.q.plan_id,expected_revision:1},f.ctx)).status,'unavailable');
 }finally{f.ctx.baseStore.get=get;}
 assert.equal(f.writes.length,0);assert.equal((await get('operations',id)).status,'blocked');
});

test('an unknown provider write stays reconcile-only after reloading the persisted plan',async t=>{
 const f=await fixture(t),fetcher=globalThis.fetch;let attempts=0;
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  if(new URL(url).pathname.endsWith('/create_folder')){attempts++;throw Error('lost provider reply');}
  return fetcher(url,init);
 });
 const first=await directoryAction('apply',f.q,f.ctx);assert.equal(first.status,'unknown');assert.equal(attempts,1);
 const id=first.plan.nodes[0].request_id,op=await f.ctx.store.get('operations',id);
 assert.equal(op.status,'unknown');assert.ok(op.dispatched_at);assert.equal(op.state.receipt.stages.create_folder,'before');
 const restarted=context(f.env);
 assert.equal((await directoryAction('apply',f.q,restarted)).status,'verification_pending');
 await directoryAction('apply',{...f.q,reconcile:true},restarted);
 assert.equal(attempts,1);assert.equal((await restarted.store.get('directory_plans',f.q.plan_id)).nodes[0].request_id,id);
 assert.equal((await directoryAction('apply',{...f.q,decision:'decline'},restarted)).status,'conflict');
});

for(const status of ['unknown','unavailable'])test(`an unpersisted ${status} response alone never authorizes another create`,async t=>{
 const f=await fixture(t,{enabled:false}),first=await directoryAction('apply',f.q,f.ctx);
 const value=await f.ctx.store.get('directory_plans',f.q.plan_id);value.nodes[0].receipt={status};
 await f.ctx.store.put('directory_plans',f.q.plan_id,value);
 await f.ctx.store.put('settings','service',{ready:true,publication_enabled:true});
 assert.equal((await directoryAction('apply',f.q,f.ctx)).status,'verification_pending');
 const r=await directoryAction('apply',{...f.q,reconcile:true},f.ctx);
 assert.equal(r.status,'unavailable');assert.equal(await f.ctx.store.get('operations',first.plan.nodes[0].request_id),null);assert.equal(f.writes.length,0);
});
