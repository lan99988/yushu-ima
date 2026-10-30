import test from 'node:test';
import assert from 'node:assert/strict';
import {context} from './fixtures/cloud-context.mjs';
import {TOOLS,dispatch,context as runtimeContext} from '../worker/app.js';
import {runtime} from './fixtures/runtime.mjs';
let implementation;try{implementation=await import('../worker/knowledge.js');}catch{}
const run=async(q,c)=>{assert.equal(typeof implementation?.knowledgeAction,'function','unified knowledge engine must exist');return implementation.knowledgeAction(q,c);};
const request=(request_id='new')=>({action:'ingest',request_id,policy_version:'2.0.0',mode:'organize',object:{key:'learning/retrieval',type:'concept'},material:{source_id:request_id,locator:'正文',content:'原始材料 '+request_id,kind:'opinion',author:'作者',context:'信息学习'},entry:{title:'检索练习',primary_category:'learning',body:'检索练习通过主动回想促进学习。\n\n保留原材料中的完整例子与适用条件。',tags:['学习','认知']},expected_version:0,execute:true});

test('new unified organize uses the exact simple display filename with version in metadata',async()=>{
 const c=context(),q=request('simple-title');q.entry.title='鱼油';const r=await run(q,c);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(c.transport.filename,'鱼油.md');assert.equal(r.object.filename,'鱼油.md');assert.match(c.transport.content,/"version": "1.0"/);
});
test('legacy unknown ingest reconciles its original versioned filename and receipt without redispatch',async()=>{
 const c=context(),q=request('old-unknown'),p=await run({...q,execute:false},c),{governance}=await import('../worker/governance.js'),{sha256,stable}=await import('../worker/storage.js');
 const g={action:'entry.prepare',policy_version:'1.0.0',request_id:'legacy-transport',entry:p.entry},prepared=await governance('entry.prepare',g,c);assert.equal(prepared.status,'preview');
 const transport=prepared.transport_request;await c.invoke('kb',{...transport,execute:true});
 const canonical=Object.fromEntries(Object.entries(q).filter(([k])=>!['execute','reconcile','workspace'].includes(k)));
 await c.store.put('knowledge_objects',q.object.key,{object_key:q.object.key,revision:0,pending_request:q.request_id});
 await c.store.put('knowledge_operations',q.request_id,{request_id:q.request_id,hash:await sha256(stable(canonical)),status:'unknown',transport,governance:g,object:p.object});
 const operation=await c.store.get('operations',transport.request_id),r=await run({...q,reconcile:true},c);
 assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.object.filename,prepared.artifact.filename);assert.match(r.object.filename,/__概念__v1.0\.md$/);assert.deepEqual(await c.store.get('operations',transport.request_id),operation);assert.equal(c.calls.filter(x=>x.q.execute&&!x.q.reconcile).length,1);
});
test('a legacy governance reservation made before an ingest operation also retains its original filename',async()=>{
 const c=context(),q=request('pre-reserved'),p=await run({...q,execute:false},c),{governance}=await import('../worker/governance.js'),{sha256}=await import('../worker/storage.js');
 const request_id='ki_'+await sha256('formal:'+q.request_id),g={action:'entry.prepare',policy_version:'1.0.0',request_id,entry:p.entry};
 const old=await governance('entry.prepare',g,c);assert.equal(old.status,'preview');const r=await run(q,c);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.object.filename,old.transport_request.filename);assert.equal(c.transport.content,old.transport_request.content);
});

