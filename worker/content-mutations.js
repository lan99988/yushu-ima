import {sha256,stable,withServiceControls} from './storage.js';
import {nativeWorkspaceEnvironment,readNativeFolder} from './moves.js';
import {nativeContentRead,nativeDeleteKnowledge,isolatedContentInspection,readTextOriginal as original} from './native-content.js';
import {collectionRows,withMovePublicationLease,resolveCurrentContent} from './move-index.js';
import {scopedStore} from './admin.js';
import {revisionArtifact,registerReplacement,replacementForDelete,finishReplacement,replacementProof} from './replacements.js';

const text={type:'string',minLength:1,maxLength:500},hash={type:'string',pattern:'^[a-f0-9]{64}$'};
const base={workspace:{type:'string',enum:['formal','isolated']}};
const identity={request_id:text,media_id:text,folder_id:text};
const execution={request_id:text,preview_hash:hash};
function tool(name,description,properties,required,readOnlyHint=false,destructiveHint=false){return {name,description,inputSchema:{type:'object',properties:{...base,...properties},required,additionalProperties:false},annotations:{readOnlyHint,destructiveHint,idempotentHint:true,openWorldHint:true}};}
export const contentTools=[
 tool('ima_content_capabilities','读取真实删除与先新增后删除修订的独立验收状态。same_id_edit_enabled仅指原位写回，不代表replacement_edit_enabled；可对隔离媒体只读检查原对象权限。',{media_id:text},[],true),
 tool('ima_edit_preview','先在私有数据库保存完整修订候选和原文备份，返回replacement_plan中固定新增/删除请求号、文件名及全文。此工具不写ima。新增读回通过后才能用关联删除工具移除旧卡，文件ID会改变。',{...identity,new_content:{type:'string',minLength:1,maxLength:1048576}},Object.keys({...identity,new_content:1})),
 tool('ima_edit_execute','保留兼容的原位编辑入口，仍返回unsupported。先增后删修订必须使用ima_edit_preview返回的ima_create_text_file及独立ima_delete工具，不在本入口隐藏删除。',execution,Object.keys(execution)),
 tool('ima_delete_preview','读取具体卡片原文、身份、目录与SHA256，保存不可变删除预览。仅支持单个Markdown/TXT文件，不删除目录。',identity,Object.keys(identity)),
 tool('ima_delete_execute','用户明确要求删除具体卡片后，核对预览hash，私有备份原文并验证，再仅派发一次原生del_knowledge；不是标题墓碑。正式库需隔离删除验收通过。',execution,Object.keys(execution),false,true),
 tool('ima_delete_reconcile','按原请求通过原生只读接口核对真实删除结果与备份，并同步本服务索引；不重发删除。include_backup可读备份原文。删除表示从知识库移除，不承诺物理清除或原生回收站恢复。',{request_id:text,include_backup:{type:'boolean'}},['request_id']),
];
const root=ctx=>ctx.baseStore||ctx.store;
const now=()=>new Date().toISOString();
const need=(ok,message,status='blocked')=>{if(!ok)throw Object.assign(Error(message),{status});};
const activeKey=e=>e.account+':'+e.b.kb_id;
const projectionKey=(kb_id,media_id)=>stable({kb_id,media_id});
const progress=op=>({stage:op.verification_stage||(['succeeded','rejected'].includes(op.status)?'complete':'source_folder'),scan:{folders_checked:op.absence_scan?.seen?.length||0,pending_folders:op.absence_scan?.queue?.length||0,items_checked:op.absence_scan?.item_count||0,complete:op.absence_scan?.complete===true,current_stage:op.absence_scan?.native_listing?'openapi':'native'},index:{rows_checked:op.index_sync?.rows_checked||0,collection:op.index_sync?.collection_index===1?'cards':'governance_index',complete:op.index_sync?.complete===true},updated_at:op.progress_updated_at||null});
const view=op=>({progress:progress(op),status:op.status,request_id:op.request_id,operation:op.operation,preview_hash:op.preview_hash,preview:op.snapshot,execution_enabled:op.operation==='delete'&&op.execution_enabled===true,backup:op.backup||null,provider_result:op.provider_result||null,verification:op.verification||null,index_synchronized:op.index_synchronized===true,message:op.message||null,...(op.replacement_plan?{replacement_plan:op.replacement_plan}:{}),...(op.replacement?{replacement:op.replacement}:{})});

