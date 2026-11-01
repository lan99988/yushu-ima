import test from 'node:test';
import assert from 'node:assert/strict';
import {context,TOOLS} from '../worker/app.js';
import {runtime} from './fixtures/runtime.mjs';
import {contract} from './fixtures/cloud-context.mjs';
import {sha256,stable} from '../worker/storage.js';
import {sessionAction} from '../worker/ima-session.js';
import {moveAction} from '../worker/moves.js';
import {projectCurrentLocation} from '../worker/move-index.js';
import {adminAction} from '../worker/admin.js';
const api=await import('../worker/content-mutations.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});

async function largeLibrary(f){
 const native=f.ctx.nativeFetcher,invoke=f.ctx.invoke,nativeId=f.media_id.slice(5),extra=Array.from({length:25},(_,i)=>({media_id:'scan-extra-'+i,title:'extra '+i,media_type:99,parent_folder_id:nativeId,file_size:'0',md5_sum:''})),nativeReads=[],apiReads=[];
 f.ctx.nativeFetcher=async(url,options)=>{const q=JSON.parse(options.body);if(!url.endsWith('/get_knowledge_list'))return native(url,options);nativeReads.push(q.folder_id);
  if(q.folder_id.startsWith('scan-extra-'))return Response.json({code:0,knowledge_base_info:{id:nativeId},current_path:[{folder_id:nativeId,name:f.b.kb_name,parent_folder_id:''},{folder_id:q.folder_id,name:extra.find(x=>x.media_id===q.folder_id).title,parent_folder_id:nativeId}],knowledge_list:[],is_end:true});
  const r=await native(url,options),d=await r.json();if(!q.folder_id)d.knowledge_list.push(...extra);return Response.json(d);
 };
 f.ctx.invoke=async(d,q)=>{if(q.action!=='folder.list')return invoke(d,q);apiReads.push(q.folder_id);if(q.folder_id?.startsWith('scan-extra-'))return {status:'succeeded',data:{items:[],has_more:false}};const r=await invoke(d,q);if(!q.folder_id)r.data.items.push(...extra.map(x=>({...x,kind:'folder'})));return r;};
 return {nativeReads,apiReads};
}

test('large absence verification yields durable progress and resumes without rescanning or redispatch',async()=>{
 const f=await fixture(),reads=await largeLibrary(f),p=await f.preview('sliced');let r=await f.execute(p);
 assert.equal(r.status,'verification_pending',JSON.stringify(r));assert.ok(r.progress.scan.folders_checked>0);assert.equal(r.progress.scan.complete,false);assert.equal(f.dispatches(),1);
 assert.equal((await f.preview('other-while-scan')).status,'conflict');
 let turns=0;while(r.status==='verification_pending'&&turns++<10)r=await api.contentAction('ima_delete_reconcile',{request_id:p.request_id},{...f.ctx});
 assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.verification.complete_library_absence,true);assert.equal(f.dispatches(),1);assert.equal(reads.nativeReads.filter(x=>x==='').length,1);assert.equal(reads.apiReads.filter(x=>x==='').length,1);assert.ok(turns>0);f.env.close();
});
test('a timed out OpenAPI scan read retains the validated native half and resumes it',async()=>{
 const f=await fixture(),reads=await largeLibrary(f),p=await f.preview('half-scan'),invoke=f.ctx.invoke;let failed=false;
 f.ctx.invoke=async(d,q)=>{if(q.action==='folder.list'&&q.folder_id===''&&!failed){failed=true;return {status:'unavailable'};}return invoke(d,q);};
 let r=await f.execute(p);assert.equal(r.status,'verification_pending');assert.ok((await f.ctx.store.get('content_operations',p.request_id)).absence_scan?.native_listing,'native half must be durable before OpenAPI');
 for(let i=0;i<10&&r.status!=='succeeded';i++)r=await api.contentAction('ima_delete_reconcile',{request_id:p.request_id},f.ctx);
 assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(reads.nativeReads.filter(x=>x==='').length,1);assert.equal(f.dispatches(),1);f.env.close();
});
test('large index synchronization yields a durable cursor without repeating native deletion',async()=>{
 const f=await fixture();for(let i=0;i<40;i++)await f.ctx.store.put('cards','historical-'+String(i).padStart(3,'0'),{media_id:f.media_id,retained:'evidence '+i});
 const p=await f.preview('index-slice');let r=await f.execute(p);assert.equal(r.status,'verification_pending');assert.equal(r.progress.stage,'index_synchronization');assert.ok(r.progress.index.rows_checked>0);
 for(let i=0;i<10&&r.status!=='succeeded';i++)r=await api.contentAction('ima_delete_reconcile',{request_id:p.request_id},f.ctx);
 assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(f.dispatches(),1);for(const {value} of (await f.ctx.store.list('cards',{limit:100})).items)assert.equal(value.current_content.state,'deleted_from_knowledge_base');f.env.close();
});
test('a hanging read returns pending and releases the short lease while retaining its durable fence',async t=>{
 const f=await fixture(),p=await f.preview('read-timeout'),native=f.ctx.nativeFetcher;let signal;const started=new Promise(r=>signal=r);let hanging=true;
 f.ctx.nativeFetcher=async(url,options)=>{if(url.endsWith('/get_knowledge_list')&&JSON.parse(options.body).folder_id===''&&hanging){signal();return new Promise(()=>{});}return native(url,options);};
 t.mock.timers.enable({apis:['setTimeout']});const running=f.execute(p);await started;t.mock.timers.tick(20001);const r=await running;t.mock.timers.reset();
 assert.equal(r.status,'verification_pending');assert.equal(r.progress.stage,'library_scan_native');assert.equal((await f.ctx.baseStore.list('locks',{limit:100})).items.some(x=>x.value.lease),false);assert.equal(f.dispatches(),1);
 hanging=false;assert.equal((await api.contentAction('ima_delete_reconcile',{request_id:p.request_id},f.ctx)).status,'succeeded');assert.equal(f.dispatches(),1);f.env.close();
});
test('legacy unknown applied deletion completes through slices but does not invent native acceptance',async()=>{
 const f=await fixture();await largeLibrary(f);const p=await f.preview('legacy-unknown-slices');f.setMode('applied-timeout');let r=await f.execute(p);assert.equal(r.status,'verification_pending');
 for(let i=0;i<10&&r.status!=='succeeded';i++)r=await api.contentAction('ima_delete_reconcile',{request_id:p.request_id},f.ctx);
 assert.equal(r.status,'succeeded');assert.equal(r.provider_result.status,'unknown');assert.equal(f.dispatches(),1);assert.equal((await api.contentAction('ima_content_capabilities',{},f.ctx)).formal_delete_enabled,false);f.env.close();
});
test('lost durable ownership and corrupted backup cannot finalize a partially scanned operation',async()=>{
 for(const corruption of ['owner','backup']){const f=await fixture();await largeLibrary(f);const p=await f.preview('slice-'+corruption),first=await f.execute(p);assert.equal(first.status,'verification_pending');
  if(corruption==='owner'){const account=await sha256(f.env.IMA_OPENAPI_CLIENTID),active=await f.ctx.baseStore.get('native_content_active',account+':'+f.b.kb_id);await f.ctx.baseStore.put('native_content_active',account+':'+f.b.kb_id,{...active,lock_owner:'different-owner'});}
  else await f.ctx.blobs.put(first.backup.blob_key,'corrupted');
  let r;for(let i=0;i<5;i++)r=await api.contentAction('ima_delete_reconcile',{request_id:p.request_id},f.ctx);assert.equal(r.status,'verification_pending');assert.equal(r.index_synchronized,false);assert.equal(f.dispatches(),1);f.env.close();
 }
});
test('a legacy exact-request preview orphan reuses its owner without unlocking another request',async()=>{
 for(const activeBoundary of ['none','same-preview']){
  const f=await fixture(),p=await f.preview('legacy-orphan-'+activeBoundary),op=await f.ctx.store.get('content_operations',p.request_id),resource=stable({domain:'knowledge',note_id:'ima-kb:'+f.b.kb_id},true),owner='native-delete:'+p.request_id+':'+crypto.randomUUID();await f.ctx.baseStore.acquireLock(resource,owner);
  if(activeBoundary==='same-preview')await f.ctx.baseStore.put('native_content_active',await sha256(f.env.IMA_OPENAPI_CLIENTID)+':'+f.b.kb_id,{request_id:p.request_id,resource_key:resource,lock_owner:owner,resolved:false});
  const r=await f.execute(p);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(f.dispatches(),1);assert.equal((await f.ctx.store.get('content_operations',p.request_id)).dispatch_owner,owner);assert.equal(await f.ctx.baseStore.get('locks',resource),null);f.env.close();
 }
});
test('pre-dispatch owner is durable before acquiring its permanent library lock',async()=>{
 const f=await fixture(),p=await f.preview('owner-outbox'),acquire=f.ctx.baseStore.acquireLock.bind(f.ctx.baseStore);let observed=false;
 f.ctx.baseStore.acquireLock=async(key,owner)=>{if(owner.startsWith('native-delete:')){const op=await f.ctx.store.get('content_operations',p.request_id);assert.equal(op.preparation?.owner,owner);assert.equal(op.preparation?.resource_key,key);observed=true;}return acquire(key,owner);};
 assert.equal((await f.execute(p)).status,'succeeded');assert.equal(observed,true);assert.equal(f.dispatches(),1);f.env.close();
});
test('foreign, malformed and already-dispatched preview locks are never adopted or released',async()=>{
 for(const kind of ['foreign','malformed','dispatched']){const f=await fixture(),p=await f.preview('strict-owner'),resource=stable({domain:'knowledge',note_id:'ima-kb:'+f.b.kb_id},true),owner=kind==='foreign'?'native-delete:other:'+crypto.randomUUID():kind==='malformed'?'native-delete:'+p.request_id+':not-a-uuid':'native-delete:'+p.request_id+':'+crypto.randomUUID();await f.ctx.baseStore.acquireLock(resource,owner);
  if(kind==='dispatched'){const op=await f.ctx.store.get('content_operations',p.request_id);await f.ctx.store.put('content_operations',p.request_id,{...op,dispatched_at:new Date().toISOString()});}
  assert.ok(['conflict','verification_pending','blocked'].includes((await f.execute(p)).status));assert.equal(f.dispatches(),0);assert.equal((await f.ctx.baseStore.get('locks',resource)).request_id,owner);f.env.close();
 }
});
test('lock diagnostics identify an exact legacy preview orphan without exposing its owner',async()=>{
 const f=await fixture(),p=await f.preview('diagnose-owner'),op=await f.ctx.store.get('content_operations',p.request_id),resource=stable({domain:'knowledge',note_id:'ima-kb:'+f.b.kb_id},true),owner='native-delete:'+p.request_id+':'+crypto.randomUUID();await f.ctx.baseStore.acquireLock(resource,owner);
 assert.equal(typeof api.nativeDeleteLockBinding,'function');const binding=await api.nativeDeleteLockBinding(f.ctx,op);assert.equal(binding.owner_matches_current_request,true);assert.equal(binding.recoverable_preview_owner,true);assert.equal(JSON.stringify(binding).includes(owner),false);assert.equal(f.dispatches(),0);f.env.close();
});