test('object search tolerates an unfinished reservation without hiding its identity',async()=>{
 const c=context();
 await run(request(),c);
 const reservation={object_key:'acceptance/knowledge2/images',pending_request:'image-pending'};
 await c.store.put('knowledge_objects',reservation.object_key,reservation);
 const found=await run({action:'object.search',query:'检索练习'},c);
 assert.equal(found.status,'succeeded',JSON.stringify(found));
 assert.deepEqual(found.items.map(o=>o.object_key),['learning/retrieval']);
 const pending=await run({action:'object.search',query:'images'},c);
 assert.equal(pending.status,'succeeded',JSON.stringify(pending));
 assert.deepEqual(pending.items,[reservation]);
 assert.deepEqual(await c.store.get('knowledge_objects',reservation.object_key),reservation);
});
test('preview has no writes and a stable object identity ignores source identity',async()=>{
 const c=context(),q=request();q.execute=false;const p=await run(q,c);assert.equal(p.status,'preview');assert.equal(c.calls.length,0);assert.equal((await c.store.list('knowledge_operations')).items.length,0);
 q.execute=true;const a=await run(q,c);assert.equal(a.status,'succeeded',JSON.stringify(a));
 const b=request('another');b.expected_version=1;b.entry.body+='\n\n第二来源的例子。';const updated=await run(b,c);assert.equal(updated.status,'succeeded',JSON.stringify(updated));assert.equal(updated.object.entry_id,a.object.entry_id);assert.equal(updated.object.revision,2);assert.equal(updated.object.materials.length,2);
 const original=await c.blobs.get(updated.object.materials[0].blob_key);assert.equal(await original.text(),q.material.content);
});
test('stale concurrent updates, changed request replay, and unsupported policy fail closed',async()=>{
 const c=context(),q=request();assert.equal((await run(q,c)).status,'succeeded');
 assert.equal((await run(request('stale'),c)).status,'conflict');
 assert.equal((await run({...q,entry:{...q.entry,body:'变更请求'}},c)).status,'conflict');
 assert.equal((await run({...request('bad-policy'),policy_version:'1.0.0'},c)).status,'conflict');
});
test('opinion is not falsely verified; events require dates and major changes require actual confirmation',async()=>{
 const c=context(),q=request();q.entry.verification='verified';const a=await run(q,c);assert.equal(a.status,'succeeded');assert.equal(a.object.verification,'not_applicable');
 const event=request('event');event.entry.title='检索练习事件';event.object={key:'event/one',type:'event'};assert.equal((await run(event,c)).status,'invalid_input');event.as_of='2026-10-28';assert.equal((await run(event,c)).status,'succeeded');assert.match(c.transport.content,/判断截至：2026-10-28/);
 const change=request('change');change.expected_version=1;change.major_change=true;assert.equal((await run(change,c)).status,'blocked');
});
test('unknown dispatch only reconciles the same transport and blocks other revisions',async()=>{
 const c=context(),invoke=c.invoke;let fail=true;c.invoke=async(d,q)=>q.action==='text.create'&&!q.reconcile&&fail?{status:'unknown'}:invoke(d,q);
 const q=request();assert.equal((await run(q,c)).status,'unknown');assert.equal((await run(request('other'),c)).status,'conflict');
 const writes=c.calls.filter(x=>x.q.execute&&!x.q.reconcile).length;assert.equal((await run(q,c)).status,'unknown');assert.equal(c.calls.filter(x=>x.q.execute&&!x.q.reconcile).length,writes);
 fail=false;assert.notEqual((await run({...q,reconcile:true},c)).status,'succeeded');
});
test('archive preserves exact text and idempotent receipt without creating a knowledge object',async()=>{
 const c=context(),q={action:'ingest',request_id:'archive',policy_version:'2.0.0',mode:'archive',material:{source_id:'original',locator:'笔记',content:'\ufeff# 原稿\r\n原样内容  ',kind:'original'},execute:true};
 const a=await run(q,c);assert.equal(a.status,'succeeded',JSON.stringify(a));assert.equal(c.transport.content,q.material.content);assert.equal((await c.store.list('knowledge_objects')).items.length,0);
 const calls=c.calls.length;assert.equal((await run(q,c)).replayed,true);assert.equal(c.calls.length,calls);
});
test('relations resolve stable objects and parent links are returned in both directions',async()=>{
 const c=context();await run(request(),c);const q=request('topic');q.object={key:'learning/retrieval/when',type:'question',parent_key:'learning/retrieval'};q.entry.title='何时进行检索练习';q.entry.body='独立问题的完整答案与例子。';assert.equal((await run(q,c)).status,'succeeded');
 const p=await run({action:'object.get',object_key:'learning/retrieval'},c);assert.equal(p.children[0].object_key,q.object.key);
});
test('all host surfaces expose a single knowledge workflow and blocked low-level writes cannot bypass it',async()=>{
 for(const name of ['ima_knowledge_policy','ima_knowledge_search','ima_knowledge_get','ima_knowledge_ingest'])assert.ok(TOOLS.some(t=>t.name===name),name);
 const e=runtime(),c=runtimeContext(e);
 try{await c.store.put('settings','service',{ready:true,publication_enabled:true,knowledge_v2_enabled:true,knowledge_v2_activated_at:new Date().toISOString()});
 const r=await c.invoke('notes',{action:'create',content:'绕过',request_id:'unmanaged',execute:true});assert.equal(r.message,'knowledge_ingest_required');
 assert.equal((await dispatch('ima_knowledge_policy',{},c)).policy.version,'2.0.0');
 }finally{e.close();}
});
test('verified facts require an actual bound review and source dates do not become verification dates',async()=>{
 const c=context(),q=request();q.material.kind='fact';q.entry.verification='verified';q.material.published_date='2025-01-01';
 q.review={mode:'web_verified',revision_hash:await (await import('../worker/storage.js')).sha256(q.entry.body),evidence:[{url:'https://example.org/paper',locator:'section 1',supports:'主张',excerpt:'实际读取摘录',checked_at:'2026-10-28T00:00:00Z',checker:'host'}]};
 const r=await run(q,c);assert.equal(r.status,'succeeded');assert.equal(r.object.verification,'verified');
});
test('an existing governed entry can be adopted only with explicit review and keeps its stable ID',async()=>{
 const c=context(),q=request();const first=await run(q,c);assert.equal(first.status,'succeeded');
 await c.store.remove('knowledge_objects',q.object.key);
 const adoption=request('adopt');adoption.object.existing_entry_id=first.object.entry_id;
 assert.equal((await run(adoption,c)).status,'blocked');adoption.major_change=true;adoption.confirmation='已确认把这张原卡纳入统一条目并保留正文';
 const r=await run(adoption,c);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.object.entry_id,first.object.entry_id);assert.equal(r.object.revision,2);
});
test('bridge input cannot use truthy strings to execute writes',async()=>{
 const c=context();assert.equal((await run({...request(),execute:'true'},c)).status,'invalid_input');assert.equal(c.calls.length,0);
 assert.equal((await run({...request(),expected_version:-1},c)).status,'invalid_input');
});
test('archive append preserves the original note target and exact appended text',async()=>{
 const c=context(),calls=[],invoke=c.invoke;c.invoke=async(d,q)=>{if(d!=='notes')return invoke(d,q);calls.push(q);if(q.action==='get')return {status:'succeeded',data:{title:'原笔记',content:'原正文'}};return {status:'succeeded',resource:{note_id:q.note_id}};};
 const q={action:'ingest',request_id:'append',policy_version:'2.0.0',mode:'archive',material:{source_id:'fragment',locator:'新段落',content:'\n追加原稿  ',kind:'original',note_id:'note-real'},execute:true};
 const r=await run(q,c);assert.equal(r.status,'succeeded');assert.equal(r.receipt.resource.note_id,'note-real');assert.equal(calls[1].content,q.material.content);assert.equal(calls[1].expected_title,'原笔记');
});
test('legacy note creation uses the unified archive without changing the native resource type',async()=>{
 const c=context();let seen;c.invoke=async(d,q)=>{seen={d,q};return {status:'succeeded',resource:{note_id:'created-note'}};};
 const q={action:'ingest',request_id:'note-create',policy_version:'2.0.0',mode:'archive',material:{source_id:'note',locator:'笔记原文',content:'# 标题\n内容',kind:'original',storage:'note'},execute:true};
 const r=await run(q,c);assert.equal(r.status,'succeeded');assert.equal(seen.d,'notes');assert.equal(seen.q.action,'create');assert.equal(r.receipt.resource.note_id,'created-note');
});
test('a completed durable receipt can be read while a terminated worker lease is still present',async()=>{
 const c=context(),q=request();await run(q,c);c.store.acquireLease=async()=>null;
 const r=await run({...q,reconcile:true},c);assert.equal(r.status,'succeeded');assert.equal(r.replayed,true);
});
