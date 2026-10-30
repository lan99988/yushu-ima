import test from 'node:test';
import assert from 'node:assert/strict';
import {context,contract} from './fixtures/cloud-context.mjs';
import {knowledgeAction,knowledgeTools,knowledgeTransportAllowed} from '../worker/knowledge.js';
import {context as runtimeContext} from '../worker/app.js';
import {runtime} from './fixtures/runtime.mjs';
import {sessionAction} from '../worker/ima-session.js';
import {moveAction} from '../worker/moves.js';
import {sha256,stable} from '../worker/storage.js';

const draft=(id,key=id,type='concept')=>({action:'ingest',request_id:id,policy_version:'2.0.0',mode:'organize',object:{key,type},material:{source_id:id,locator:'全文',content:'完整原文 '+id,kind:'opinion',author:'作者',context:'测试'},entry:{title:id,primary_category:'learning',body:'完整知识 '+id,tags:[id],aliases:['别名'+id]},expected_version:0,execute:true});
async function fixture(count=2){
 const env={...runtime(),IMA_SESSION_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')},c=runtimeContext(env,'isolated');
 const bindings={...structuredClone(contract.bindings),account_sha256:await sha256(env.IMA_OPENAPI_CLIENTID)};
 await c.store.put('settings','bindings',bindings);await c.store.put('settings','policy',contract.policy);
 await c.baseStore.put('settings','bindings',{...bindings,kb_id:'formal-kb'});await c.baseStore.put('settings','service',{ready:true,publication_enabled:true});await c.store.put('settings','service',{publication_enabled:true});
 await sessionAction('install',{installation_id:'consolidation-test-0001',account_info:{userId:'test-user',token:'access',refreshToken:'refresh',tokenExpiredTime:Date.now()+7200000,refreshTokenExpiredTime:Date.now()+86400000}},c);
 c.sessionFetcher=async()=>Response.json({code:0,token:'renewed',token_valid_time:7200});await sessionAction('verify',{},c);
 const remote=new Map(),files=new Map(),calls=[],nativeId='7000000000000002',folder=bindings.categories.learning.folder_id;c.remote=remote;c.calls=calls;c.files=files;c.envClose=env.close;c.deletes=0;c.deleteMode='success';
 const roots=Object.values(bindings.categories).map(x=>({media_id:x.folder_id,title:x.folder_name,media_type:99,parent_folder_id:nativeId,file_size:'0',md5_sum:''}));
 const list=id=>id?[...files.values()].filter(x=>x.parent_folder_id===id):roots;
 c.nativeFetcher=async(url,options)=>{const q=JSON.parse(options.body);
  if(url.endsWith('/get_knowledge_list'))return Response.json({code:0,knowledge_base_info:{id:nativeId},current_path:[{folder_id:nativeId,name:bindings.kb_name,parent_folder_id:''},...(q.folder_id?[{folder_id:q.folder_id,name:roots.find(x=>x.media_id===q.folder_id).title,parent_folder_id:nativeId}]:[])],knowledge_list:list(q.folder_id),is_end:true});
  if(url.endsWith('/get_knowledge'))return Response.json({code:0,knowledge:files.get(q.media_id)});
  assert.ok(url.endsWith('/del_knowledge'));c.deletes++;if(c.deleteMode==='unknown')throw Error('timeout');for(const id of q.media_ids)files.delete(id);return Response.json({code:0,results:q.media_ids.map(media_id=>({media_id,ret_code:0}))});
 };
 c.invoke=async(d,q)=>{calls.push({domain:d,q:structuredClone(q)});
  if(q.action==='kb.get')return {status:'succeeded',data:{knowledge_base:{name:bindings.kb_name}}};
  if(q.action==='folder.list')return {status:'succeeded',data:{items:list(q.folder_id).map(x=>({...x,kind:x.media_type===99?'folder':'file'})),has_more:false}};
  if(q.action==='media.read'){const content=c.badReadback&&q.media_id===c.lastMedia?'wrong':remote.get(q.media_id);return {status:'succeeded',data:{content,size:new TextEncoder().encode(content).length,sha256:await sha256(content)}};}
  if(q.action==='text.create'&&q.reconcile)return (await c.store.get('operations',q.request_id))?.receipt||{status:'unknown'};
  if(q.action==='text.create'){
   if(c.createMode==='unknown')return {status:'unknown'};
   const media_id='media-'+remote.size;c.lastMedia=media_id;remote.set(media_id,q.content);files.set(media_id,{media_id,title:q.filename,media_type:7,parent_folder_id:q.folder_id,file_size:String(new TextEncoder().encode(q.content).length),md5_sum:''});
   const receipt={status:'succeeded',request_id:q.request_id,resource:{kb_id:q.kb_id,folder_id:q.folder_id,filename:q.filename,content_sha256:await sha256(q.content),media_ids:[media_id]}};
   const request=Object.fromEntries(Object.entries(q).filter(([k])=>!['execute','reconcile'].includes(k)));
   await c.store.put('operations',q.request_id,{request,fingerprint:await sha256(stable(request,true)+bindings.account_sha256),status:'succeeded',receipt});return receipt;
  }
  throw Error('unexpected '+q.action);
 };
 assert.equal((await moveAction('ima_bind_move_workspace',{native_knowledge_base_id:nativeId},c)).status,'succeeded');
 const objects=[];for(let i=0;i<count;i++){const r=await knowledgeAction(draft('source'+i,'key'+i,i===0?'question':'concept'),c);assert.equal(r.status,'succeeded',JSON.stringify(r));objects.push(r.object);}
 const sources=await Promise.all(objects.map(async o=>({object_key:o.object_key,entry_id:o.entry_id,revision:o.revision,media_id:o.media_id,folder_id:contract.bindings.categories.learning.folder_id,sha256:await sha256(remote.get(o.media_id))})));
 const q={...draft('merge','key'+(count-1)),action:'consolidate',expected_version:1,merge_sources:sources,execute:false};
 return {c,q,objects,sources};
}
test('consolidate advertises the backend schema',()=>assert.ok(knowledgeTools.some(t=>t.name==='ima_knowledge_consolidate')));
test('preview is stable, binds all current sources, and creates no transport or content mutations',async()=>{
 const {c,q}=await fixture(),calls=c.calls.length;
 const p=await knowledgeAction(q,c);assert.equal(p.status,'preview',JSON.stringify(p));assert.match(p.preview_hash,/^[a-f0-9]{64}$/);assert.equal(p.master_key,'key1');assert.deepEqual(p.delete_media_ids,q.merge_sources.map(x=>x.media_id));
 assert.equal((await knowledgeAction(q,c)).preview_hash,p.preview_hash);assert.equal(c.calls.slice(calls).some(x=>x.q.execute),false);assert.equal((await c.store.list('content_operations')).items.length,0);
});
test('execution requires preview hash and concrete multi-card confirmation',async()=>{
 const {c,q}=await fixture(),p=await knowledgeAction(q,c);
 assert.equal((await knowledgeAction({...q,execute:true},c)).status,'conflict');
 assert.equal((await knowledgeAction({...q,execute:true,preview_hash:p.preview_hash,confirmation:'yes'},c)).status,'blocked');
});
test('preview rejects stale versions, source hash mismatch, omitted target and unregistered media',async()=>{
 for(const change of [q=>q.expected_version=0,q=>q.merge_sources[0].sha256='0'.repeat(64),q=>q.merge_sources.pop(),q=>q.merge_sources[0].object_key='unregistered']){
  const {c,q}=await fixture();change(q);const p=await knowledgeAction(q,c);assert.ok(['blocked','conflict'].includes(p.status),JSON.stringify(p));
 }
});
test('ordinary update previews preserve stable master and do not demand multi-card confirmation',async()=>{
 const {c,q}=await fixture(1);q.object.type='question';const p=await knowledgeAction(q,c);assert.equal(p.status,'preview',JSON.stringify(p));assert.equal(p.requires_confirmation,false);assert.equal(p.master_key,'key0');
});

export {fixture,draft};

const execute=(q,p)=>({...q,execute:true,preview_hash:p.preview_hash,...(p.requires_confirmation?{confirmation:{text:'确认合并这些具体卡片并移除旧卡',preview_hash:p.preview_hash,delete_media_ids:p.delete_media_ids}}:{})});
test('happy merge verifies backups and new readback, migrates backlinks and preserves aliases/history',async()=>{
 const {c,q,objects}=await fixture();
 const child=draft('child','child');child.object.parent_key='key0';child.object.relations=[{target_key:'key0',relation:'关联',reason:'完整原因'}];await knowledgeAction(child,c);
 const p=await knowledgeAction(q,c),r=await knowledgeAction(execute(q,p),c);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(c.deletes,2);assert.equal(r.object.entry_id,objects[1].entry_id);assert.equal(r.object.materials.length,3);
 assert.ok(r.object.aliases.includes('别名source0'));assert.ok(r.object.tags.includes('source0'));assert.ok(r.object.history.some(h=>h.object_key==='key0'));
 const old=await knowledgeAction({action:'object.get',object_key:'key0'},c);assert.equal(old.object.object_key,'key1');assert.equal(old.resolved_from,'key0');assert.equal((await c.store.get('knowledge_objects','key0')).merged_into,'key1');
 const incoming=(await knowledgeAction({action:'object.get',object_key:'child'},c)).object;assert.equal(incoming.parent_key,'key1');assert.equal(incoming.relations[0].target_key,'key1');
 const found=await knowledgeAction({action:'object.search',query:'别名source0'},c);assert.deepEqual(found.items.map(x=>x.object_key),['key1']);
 const update=draft('forbidden','key0','question');update.expected_version=1;assert.equal((await knowledgeAction(update,c)).status,'conflict');
 assert.equal((await knowledgeAction({...execute(q,p),reconcile:true},c)).status,'succeeded');assert.equal(c.deletes,2);
});
test('ordinary consolidate update removes old media without extra confirmation',async()=>{
 const {c,q,objects}=await fixture(1);q.object.type='question';const p=await knowledgeAction(q,c),r=await knowledgeAction(execute(q,p),c);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(r.object.entry_id,objects[0].entry_id);assert.equal(c.deletes,1);assert.equal(r.object.filename,q.entry.title+'.md');
});
test('unknown creation and deletion never redispatch under replay or reconcile',async()=>{
 for(const phase of ['create','delete']){const {c,q}=await fixture();const p=await knowledgeAction(q,c);c[phase+'Mode']='unknown';const args=execute(q,p);const first=await knowledgeAction(args,c);assert.equal(first.status,'unknown',JSON.stringify(first));const count=c.calls.filter(x=>x.q.action==='text.create'&&!x.q.reconcile).length,deletes=c.deletes;
  await knowledgeAction(args,c);await knowledgeAction({...args,reconcile:true},c);assert.equal(c.calls.filter(x=>x.q.action==='text.create'&&!x.q.reconcile).length,count);assert.equal(c.deletes,deletes);
 }
});
test('backup failure and new body readback failure prevent every native deletion',async()=>{
 for(const phase of ['backup','readback']){const {c,q}=await fixture();const p=await knowledgeAction(q,c);if(phase==='backup')c.blobs.put=async()=>{throw Error('storage down');};else c.badReadback=true;
  assert.notEqual((await knowledgeAction(execute(q,p),c)).status,'succeeded');assert.equal(c.deletes,0);
 }
});
test('reconcile of an unexecuted preview never activates even with confirmation',async()=>{
 const {c,q}=await fixture(),p=await knowledgeAction(q,c),calls=c.calls.length;
 const r=await knowledgeAction({...execute(q,p),reconcile:true},c);assert.equal(r.status,'preview');assert.equal(c.deletes,0);assert.equal(c.calls.slice(calls).some(x=>x.q.execute),false);
});
test('master keeps omitted parent and its old title as an alias after rename',async()=>{
 const {c,q}=await fixture(1),parent=draft('parent','parent');await knowledgeAction(parent,c);
 const row=await c.store.get('knowledge_objects','key0');await c.store.put('knowledge_objects','key0',{...row,parent_key:'parent'});q.object.type='question';q.entry.title='改名';
 const p=await knowledgeAction(q,c);assert.equal(p.status,'preview',JSON.stringify(p));assert.equal(p.object.parent_key,'parent');assert.ok(p.object.aliases.includes('source0'));
});
test('pending consolidation gates every new ingest including archive but allows historic receipts',async()=>{
 const {c,q}=await fixture(),p=await knowledgeAction(q,c);c.createMode='unknown';await knowledgeAction(execute(q,p),c);
 assert.equal((await knowledgeAction(draft('unrelated','new'),c)).status,'conflict');
 const archive={...draft('archive'),mode:'archive'};assert.equal((await knowledgeAction(archive,c)).status,'conflict');
 assert.equal((await knowledgeAction({...draft('source0','key0','question'),reconcile:true},c)).status,'succeeded');
});
test('long delayed deletion recovery rechecks master bytes before cleaning any other source',async()=>{
 const {c,q}=await fixture(),p=await knowledgeAction(q,c);c.deleteMode='unknown';const args=execute(q,p);await knowledgeAction(args,c);const deletes=c.deletes;
 const op=await c.store.get('knowledge_consolidations',q.request_id);c.remote.set(op.object.media_id,'外部损坏');
 const r=await knowledgeAction({...args,reconcile:true},c);assert.equal(r.status,'verification_pending',JSON.stringify(r));assert.equal(c.deletes,deletes);
});
test('successful replay repairs a failed final active-fence write',async()=>{
 const {c,q}=await fixture(),p=await knowledgeAction(q,c);await knowledgeAction(execute(q,p),c);
 await c.store.put('settings','knowledge_consolidation_active',{request_id:q.request_id,resolved:false});
 assert.equal((await knowledgeAction({...execute(q,p),reconcile:true},c)).status,'succeeded');assert.equal((await c.store.get('settings','knowledge_consolidation_active')).resolved,true);
});
test('source count, merged metadata and rendered body limits fail before any upload',async()=>{
 const {c,q}=await fixture();q.entry.body='大'.repeat(360000);const p=await knowledgeAction(q,c);assert.equal(p.status,'blocked',p.message);assert.equal(c.deletes,0);
});
test('question to concept is allowed only through concrete consolidation confirmation',async()=>{
 const {c,q}=await fixture(1);q.object.type='concept';const p=await knowledgeAction(q,c);assert.equal(p.status,'preview');assert.equal(p.requires_confirmation,true);
 assert.equal((await knowledgeAction({...q,execute:true,preview_hash:p.preview_hash},c)).status,'blocked');assert.equal((await knowledgeAction(execute(q,p),c)).status,'succeeded');
 const oldIngest=draft('wrong-type','key0','question');oldIngest.expected_version=2;assert.equal((await knowledgeAction(oldIngest,c)).status,'conflict');
});
test('raw note associations and writes cannot bypass the active consolidation fence',async()=>{
 const {c,q}=await fixture(),p=await knowledgeAction(q,c);c.createMode='unknown';await knowledgeAction(execute(q,p),c);
 assert.equal(await knowledgeTransportAllowed(c,'kb',{action:'note.associate',request_id:'rogue',execute:true}),false);
 assert.equal(await knowledgeTransportAllowed(c,'notes',{action:'append',request_id:'rogue',execute:true}),false);
 assert.equal(await knowledgeTransportAllowed(c,'kb',{action:'media.read',media_id:'anything'}),true);
});
test('an older nonconcept keeps its identity when there is no canonical concept',async()=>{
 const {c,q}=await fixture();for(const key of ['key0','key1']){const o=await c.store.get('knowledge_objects',key);await c.store.put('knowledge_objects',key,{...o,type:'question',created_at:key==='key0'?'2026-10-01T02:00:00Z':'2026-10-01T01:00:00Z'});}
 q.object.type='question';const p=await knowledgeAction(q,c);assert.equal(p.status,'preview',JSON.stringify(p));assert.equal(p.master_key,'key1');
});
test('a second consolidate resolves historical aliases and projections transitively',async()=>{
 const {c,q}=await fixture(),p=await knowledgeAction(q,c),first=await knowledgeAction(execute(q,p),c);assert.equal(first.status,'succeeded');
 const next={...q,request_id:'merge-again',expected_version:2,object:{...q.object,key:first.master_key},material:{...q.material,source_id:'next'},entry:{...q.entry,body:'第二次完整续版'},merge_sources:[{object_key:first.master_key,media_id:first.object.media_id,folder_id:contract.bindings.categories.learning.folder_id,sha256:await sha256(c.remote.get(first.object.media_id))}]};
 const secondPreview=await knowledgeAction(next,c),second=await knowledgeAction(execute(next,secondPreview),c);assert.equal(second.status,'succeeded',JSON.stringify(second));
 assert.equal((await knowledgeAction({action:'object.get',object_key:'key0'},c)).object.revision,3);
 for(const {value} of (await c.store.list('governance_index')).items)assert.equal(value.current_content?.media_id||value.media_id,second.object.media_id);
});
test('a real final fence persistence failure retains succeeded for idempotent cleanup',async()=>{
 const {c,q}=await fixture(),p=await knowledgeAction(q,c),write=c.baseStore.fencedWrite.bind(c.baseStore);let failed=false;
 c.baseStore.fencedWrite=async(method,col,key,value,...args)=>{if(col==='test_settings'&&key==='knowledge_consolidation_active'&&value?.resolved&&!failed){failed=true;throw Error('crash after success');}return write(method,col,key,value,...args);};
 await knowledgeAction(execute(q,p),c);assert.equal(failed,true);assert.equal((await c.store.get('knowledge_consolidations','merge')).status,'succeeded');
 assert.equal((await knowledgeAction({...execute(q,p),reconcile:true},c)).status,'succeeded');assert.equal((await c.store.get('settings','knowledge_consolidation_active')).resolved,true);
});
test('every persisted phase resumes under the same child and deletion request IDs',async()=>{
 for(const phase of ['backups','ingest','readback_verified','migrated','deleting','projections']){
  const {c,q}=await fixture(),p=await knowledgeAction(q,c),write=c.baseStore.fencedWrite.bind(c.baseStore);let interrupted=false;
  c.baseStore.fencedWrite=async(method,col,key,value,...args)=>{if(col==='test_knowledge_consolidations'&&value?.phase===phase&&!interrupted){interrupted=true;throw Error('injected phase crash');}return write(method,col,key,value,...args);};
  const args=execute(q,p);await knowledgeAction(args,c);assert.equal(interrupted,true,phase);
  const final=await knowledgeAction({...args,reconcile:true},c);assert.equal(final.status,'succeeded',phase+': '+JSON.stringify(final));assert.equal(c.deletes,2,phase);
  assert.equal(c.calls.filter(x=>x.q.action==='text.create'&&!x.q.reconcile).length,3,phase);
 }
});
test('formal capability and corrupt archived materials block cleanup without creating a new master',async()=>{
 for(const kind of ['formal','material']){const {c,q,objects}=await fixture(),p=await knowledgeAction(q,c),count=c.remote.size;
  if(kind==='formal')c.workspace='formal';else await c.blobs.put(objects[0].materials[0].blob_key,'corrupted');
  const r=await knowledgeAction(execute(q,p),c);assert.ok(['blocked','verification_pending'].includes(r.status),JSON.stringify(r));assert.equal(c.remote.size,count);assert.equal(c.deletes,0);
 }
});
test('parent cycles, mismatched confirmation lists and post-preview source drift fail closed',async()=>{
 const {c,q}=await fixture(),p=await knowledgeAction(q,c),args=execute(q,p);args.confirmation.delete_media_ids=[q.merge_sources[0].media_id];assert.equal((await knowledgeAction(args,c)).status,'blocked');
 const valid=execute(q,p);c.remote.set(q.merge_sources[0].media_id,'source drift');assert.equal((await knowledgeAction(valid,c)).status,'conflict');assert.equal(c.deletes,0);
 const other=await fixture();const o=await other.c.store.get('knowledge_objects','key0');await other.c.store.put('knowledge_objects','key0',{...o,parent_key:'key1'});other.q.object.parent_key='key0';
 // A collapsed direct self edge is removed. A real outside cycle is blocked.
 const child=draft('cycle','cycle');child.object.parent_key='key1';await knowledgeAction(child,other.c);other.q.object.parent_key='cycle';assert.equal((await knowledgeAction(other.q,other.c)).status,'conflict');
});
test('source hashes must also match the governed current snapshot',async()=>{
 const {c,q}=await fixture();c.remote.set(q.merge_sources[0].media_id,'外部改写');q.merge_sources[0].sha256=await sha256('外部改写');assert.equal((await knowledgeAction(q,c)).status,'conflict');
});
test('runtime advertises actual consolidation capability and certifies only a complete isolated merge',async()=>{
 const {c,q}=await fixture();let policy=await knowledgeAction({action:'policy.get'},c);assert.ok(policy.runtime.consolidation,'consolidation runtime capability is required');assert.equal(policy.runtime.consolidation.implemented,true);assert.equal(policy.runtime.consolidation.isolated_acceptance,null);
 const p=await knowledgeAction(q,c);assert.equal((await knowledgeAction(execute(q,p),c)).status,'succeeded');policy=await knowledgeAction({action:'policy.get'},c);
 const proof=policy.runtime.consolidation.isolated_acceptance;assert.equal(policy.runtime.consolidation.acceptance_valid,true);assert.equal(proof.request_id,q.request_id);assert.equal(proof.backups.length,2);assert.equal(proof.deletions.length,2);assert.equal(proof.index_and_relations_verified,true);
 const b=await c.store.get('settings','bindings');b.categories.learning.folder_id='rebound';await c.store.put('settings','bindings',b);policy=await knowledgeAction({action:'policy.get'},c);assert.equal(policy.runtime.consolidation.acceptance_valid,false);assert.equal(policy.runtime.consolidation.isolated_acceptance,null);
});
test('formal execution also requires isolated consolidation acceptance independently of native deletion',async()=>{
 const {c,q}=await fixture(),p=await knowledgeAction(q,c);const binding=await c.baseStore.get('native_move_bindings',await sha256(c.env.IMA_OPENAPI_CLIENTID)+':isolated');
 c.workspace='formal';await c.baseStore.put('native_move_bindings',await sha256(c.env.IMA_OPENAPI_CLIENTID)+':formal',binding);
 const args=execute(q,p),r=await knowledgeAction(args,c);assert.equal(r.status,'blocked');assert.match(r.message,/acceptance_required/);assert.equal(c.deletes,0);
});
test('operation.get exposes actual native subrequest progress without network or lease acquisition',async()=>{
 const {c,q}=await fixture(),p=await knowledgeAction(q,c);c.deleteMode='unknown';await knowledgeAction(execute(q,p),c);const op=await c.store.get('knowledge_consolidations',q.request_id),child=await c.store.get('content_operations',op.deletions[0].request_id);
 child.verification_stage='library_scan_openapi';child.absence_scan={seen:['','folder-a'],queue:['folder-b'],item_count:20,native_listing:{secret_body:'must not be exposed'}};await c.store.put('content_operations',child.request_id,child);
 c.invoke=async()=>{throw Error('operation.get must be local-only');};c.baseStore.acquireLease=async()=>{throw Error('operation.get must not acquire a lease');};
 const r=await knowledgeAction({action:'operation.get',request_id:q.request_id},c);assert.ok(r.progress,'native subrequest progress is required');assert.equal(r.progress.cleaned_count,0);assert.equal(r.progress.children[0].stage,'library_scan_openapi');assert.equal(r.progress.children[0].scan.folders_checked,2);assert.equal(r.progress.children[0].provider_status,'unknown');assert.equal(JSON.stringify(r.progress).includes('secret_body'),false);
});
test('parent replay settles a cached succeeded child before executing the next preview',async()=>{
 const {c,q}=await fixture(),p=await knowledgeAction(q,c),native=c.nativeFetcher;let signal;const firstDone=new Promise(r=>signal=r);let stopNext=false;
 c.nativeFetcher=async(url,options)=>{const r=await native(url,options);if(url.endsWith('/del_knowledge')){const parsed=JSON.parse(options.body);if(parsed.media_ids[0]===q.merge_sources[0].media_id){stopNext=true;signal();}}return r;};
 const read=c.invoke;c.invoke=async(d,request)=>{if(stopNext&&request.action==='media.read'&&request.media_id===q.merge_sources[1].media_id)return {status:'unavailable'};return read(d,request);};
 const args=execute(q,p);await knowledgeAction(args,c);await firstDone;
 const op=await c.store.get('knowledge_consolidations',q.request_id),child=await c.store.get('content_operations',op.deletions[0].request_id);assert.equal(child.status,'succeeded');assert.equal(op.deletions[0].receipt.status,'succeeded');
 const resource=stable({domain:'knowledge',note_id:'ima-kb:'+child.snapshot.kb_id},true),account=await sha256(c.env.IMA_OPENAPI_CLIENTID);await c.baseStore.acquireLock(resource,child.dispatch_owner);await c.baseStore.put('native_content_active',account+':'+child.snapshot.kb_id,{request_id:child.request_id,resource_key:resource,lock_owner:child.dispatch_owner,resolved:true});
 stopNext=false;const r=await knowledgeAction({...args,reconcile:true},c);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(c.deletes,2);
});