async function writeGates(ctx,e){
 need(!(await root(ctx).get('settings','migration'))?.frozen,'ima_content_migration_in_progress');
 need((await root(ctx).get('settings','service'))?.ready===true,'ima_content_service_not_ready');
 need((await ctx.store.get('settings','service'))?.publication_enabled===true,'ima_content_workspace_write_disabled');
}
const deleteResource=kb_id=>stable({domain:'knowledge',note_id:'ima-kb:'+kb_id},true);
function exactDeleteOwner(owner,request_id){
 const prefix='native-delete:'+request_id+':';return typeof owner==='string'&&owner.startsWith(prefix)&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner.slice(prefix.length));
}
const undispatchedPreview=op=>op.status==='preview'&&!op.dispatched_at&&!op.dispatch_owner&&!op.provider_result;
export async function nativeDeleteLockBinding(ctx,op){
 if(!op?.snapshot?.kb_id)return null;
 const resource=deleteResource(op.snapshot.kb_id),lock=await root(ctx).get('locks',resource),active=await root(ctx).get('native_content_active',await sha256(ctx.env.IMA_OPENAPI_CLIENTID||'')+':'+op.snapshot.kb_id);
 const exact=exactDeleteOwner(lock?.request_id,op.request_id),boundary=!active||active.resolved===true||active.request_id===op.request_id&&active.lock_owner===lock?.request_id&&active.resource_key===resource;
 return {held:!!lock,owner_matches_current_request:exact,owner_matches_dispatch:!!lock&&lock.request_id===op.dispatch_owner,owner_matches_preparation:!!lock&&lock.request_id===op.preparation?.owner,active_matches_current_request:active?.request_id===op.request_id,active_owns_lock:!!lock&&active?.lock_owner===lock.request_id,active_resolved:active?.resolved===true,recoverable_preview_owner:!!(exact&&undispatchedPreview(op)&&boundary&&(!op.preparation||op.preparation.owner===lock.request_id))};
}
async function reserveDeleteOwner(ctx,e,op){
 need(undispatchedPreview(op),'ima_content_preview_dispatch_state_inconsistent','conflict');
 const resource=deleteResource(e.b.kb_id),lock=await root(ctx).get('locks',resource),active=await root(ctx).get('native_content_active',activeKey(e));
 let owner=op.preparation?.owner;
 if(op.preparation)need(op.preparation.resource_key===resource&&exactDeleteOwner(owner,op.request_id),'ima_content_preparation_identity_mismatch','conflict');
 if(lock){need(exactDeleteOwner(lock.request_id,op.request_id)&&(!owner||owner===lock.request_id),'ima_content_library_write_in_progress','conflict');owner=lock.request_id;}
 owner||='native-delete:'+op.request_id+':'+crypto.randomUUID();
 need(!active||active.resolved===true||active.request_id===op.request_id&&active.lock_owner===owner&&active.resource_key===resource,'ima_content_pending_request_requires_reconcile','conflict');
 op.preparation={owner,resource_key:resource,created_at:op.preparation?.created_at||now()};await ctx.store.put('content_operations',op.request_id,op);return op.preparation;
}
async function preflight(ctx,e,recovery){
 await writeGates(ctx,e);
 const active=await root(ctx).get('native_content_active',activeKey(e));need(!active||active.resolved||recovery&&active.request_id===recovery.request_id&&active.lock_owner===recovery.owner&&active.resource_key===recovery.resource_key,'ima_content_pending_request_requires_reconcile','conflict');
 const moving=await root(ctx).get('native_move_active',activeKey(e));need(!moving||moving.resolved,'ima_content_move_pending','conflict');
}
async function snapshot(ctx,e,q){
 need(!q.media_id.startsWith('folder_')&&!Object.values(e.b.categories).some(x=>x.folder_id===q.media_id),'ima_content_folder_delete_forbidden','invalid_input');
 const list=await readNativeFolder(ctx,e,q.folder_id),item=list.items.find(x=>x.media_id===q.media_id);
 need(item&&item.kind==='file'&&[7,13].includes(item.media_type)&&/\.(?:md|markdown|txt)$/iu.test(item.title),'ima_content_text_file_required','conflict');
 const categories=list.path.filter(x=>Object.values(e.b.categories).some(y=>y.folder_id===x.folder_id));need(categories.length===1,'ima_content_path_outside_bound_roots','conflict');
 const k=await nativeContentRead(ctx,e.current,'knowledge',{knowledge_base_id:e.binding.native_knowledge_base_id,media_id:q.media_id}),identity=k.data?.knowledge;
 need(k.status==='succeeded'&&identity?.media_id===q.media_id&&identity.parent_folder_id===q.folder_id&&identity.title===item.title&&identity.media_type===item.media_type,'ima_content_native_identity_mismatch','conflict');
 const source=await original(ctx,q.media_id);
 need(Number(item.file_size)===source.size,'ima_content_metadata_size_mismatch','conflict');
 const value={kb_id:e.b.kb_id,native_knowledge_base_id:e.binding.native_knowledge_base_id,roots_hash:e.binding.roots_hash,media_id:q.media_id,title:item.title,folder_id:q.folder_id,media_type:item.media_type,path:list.path.map(x=>({folder_id:x.folder_id,name:x.name})),original:{sha256:source.sha256,size:source.size},md5_sum:item.md5_sum||''};
 const replacement=q.request_id?await replacementForDelete(ctx,e,q.request_id,value):null;return {source,value:replacement?{...value,replacement}:value};
}
async function preview(name,q,ctx,e){
 return withMovePublicationLease(ctx,e.b.kb_id,async ctx=>{
  const fingerprint=await sha256(stable(q)),old=await ctx.store.get('content_operations',q.request_id);
  if(old){need(old.fingerprint===fingerprint&&old.native_user_sha256===e.native_user_sha256,'ima_content_request_id_reused','conflict');return view(old);}
  await preflight(ctx,e);const {value,source}=await snapshot(ctx,e,q),operation=name==='ima_edit_preview'?'edit':'delete';
  const op={request_id:q.request_id,operation,fingerprint,native_user_sha256:e.native_user_sha256,status:'preview',created_at:now(),snapshot:value,execution_enabled:operation==='delete'&&(ctx.workspace==='isolated'||await deletionProof(ctx,e))};
  if(operation==='edit'){
   const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
   const revision=await revisionArtifact(source.content,q.new_content,value.title,date),bytes=new TextEncoder().encode(revision.content);need(bytes.length>0&&bytes.length<=1048576,'ima_content_candidate_too_large','invalid_input');
   const key='content-candidates/'+(ctx.workspace||'formal')+'/'+e.account+'/'+await sha256(q.request_id)+'.md';
   await ctx.blobs.put(key,bytes,{contentType:'text/markdown; charset=utf-8'});const saved=await ctx.blobs.get(key);need(saved&&await sha256(new Uint8Array(await saved.arrayBuffer()))===await sha256(bytes),'ima_content_candidate_persistence_failed','verification_pending');
   op.snapshot={...value,candidate:{sha256:await sha256(bytes),size:bytes.length,blob_key:key,filename:revision.filename,...(revision.version?{version:revision.version}:{})}};
   op.backup=await backup(ctx,e,op,source);op.replacement_plan=await registerReplacement(ctx,e,op,revision.content);
   op.message='ima_edit_uses_explicit_create_then_delete';
  }
  op.preview_hash=await sha256(stable({operation,snapshot:op.snapshot,native_user_sha256:op.native_user_sha256}));
  await ctx.store.put('content_operations',q.request_id,op);
  return {...view(op),...(operation==='edit'?{original_content:source.content,proposed_content:op.replacement_plan.create_arguments.content}:{}),deletion_scope:operation==='delete'?'remove_from_knowledge_base':undefined};
 });
}
async function backup(ctx,e,op,source){
 const key='content-backups/'+(ctx.workspace||'formal')+'/'+e.account+'/'+await sha256(op.request_id)+'/original.md';
 await ctx.blobs.put(key,source.bytes,{contentType:'text/markdown; charset=utf-8'});
 const saved=await ctx.blobs.get(key);need(saved&&saved.size===source.size&&await sha256(new Uint8Array(await saved.arrayBuffer()))===source.sha256,'ima_content_backup_verification_failed','verification_pending');
 const record={blob_key:key,sha256:source.sha256,size:source.size,identity:op.snapshot,created_at:now(),restore_supported:false};
 await ctx.store.put('content_backups',op.request_id,record);need(stable(await ctx.store.get('content_backups',op.request_id))===stable(record),'ima_content_backup_record_failed','verification_pending');
 return record;
}
async function validateDelete(ctx,e,op){
 if(ctx.workspace!=='isolated')return;
 // Absence proves current state, but only a native per-item success receipt
 // can certify this implementation's isolated deletion acceptance.
 if(op.provider_result?.status!=='accepted'||op.provider_result.ret_code!==0)return;
 const formal=await root(ctx).get('settings','bindings');need(formal?.kb_id!==e.b.kb_id,'ima_content_isolated_must_be_distinct','conflict');
 const formalNative=await root(ctx).get('native_move_bindings',e.account+':formal');need(!formalNative||formalNative.native_knowledge_base_id!==e.binding.native_knowledge_base_id,'ima_content_isolated_native_must_be_distinct','conflict');
 await root(ctx).put('native_content_validation',e.account,{account_sha256:e.account,native_user_sha256:e.native_user_sha256,isolated_kb_id:e.b.kb_id,isolated_native_id:e.binding.native_knowledge_base_id,roots_hash:e.binding.roots_hash,delete_verified:true,delete_request_id:op.request_id,backup_sha256:op.backup.sha256,verified_at:now()});
}
async function deletionProof(ctx,e){
 const proof=await root(ctx).get('native_content_validation',e.account),binding=await root(ctx).get('native_move_bindings',e.account+':isolated');
 const config=await scopedStore(root(ctx),'isolated').get('settings','bindings');
 return !!(proof?.delete_verified&&proof.account_sha256===e.account&&proof.native_user_sha256===e.native_user_sha256&&binding?.native_user_sha256===e.native_user_sha256&&binding.account_sha256===e.account&&binding.kb_id===config?.kb_id&&binding.roots_hash===await sha256(stable(config.categories))&&binding.kb_id===proof.isolated_kb_id&&binding.native_knowledge_base_id===proof.isolated_native_id&&binding.roots_hash===proof.roots_hash&&(ctx.workspace==='isolated'||e.b.kb_id!==binding.kb_id&&e.binding.native_knowledge_base_id!==binding.native_knowledge_base_id));
}
async function settle(ctx,e,op){
 const active=await root(ctx).get('native_content_active',activeKey(e));if(active?.request_id!==op.request_id||active.lock_owner!==op.dispatch_owner)return;
 if(!active.resolved)need(await root(ctx).compareAndSwap('native_content_active',activeKey(e),active,{...active,resolved:true}),'ima_content_fence_finalization_pending','verification_pending');
 await root(ctx).releaseLock(active.resource_key,active.lock_owner);
}
// Each read is raced against a short request budget. Losing reads are read-only;
// their results cannot publish a checkpoint after the caller releases its lease.
const VERIFY_SLICE_MS=20000,MAX_FOLDERS_PER_SLICE=16;
async function boundedRead(budget,read){
 const remaining=budget.until-Date.now();need(remaining>0,'ima_content_verification_slice_pending','verification_pending');let timer;
 try{return await Promise.race([Promise.resolve().then(read),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('ima_content_verification_slice_pending'),{status:'verification_pending'})),remaining);})]);}finally{clearTimeout(timer);}
}
async function checkpoint(ctx,op,stage){op.verification_stage=stage;op.progress_updated_at=now();await ctx.store.put('content_operations',op.request_id,op);}
async function scanFence(ctx,e,op){
 const active=await root(ctx).get('native_content_active',activeKey(e));
 need(active&&!active.resolved&&active.request_id===op.request_id&&active.lock_owner===op.dispatch_owner,'ima_content_scan_fence_changed','verification_pending');
 const lock=await root(ctx).get('locks',active.resource_key);need(lock?.request_id===active.lock_owner,'ima_content_scan_resource_owner_changed','verification_pending');
 const moving=await root(ctx).get('native_move_active',activeKey(e));need(!moving||moving.resolved,'ima_content_move_pending','verification_pending');
}
function compareListing(e,id,native,api){
 need(native.knowledge_base_id===e.binding.native_knowledge_base_id&&native.path?.at(-1)?.folder_id===(id||e.binding.native_knowledge_base_id),'ima_content_scan_path_mismatch','verification_pending');
 need(api.status==='succeeded'&&api.data?.has_more===false&&Array.isArray(api.data.items),'ima_content_library_scan_incomplete','verification_pending');
 const shape=items=>items.map(x=>({media_id:x.media_id,title:x.title,kind:x.kind})).sort((a,b)=>a.media_id.localeCompare(b.media_id));
 need(stable(shape(native.items))===stable(shape(api.data.items)),'ima_content_native_openapi_scan_mismatch','verification_pending');
}
async function sourcePresent(ctx,e,op,budget){
 if(op.source_absence_verified_at)return false;
 op.source_probe||={};const probe=op.source_probe,id=op.snapshot.folder_id;
 await scanFence(ctx,e,op);
 if(!probe.native_listing){await checkpoint(ctx,op,'source_folder_native');probe.native_listing=await boundedRead(budget,()=>e.client.list(e.binding.native_knowledge_base_id,id));await checkpoint(ctx,op,'source_folder_openapi');}
 const api=await boundedRead(budget,()=>ctx.invoke('kb',{action:'folder.list',kb_id:e.b.kb_id,folder_id:id}));
 try{compareListing(e,id,probe.native_listing,api);}catch(error){if(error.message==='ima_content_native_openapi_scan_mismatch')delete probe.native_listing;throw error;}
 const exists=probe.native_listing.items.some(x=>x.media_id===op.snapshot.media_id);delete op.source_probe;
 if(!exists)op.source_absence_verified_at=now();await checkpoint(ctx,op,exists?'source_still_present':'library_scan_native');return exists;
}
async function absentFromLibrary(ctx,e,op,budget){
 // Legacy unknown operations have no cursor: initialize one without changing
 // their provider receipt, snapshot, backup or original dispatch identity.
 op.absence_scan||={version:1,owner:op.dispatch_owner,queue:[''],seen:[],item_count:0,complete:false};const scan=op.absence_scan;
 need(scan.version===1&&scan.owner===op.dispatch_owner,'ima_content_scan_identity_changed','verification_pending');
 let checked=0;
 while(scan.queue.length){
  if(checked>=MAX_FOLDERS_PER_SLICE||Date.now()>=budget.until){await checkpoint(ctx,op,scan.native_listing?'library_scan_openapi':'library_scan_native');return null;}
  await scanFence(ctx,e,op);const id=scan.queue[0];need(!scan.seen.includes(id)&&scan.seen.length<500,'ima_content_library_scan_limit','verification_pending');
  if(!scan.native_listing){await checkpoint(ctx,op,'library_scan_native');scan.native_listing=await boundedRead(budget,()=>e.client.list(e.binding.native_knowledge_base_id,id));await checkpoint(ctx,op,'library_scan_openapi');}
  const api=await boundedRead(budget,()=>ctx.invoke('kb',{action:'folder.list',kb_id:e.b.kb_id,folder_id:id}));
  try{compareListing(e,id,scan.native_listing,api);}catch(error){if(error.message==='ima_content_native_openapi_scan_mismatch')delete scan.native_listing;throw error;}
  await scanFence(ctx,e,op);
  const items=scan.native_listing.items;need(scan.item_count+items.length<=2000,'ima_content_library_scan_limit','verification_pending');
  if(items.some(item=>item.media_id===op.snapshot.media_id)){delete op.absence_scan;delete op.source_absence_verified_at;await checkpoint(ctx,op,'source_found_elsewhere');return false;}
  const folders=items.filter(x=>x.kind==='folder').map(x=>x.media_id);
  need(folders.every(folder=>!scan.seen.includes(folder)&&!scan.queue.includes(folder))&&new Set(folders).size===folders.length,'ima_content_library_scan_cycle','verification_pending');
  scan.item_count+=items.length;scan.seen.push(id);scan.queue.shift();scan.queue.push(...folders);delete scan.native_listing;checked++;
  await checkpoint(ctx,op,'library_scan_native');
 }
 scan.complete=true;await checkpoint(ctx,op,'backup_verification');return true;
}
async function synchronizeDeletion(ctx,e,op,budget){
 let current=op.deletion_projection;
 if(!current){
  const prior=await ctx.store.get('media_content_states',projectionKey(e.b.kb_id,op.snapshot.media_id));
  current={...prior,state:'deleted_from_knowledge_base',kb_id:e.b.kb_id,media_id:op.snapshot.media_id,original_sha256:op.snapshot.original.sha256,request_id:op.request_id,backup_blob_key:op.backup.blob_key,verified_at:now(),physically_erased:false};
  op.deletion_projection=current;
 }
 await ctx.store.put('media_content_states',projectionKey(e.b.kb_id,op.snapshot.media_id),current);
 op.index_sync||={collection_index:0,cursor:'',offset:0,rows_checked:0,complete:false};const sync=op.index_sync;let checked=0;
 while(sync.collection_index<2){
  if(checked>=16||Date.now()>=budget.until){await checkpoint(ctx,op,'index_synchronization');return null;}
  const collection=['governance_index','cards'][sync.collection_index],page=await ctx.store.list(collection,{limit:16,cursor:sync.cursor});
  for(let i=sync.offset;i<page.items.length;i++){
   if(checked>=16||Date.now()>=budget.until){await checkpoint(ctx,op,'index_synchronization');return null;}
   const {key,value}=page.items[i],resolved=value.media_id?await resolveCurrentContent(ctx,e.b.kb_id,value.media_id):null;
   if(value.media_id===op.snapshot.media_id||resolved?.media_id===op.snapshot.media_id){const state=resolved||current,next={...value,current_content:state};need(await ctx.store.compareAndSwap(collection,key,value,next),'ima_content_index_sync_conflict','verification_pending');}
   sync.offset=i+1;sync.rows_checked++;checked++;await checkpoint(ctx,op,'index_synchronization');
  }
  if(page.has_more){need(page.next_cursor&&page.next_cursor!==sync.cursor,'ima_content_index_pagination_incomplete','verification_pending');sync.cursor=page.next_cursor;sync.offset=0;}
  else {sync.collection_index++;sync.cursor='';sync.offset=0;}
  await checkpoint(ctx,op,'index_synchronization');
 }
 sync.complete=true;await checkpoint(ctx,op,'replacement_verification');return current;
}
async function verify(ctx,e,op){
 const budget={until:Math.min(Date.now()+VERIFY_SLICE_MS,ctx.consolidationDeadline||Infinity)};
 const exists=await sourcePresent(ctx,e,op,budget);
 if(exists){
  if(op.provider_result?.status==='rejected'){
   const fresh=await snapshot(ctx,e,{...op.snapshot,request_id:op.request_id});need(stable(fresh.value)===stable(op.snapshot),'ima_content_rejected_original_drift','verification_pending');
   op={...op,status:'rejected',message:'ima_native_delete_rejected_original_retained'};await ctx.store.put('content_operations',op.request_id,op);await settle(ctx,e,op);return view(op);
  }
  return view(op);
 }
 const absent=await absentFromLibrary(ctx,e,op,budget);if(absent===null){op.status='verification_pending';op.message='ima_content_verification_slice_pending';await checkpoint(ctx,op,op.verification_stage);return view(op);}need(absent,'ima_content_media_found_at_another_location','verification_pending');
 const saved=await ctx.blobs.get(op.backup.blob_key);need(saved&&await sha256(new Uint8Array(await saved.arrayBuffer()))===op.snapshot.original.sha256,'ima_content_backup_missing_after_dispatch','verification_pending');
 need(!(await root(ctx).get('settings','migration'))?.frozen,'ima_content_index_sync_paused_for_migration','verification_pending');
 await scanFence(ctx,e,op);await checkpoint(ctx,op,'index_synchronization');
 const current=await synchronizeDeletion(ctx,e,op,budget);if(!current){op.status='verification_pending';op.message='ima_content_index_sync_slice_pending';await checkpoint(ctx,op,'index_synchronization');return view(op);}
 const replacement=await finishReplacement(ctx,e,op);if(replacement)op.replacement=replacement;
 op={...op,status:'succeeded',verification_stage:'complete',verified_at:current.verified_at,index_synchronized:true,verification:{same_original_identity:true,source_absent:true,complete_library_absence:true,backup_hash_verified:true},message:'removed_from_knowledge_base_not_physical_erasure'};
 await ctx.store.put('content_operations',op.request_id,op);await validateDelete(ctx,e,op);await settle(ctx,e,op);return view(op);
}
async function run(q,ctx,e,reconcile){
 return withMovePublicationLease(ctx,e.b.kb_id,async ctx=>{
  let op=await ctx.store.get('content_operations',q.request_id);need(op?.operation==='delete','ima_content_delete_preview_required','invalid_input');
  need(op.native_user_sha256===e.native_user_sha256&&op.snapshot.kb_id===e.b.kb_id&&op.snapshot.native_knowledge_base_id===e.binding.native_knowledge_base_id&&op.snapshot.roots_hash===e.binding.roots_hash,'ima_content_account_or_library_changed','conflict');
  if(!reconcile)need(q.preview_hash===op.preview_hash,'ima_content_preview_hash_mismatch','conflict');
  if(['succeeded','rejected'].includes(op.status)){if(op.status==='succeeded')await validateDelete(ctx,e,op);await settle(ctx,e,op);return {...view(op),replayed:true,...(q.include_backup?{backup_content:await (await ctx.blobs.get(op.backup.blob_key)).text()}: {})};}
  if(op.status==='preview'){
   if(reconcile)return view(op);
   const reservation=await reserveDeleteOwner(ctx,e,op);await preflight(ctx,e,{...reservation,request_id:op.request_id});if(ctx.workspace!=='isolated')need(await deletionProof(ctx,e),'ima_content_isolated_delete_acceptance_required');
   const fresh=await snapshot(ctx,e,{...op.snapshot,request_id:op.request_id});need(stable(fresh.value)===stable(op.snapshot),'ima_content_preview_stale','conflict');
   const resource=reservation.resource_key,owner=reservation.owner;
   need(await root(ctx).acquireLock(resource,owner),'ima_content_library_write_in_progress','conflict');let prepared=false;
   try{
    const check=await snapshot(ctx,e,{...op.snapshot,request_id:op.request_id});need(stable(check.value)===stable(op.snapshot),'ima_content_preview_stale','conflict');
    op.backup=await backup(ctx,e,op,check.source);
    await withServiceControls(ctx,async controlled=>{
     await writeGates(ctx,e);
     await root(ctx).put('native_content_active',activeKey(e),{request_id:op.request_id,resource_key:resource,lock_owner:owner,resolved:false});
     // Durable unknown precedes the only dispatch. Gate changes serialize
     // through the same controls lease until the provider reply is saved.
     op={...op,status:'unknown',dispatched_at:now(),dispatch_owner:owner};await ctx.store.put('content_operations',op.request_id,op);prepared=true;
     for(const fence of controlled.leaseFences||[])await root(ctx).touchLease(fence);
     const result=await nativeDeleteKnowledge(ctx,e.current,e.binding.native_knowledge_base_id,op.snapshot.media_id),rows=result.data?.results;
     const values=Array.isArray(rows)?rows:rows&&typeof rows==='object'?Object.values(rows):[];
     const match=values.length===1&&values[0]?.media_id===op.snapshot.media_id&&Number.isSafeInteger(values[0]?.ret_code)?values[0]:null;
     op.provider_result={status:result.status==='rejected'||result.status==='succeeded'&&match&&match.ret_code!==0?'rejected':result.status==='succeeded'&&match?.ret_code===0?'accepted':'unknown',...(Number.isSafeInteger(result.provider_code)?{provider_code:result.provider_code}:{}),...(Number.isSafeInteger(match?.ret_code)?{ret_code:match.ret_code}:{})};
     await ctx.store.put('content_operations',op.request_id,op);
    });
   }finally{if(!prepared){for(const fence of ctx.leaseFences||[])await root(ctx).touchLease(fence);const active=await root(ctx).get('native_content_active',activeKey(e));if(active?.request_id===op.request_id&&active.lock_owner===owner)await root(ctx).compareAndSwap('native_content_active',activeKey(e),active,{...active,resolved:true});await root(ctx).releaseLock(resource,owner);}}
  }
  const active=await root(ctx).get('native_content_active',activeKey(e));need(!active||active.request_id===op.request_id||active.resolved,'ima_content_other_request_pending','conflict');
  try{return await verify(ctx,e,op);}catch(error){op.status='verification_pending';op.message=error.message?.startsWith('ima_')?error.message:'ima_content_verification_pending';await ctx.store.put('content_operations',op.request_id,op);return view(op);}
 });
}
export async function contentAction(name,q,ctx){try{
 const e=await nativeWorkspaceEnvironment(ctx);
 if(name==='ima_content_capabilities'){const verified=await deletionProof(ctx,e),replacementVerified=await replacementProof(ctx,e);return {status:'succeeded',same_id_edit_enabled:false,same_id_edit_reason:'native_provider_not_verified',replacement_edit_implemented:true,replacement_edit_enabled:ctx.workspace==='isolated'||replacementVerified,replacement_isolated_verified:replacementVerified,replacement_mode:'create_then_delete',native_delete_implemented:true,isolated_delete_verified:verified,formal_delete_enabled:verified,deletion_scope:'remove_from_knowledge_base',physical_erasure_supported:false,restore_supported:false,...(q.media_id?{protocol:await isolatedContentInspection(ctx,q.media_id)}:{})};}
 need(typeof q.request_id==='string'&&q.request_id.trim().length>0,'ima_content_request_id_required','invalid_input');
 if(name==='ima_delete_preview'||name==='ima_edit_preview')return await preview(name,q,ctx,e);
 if(name==='ima_edit_execute'){const op=await ctx.store.get('content_operations',q.request_id);need(op?.operation==='edit'&&op.preview_hash===q.preview_hash&&op.native_user_sha256===e.native_user_sha256&&op.snapshot.kb_id===e.b.kb_id,'ima_content_edit_preview_mismatch','conflict');return {status:'unsupported',request_id:q.request_id,same_id_edit_enabled:false,message:'ima_native_same_id_edit_not_verified_no_upload_fallback'};}
 if(name==='ima_delete_execute'||name==='ima_delete_reconcile')return await run(q,ctx,e,name==='ima_delete_reconcile');
 return {status:'unsupported'};
}catch(error){return {status:error.status||'unavailable',message:error.message?.startsWith('ima_')?error.message:'ima_content_operation_unavailable'};}}