async function fixture(){
 const env={...runtime(),IMA_SESSION_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')},ctx=context(env,'isolated');
 const b={...structuredClone(contract.bindings),account_sha256:await sha256(env.IMA_OPENAPI_CLIENTID)};
 await ctx.store.put('settings','bindings',b);await ctx.store.put('settings','policy',contract.policy);
 await ctx.baseStore.put('settings','bindings',{...b,kb_id:'formal-kb'});await ctx.baseStore.put('settings','service',{ready:true,publication_enabled:true});await ctx.store.put('settings','service',{publication_enabled:true});
 await sessionAction('install',{installation_id:'delete-fixture-login-0001',account_info:{userId:'delete-user',token:'access',refreshToken:'refresh',tokenExpiredTime:Date.now()+7200000,refreshTokenExpiredTime:Date.now()+86400000}},ctx);
 ctx.sessionFetcher=async()=>Response.json({code:0,token:'renewed',token_valid_time:7200});await sessionAction('verify',{},ctx);
 const nativeId='7000000000000002',folder=b.categories.learning.folder_id,media_id='file-'+nativeId,contents=new Map([[media_id,'# 隔离删除测试\n\n原始正文。\n']]);let deleted=false,dispatches=0,mode='success',title='sample.md',media_type=7,md5='original-md5';
 const item=()=>({media_id,title,media_type,parent_folder_id:folder,file_size:String(new TextEncoder().encode(contents.get(media_id)).length),md5_sum:md5});
 const roots=Object.values(b.categories).map(x=>({media_id:x.folder_id,title:x.folder_name,media_type:99,parent_folder_id:nativeId,file_size:'0',md5_sum:''}));
 const list=id=>id?(id===folder&&!deleted?[item()]:[]):roots;
 ctx.nativeFetcher=async(url,options)=>{
  const q=JSON.parse(options.body);
  if(url.endsWith('/get_knowledge_list'))return Response.json({code:0,knowledge_base_info:{id:nativeId},current_path:[{folder_id:nativeId,name:b.kb_name,parent_folder_id:''},...(q.folder_id?[{folder_id:q.folder_id,name:roots.find(x=>x.media_id===q.folder_id).title,parent_folder_id:nativeId}]:[])],knowledge_list:list(q.folder_id),is_end:true});
  if(url.endsWith('/get_knowledge'))return deleted?Response.json({code:404}):Response.json({code:0,knowledge:item()});
  assert.ok(url.endsWith('/del_knowledge'));assert.deepEqual(q,{knowledge_base_id:nativeId,media_ids:[media_id]});dispatches++;
  if(mode==='unknown')throw Error('upstream secret');
  if(mode==='malformed')return Response.json({});
  if(mode==='nested-error'){deleted=true;return Response.json({code:0,data:{code:9,results:[{media_id,ret_code:0}]}});}
  if(mode==='duplicate-reject')return Response.json({code:0,results:[{media_id,ret_code:9},{media_id,ret_code:0}]});
  if(mode==='duplicate-accept'){deleted=true;return Response.json({code:0,results:[{media_id,ret_code:0},{media_id,ret_code:9}]});}
  if(mode==='reject')return Response.json({code:0,results:[{media_id,ret_code:9}]});
  deleted=true;if(mode==='applied-timeout')throw Error('after applying');
  return Response.json({code:0,results:[{media_id,ret_code:0}]});
 };
 ctx.invoke=async(_,q)=>{
  if(q.action==='kb.get')return {status:'succeeded',data:{knowledge_base:{name:b.kb_name}}};
  if(q.action==='folder.list')return {status:'succeeded',data:{items:list(q.folder_id).map(x=>({...x,kind:x.media_type===99?'folder':'file'})),has_more:false}};
  if(q.action==='media.read'){const content=contents.get(q.media_id);return {status:'succeeded',data:{content,sha256:await sha256(content),size:new TextEncoder().encode(content).length}};}
  throw Error('unexpected action');
 };
 assert.equal((await moveAction('ima_bind_move_workspace',{native_knowledge_base_id:nativeId},ctx)).status,'succeeded');
 const preview=(request_id='delete-1')=>api.contentAction('ima_delete_preview',{request_id,media_id,folder_id:folder},ctx);
 const execute=p=>api.contentAction('ima_delete_execute',{request_id:p.request_id,preview_hash:p.preview_hash},ctx);
 return {env,ctx,b,media_id,folder,contents,preview,execute,dispatches:()=>dispatches,setMode:x=>mode=x,isDeleted:()=>deleted,externallyDelete:()=>deleted=true,setFileType:(name,type)=>{title=name;media_type=type;},setMd5:x=>{md5=x;}};
}

test('knowledge deletion exposes a destructive execute separate from preview and index-updating reconcile',()=>{
 for(const name of ['ima_content_capabilities','ima_edit_preview','ima_edit_execute','ima_delete_preview','ima_delete_execute','ima_delete_reconcile'])assert.ok(TOOLS.find(x=>x.name===name),name);
 assert.equal(TOOLS.find(x=>x.name==='ima_delete_execute').annotations.destructiveHint,true);
 assert.equal(TOOLS.find(x=>x.name==='ima_delete_reconcile').annotations.readOnlyHint,false);
});
test('native deletion backs up exact bytes before one dispatch and retains historical evidence',async()=>{
 const f=await fixture();assert.equal(typeof api.contentAction,'function');const before={media_id:f.media_id,folder_id:f.folder,review_key:'immutable',content_sha256:await sha256(f.contents.get(f.media_id))};await f.ctx.store.put('governance_index','historical',before);
 const p=await f.preview();assert.equal(p.status,'preview',JSON.stringify(p));assert.equal(f.dispatches(),0);
 const r=await f.execute(p);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(f.dispatches(),1);assert.ok(r.backup?.blob_key);assert.equal(await (await f.ctx.blobs.get(r.backup.blob_key)).text(),f.contents.get(f.media_id));
 const row=await f.ctx.store.get('governance_index','historical');const {current_content,...retained}=row;assert.deepEqual(retained,before);assert.equal(current_content.state,'deleted_from_knowledge_base');
 assert.equal((await f.execute(p)).replayed,true);assert.equal(f.dispatches(),1);f.env.close();
});
test('stale hash, reused requests and a bad preview hash never delete',async()=>{
 const f=await fixture(),p=await f.preview('stale');
 assert.equal((await f.execute({...p,preview_hash:'0'.repeat(64)})).status,'conflict');
 f.contents.set(f.media_id,'外部已修改');assert.equal((await f.execute(p)).status,'conflict');assert.equal(f.dispatches(),0);
 const reused=await api.contentAction('ima_delete_preview',{request_id:'stale',media_id:f.media_id,folder_id:'different'},f.ctx);assert.equal(reused.status,'conflict');f.env.close();
});
test('uncertain deletion never resubmits and keeps the library fenced until readback',async()=>{
 const f=await fixture(),p=await f.preview('unknown');f.setMode('unknown');assert.equal((await f.execute(p)).status,'unknown');assert.equal((await f.execute(p)).status,'unknown');assert.equal(f.dispatches(),1);
 assert.equal((await api.contentAction('ima_delete_reconcile',{request_id:p.request_id},f.ctx)).status,'unknown');assert.equal(f.dispatches(),1);assert.equal((await f.preview('other')).status,'conflict');f.env.close();
});
test('an applied timeout is reconciled by scanning the complete bound library, without another mutation',async()=>{
 const f=await fixture(),p=await f.preview('timeout');f.setMode('applied-timeout');const r=await f.execute(p);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(f.dispatches(),1);assert.equal(r.verification.complete_library_absence,true);f.env.close();
});
test('backup failure prevents dispatch, definite rejection preserves original and releases the fence',async()=>{
 const f=await fixture(),p=await f.preview('backup');const put=f.ctx.blobs.put;f.ctx.blobs.put=async()=>{throw Error('storage failed');};assert.notEqual((await f.execute(p)).status,'succeeded');assert.equal(f.dispatches(),0);f.ctx.blobs.put=put;
 f.setMode('reject');const r=await f.execute(p);assert.equal(r.status,'rejected',JSON.stringify(r));assert.equal(f.isDeleted(),false);assert.equal((await f.preview('next')).status,'preview');f.env.close();
});
test('same-ID editing stays fail-closed and never uses upload, create, copy or delete as replacement',async()=>{
 const f=await fixture();const p=await api.contentAction('ima_edit_preview',{request_id:'edit',media_id:f.media_id,folder_id:f.folder,new_content:'# 新正文\n'},f.ctx);assert.equal(p.status,'preview',JSON.stringify(p));assert.equal(p.execution_enabled,false);assert.equal(p.preview.original.sha256,await sha256(f.contents.get(f.media_id)));
 const r=await api.contentAction('ima_edit_execute',{request_id:'edit',preview_hash:p.preview_hash},f.ctx);assert.equal(r.status,'unsupported');assert.equal(f.dispatches(),0);assert.equal(f.isDeleted(),false);f.env.close();
});

test('formal delete cannot dispatch without independently verified isolated acceptance',async()=>{
 const f=await fixture(),p=await f.preview('formal-gate');f.ctx.workspace='formal';
 const binding=await f.ctx.baseStore.get('native_move_bindings',await sha256(f.env.IMA_OPENAPI_CLIENTID)+':isolated');
 await f.ctx.baseStore.put('native_move_bindings',await sha256(f.env.IMA_OPENAPI_CLIENTID)+':formal',binding);
 const r=await f.execute(p);assert.equal(r.message,'ima_content_isolated_delete_acceptance_required');assert.equal(f.dispatches(),0);f.env.close();
});
test('incomplete whole-library scans keep the original request pending and cannot release a false success',async()=>{
 const f=await fixture(),p=await f.preview('incomplete'),invoke=f.ctx.invoke;
 f.ctx.invoke=async(domain,q)=>q.action==='folder.list'&&!q.folder_id?{status:'succeeded',data:{items:[],has_more:true}}:invoke(domain,q);
 const r=await f.execute(p);assert.equal(r.status,'verification_pending');assert.equal(r.index_synchronized,false);assert.equal(f.dispatches(),1);
 f.ctx.invoke=invoke;const final=await api.contentAction('ima_delete_reconcile',{request_id:p.request_id},f.ctx);assert.equal(final.status,'succeeded',JSON.stringify(final));assert.equal(f.dispatches(),1);f.env.close();
});
test('deleted media projections also apply to late historical rows without changing their reviewed snapshot',async()=>{
 const f=await fixture(),p=await f.preview('late-index');assert.equal((await f.execute(p)).status,'succeeded');
 const historical={media_id:f.media_id,review_key:'original',content_sha256:await sha256(f.contents.get(f.media_id))};
 const projected=await projectCurrentLocation(f.ctx,historical,f.b.kb_id);assert.equal(projected.current_content.state,'deleted_from_knowledge_base');const {current_content,...rest}=projected;assert.deepEqual(rest,historical);f.env.close();
});

test('malformed provider response is unknown, never a definite rejection that releases the library',async()=>{
 const f=await fixture(),p=await f.preview('malformed');f.setMode('malformed');assert.equal((await f.execute(p)).status,'unknown');assert.equal((await f.preview('next')).status,'conflict');assert.equal(f.dispatches(),1);f.env.close();
});
test('deletion respects the workspace write-disable switch before any native dispatch',async()=>{
 const f=await fixture(),p=await f.preview('disabled');await f.ctx.store.put('settings','service',{publication_enabled:false});const r=await f.execute(p);assert.equal(r.status,'blocked');assert.equal(f.dispatches(),0);f.env.close();
});
test('a TXT upload with native media type 13 is supported',async()=>{
 const f=await fixture();f.setFileType('sample.txt',13);const p=await f.preview('txt');assert.equal(p.status,'preview',JSON.stringify(p));assert.equal((await f.execute(p)).status,'succeeded');f.env.close();
});
test('observed absence without a native success receipt never counts as isolated delete acceptance',async()=>{
 const f=await fixture(),p=await f.preview('no-dispatch'),touch=f.ctx.baseStore.touchLease.bind(f.ctx.baseStore);let failed=false;
 f.ctx.baseStore.touchLease=async lease=>{const row=await f.ctx.store.get('content_operations',p.request_id);if(row?.status==='unknown'&&!failed){failed=true;throw Error('injected before native dispatch');}return touch(lease);};
 await f.execute(p);assert.equal(f.dispatches(),0);f.externallyDelete();assert.equal((await api.contentAction('ima_delete_reconcile',{request_id:p.request_id},f.ctx)).status,'succeeded');
 const capability=await api.contentAction('ima_content_capabilities',{},f.ctx);assert.equal(capability.formal_delete_enabled,false);f.env.close();
});
test('an expired preparer cannot release the owner safely resumed by the next execution generation',async()=>{
 const f=await fixture(),p=await f.preview('lease-generation');f.setMode('unknown');let resume,paused;const ready=new Promise(r=>paused=r),gate=new Promise(r=>resume=r);const get=f.ctx.store.get.bind(f.ctx.store);let intercepted=false;
 f.ctx.store.get=async(c,k)=>{const value=await get(c,k);if(c==='content_backups'&&k===p.request_id&&!intercepted){intercepted=true;paused();await gate;}return value;};
 const first=f.execute(p);await ready;
 const lease=(await f.ctx.baseStore.list('locks',{limit:100})).items.find(x=>x.value.lease);assert.ok(lease);await f.ctx.baseStore.put('locks',lease.key,{...lease.value,expires_at:Date.now()-1});
 const second=await f.execute(p);resume();await first;
 assert.equal(second.status,'unknown',JSON.stringify(second));assert.equal(f.dispatches(),1);const active=await f.ctx.baseStore.get('native_content_active',await sha256(f.env.IMA_OPENAPI_CLIENTID)+':'+f.b.kb_id);assert.equal(active.resolved,false);assert.equal((await f.ctx.baseStore.get('locks',active.resource_key)).request_id,active.lock_owner);f.env.close();
});

test('nested contradictory codes and duplicate item receipts never certify native delete acceptance',async()=>{
 for(const mode of ['nested-error','duplicate-accept','duplicate-reject']){const f=await fixture(),p=await f.preview(mode);f.setMode(mode);const r=await f.execute(p);
  assert.equal(r.provider_result?.status,'unknown');assert.equal((await api.contentAction('ima_content_capabilities',{},f.ctx)).formal_delete_enabled,false);
  if(mode==='duplicate-reject'){assert.equal(r.status,'unknown');assert.equal((await f.preview('another')).status,'conflict');}f.env.close();}
});
test('a write-disable or migration freeze during backup is rechecked at the dispatch boundary',async()=>{
 for(const setting of ['publication','migration']){const f=await fixture(),p=await f.preview(setting),put=f.ctx.blobs.put;let applied=false;
  f.ctx.blobs.put=async(...args)=>{const r=await put(...args);if(!applied&&args[0].startsWith('content-backups/')){applied=true;if(setting==='publication')await f.ctx.store.put('settings','service',{publication_enabled:false});else await f.ctx.baseStore.put('settings','migration',{frozen:true});}return r;};
  assert.equal((await f.execute(p)).status,'blocked');assert.equal(f.dispatches(),0);f.env.close();}
});

test('administrative close and migration freeze cannot cross an in-flight native dispatch boundary',async()=>{
 for(const action of [{action:'publication',enabled:false},{action:'begin',migration_id:'freeze-during-dispatch',manifest_hash:'hash'}]){const f=await fixture(),p=await f.preview(action.action),fetcher=f.ctx.nativeFetcher;let observed=false;
  const admin={...f.ctx,workspace:'formal',store:f.ctx.baseStore};
  f.ctx.nativeFetcher=async(url,options)=>{if(url.endsWith('/del_knowledge')){await assert.rejects(()=>adminAction(action,admin),error=>error.status==='conflict');observed=true;}return fetcher(url,options);};
  assert.equal((await f.execute(p)).status,'succeeded');assert.equal(observed,true);assert.equal((await adminAction(action,admin)).status,'succeeded');assert.equal(f.dispatches(),1);f.env.close();}
});

test('an asynchronously filled md5 does not stale an undispatched delete preview',async()=>{
 const f=await fixture();f.setMd5('');const p=await f.preview('delete-md5-fill');assert.equal(p.status,'preview',JSON.stringify(p));
 f.setMd5('filled-after-preview');
 const r=await f.execute(p);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(f.isDeleted(),true);assert.equal(f.dispatches(),1);f.env.close();
});
