import {sha256,stable,withShortLease} from './storage.js';
import {settings} from './governance.js';
import {loadNativeSession} from './ima-session-vault.js';
import {sessionAction} from './ima-session.js';
import {NativeClient} from './ima-native.js';
import {collectionRows,synchronizeMoveIndex} from './move-index.js';
import {resolveDirectory} from './directories.js';
import {scopedStore} from './admin.js';
import {computeRoundtrips} from './move-validation.js';

const now=()=>new Date().toISOString();
const root=ctx=>ctx.baseStore||ctx.store;
const need=(ok,message,status='blocked')=>{if(!ok)throw Object.assign(Error(message),{status});};
const s={type:'string',minLength:1,maxLength:500};
const workspace={type:'string',enum:['formal','isolated']};
const tool=(name,description,properties,required,readOnlyHint=false)=>({name,description,inputSchema:{type:'object',properties:{workspace,...properties},required,additionalProperties:false},annotations:{readOnlyHint,destructiveHint:false,idempotentHint:true,openWorldHint:true}});
export const moveTools=[
 tool('ima_bind_move_workspace','只读交叉核验原生与OpenAPI的库及11个根目录ID，保存账号绑定；不移动内容。原生库ID必须来自本次真实查询或已核实证据。',{native_knowledge_base_id:s},['native_knowledge_base_id']),
 tool('ima_move_preview','保存不可变的真实移动预览：同一库内同源父目录的文件或整个多级目录；核对完整子树、原文SHA256、目标路径与同名冲突。不会移动远端资料。',{request_id:s,source_folder_id:s,destination_folder_id:s,media_ids:{type:'array',minItems:1,maxItems:20,uniqueItems:true,items:s}},['request_id','source_folder_id','destination_folder_id','media_ids']),
 tool('ima_move_execute','执行用户要求的已预览真实移动；必须携带预览hash。仅派发一次，超时不重发；一级分类不可移动，同名不覆盖或合并。正式执行需隔离库往返验收通过。',{request_id:s,preview_hash:{type:'string',pattern:'^[a-f0-9]{64}$'}},['request_id','preview_hash']),
 tool('ima_move_reconcile','按原请求读回位置、原文和索引。可显式恢复原task_id的事件流，绝不重新提交move；同名冲突不自动继续。',{request_id:s,resume_task:{type:'boolean'}},['request_id']),
];
export async function moveConnectionProof(ctx,current){
 if(!current?.account_info)return {account_bound:false,move_verified:false};
 const user=await sha256(current.account_info.userId),account=await sha256(ctx.env.IMA_OPENAPI_CLIENTID||'');
 const bindings=[],configs={},native={};
 for(const w of ['formal','isolated']){
  configs[w]=await scopedStore(root(ctx),w).get('settings','bindings');const b=await root(ctx).get('native_move_bindings',account+':'+w);
  if(b?.native_user_sha256===user&&b.account_sha256===account&&b.kb_id===configs[w]?.kb_id&&b.roots_hash===await sha256(stable(configs[w].categories))){bindings.push(w);native[w]=b;}
 }
 const proof=await root(ctx).get('native_move_validation',account);
 const isolated=native.isolated,scope=proof?.isolated_scope;
 const valid=isolated&&configs.formal&&configs.formal.kb_id!==isolated.kb_id&&scope?.kb_id===isolated.kb_id&&scope.native_knowledge_base_id===isolated.native_knowledge_base_id&&scope.roots_hash===isolated.roots_hash&&(!native.formal||native.formal.native_knowledge_base_id!==isolated.native_knowledge_base_id);
 return {account_bound:bindings.length>0,bound_workspaces:bindings,move_verified:!!(valid&&proof.native_user_sha256===user&&proof.file_roundtrip===true&&proof.folder_roundtrip===true)};
}
async function environment(ctx,requireBinding=true){
 let state=await sessionAction('status',{},ctx);if(state.session?.refresh_required&&!state.session.reauthorization_required)state=await sessionAction('verify',{},ctx);need(state.session?.authenticated===true,'ima_native_login_validation_required');
 const current=await loadNativeSession(ctx);need(current?.account_info,'ima_native_login_required');
 const {b}=await settings(ctx),account=await sha256(ctx.env.IMA_OPENAPI_CLIENTID||'');need(b.account_sha256===account,'ima_openapi_account_mismatch');
 const native_user_sha256=await sha256(current.account_info.userId),key=account+':'+(ctx.workspace||'formal');
 const binding=await root(ctx).get('native_move_bindings',key);
 if(requireBinding)need(binding?.kb_id===b.kb_id&&binding.native_user_sha256===native_user_sha256&&binding.roots_hash===await sha256(stable(b.categories)),'ima_native_workspace_binding_required');
 return {b,account,current,native_user_sha256,binding,key,client:new NativeClient(ctx,current)};
}
const shape=x=>({media_id:x.media_id,title:x.title,kind:x.kind||((x.media_type===99||x.media_id.startsWith('folder_'))?'folder':'file')});
const sorted=rows=>rows.map(shape).sort((a,b)=>a.media_id.localeCompare(b.media_id));
async function openList(ctx,kb_id,folder_id){const r=await ctx.invoke('kb',{action:'folder.list',kb_id,folder_id});need(r.status==='succeeded'&&r.data?.has_more===false&&Array.isArray(r.data.items),'ima_openapi_readback_incomplete','verification_pending');return r.data.items;}
function pathCategory(path,b){const roots=new Map(Object.entries(b.categories).map(([k,v])=>[v.folder_id,k]));const found=path.filter(x=>roots.has(x.folder_id));need(found.length===1,'ima_move_path_outside_fixed_categories','conflict');return roots.get(found[0].folder_id);}
const pathRows=path=>path.filter(x=>String(x.folder_id).startsWith('folder')).map(x=>({directory_id:x.folder_id,name:x.name}));
async function readFolder(ctx,e,id){
 const native=await e.client.list(e.binding.native_knowledge_base_id,id),api=await openList(ctx,e.b.kb_id,id);
 need(stable(sorted(native.items))===stable(sorted(api)),'ima_native_openapi_media_mismatch','conflict');
 need(native.knowledge_base_id===e.binding.native_knowledge_base_id&&native.path.at(-1)?.folder_id===id,'ima_native_path_mismatch','conflict');
 return native;
}
export {environment as nativeWorkspaceEnvironment,readFolder as readNativeFolder};
async function bind(q,ctx){
 const e=await environment(ctx,false);need(/^\d{8,32}$/.test(q.native_knowledge_base_id||''),'ima_native_kb_id_required','invalid_input');
 const otherWorkspace=ctx.workspace==='isolated'?'formal':'isolated',other=await scopedStore(root(ctx),otherWorkspace).get('settings','bindings'),otherNative=await root(ctx).get('native_move_bindings',e.account+':'+otherWorkspace);
 need(!other||other.kb_id!==e.b.kb_id,'ima_move_isolated_library_must_be_distinct','conflict');
 need(!otherNative||otherNative.native_knowledge_base_id!==q.native_knowledge_base_id,'ima_move_native_libraries_must_be_distinct','conflict');
 const list=await e.client.list(q.native_knowledge_base_id,''),api=await openList(ctx,e.b.kb_id,'');
 need(list.knowledge_base_id===q.native_knowledge_base_id,'ima_native_kb_identity_mismatch','conflict');
 const expected=Object.values(e.b.categories).map(x=>({media_id:x.folder_id,title:x.folder_name,kind:'folder'}));
 const nativeRoots=list.items.filter(x=>shape(x).kind==='folder'),apiRoots=api.filter(x=>shape(x).kind==='folder');
 need(expected.length===11&&stable(sorted(nativeRoots))===stable(sorted(expected))&&stable(sorted(apiRoots))===stable(sorted(expected)),'ima_native_openapi_roots_mismatch','conflict');
 const info=await ctx.invoke('kb',{action:'kb.get',kb_id:e.b.kb_id});need(info.status==='succeeded'&&info.data?.knowledge_base?.name===e.b.kb_name,'ima_openapi_library_mismatch','conflict');
 const value={kb_id:e.b.kb_id,native_knowledge_base_id:q.native_knowledge_base_id,native_user_sha256:e.native_user_sha256,account_sha256:e.account,roots_hash:await sha256(stable(e.b.categories)),verified_at:now(),root_ids:expected.map(x=>x.media_id)};
 await root(ctx).put('native_move_bindings',e.key,value);
 return {status:'succeeded',binding:{workspace:ctx.workspace||'formal',kb_id:value.kb_id,native_knowledge_base_id:value.native_knowledge_base_id,verified_roots:11,verified_at:value.verified_at},...await moveConnectionProof(ctx,e.current)};
}
async function contentHash(ctx,item){
 const r=await ctx.invoke('kb',{action:'media.read',media_id:item.media_id});need(r.status==='succeeded','ima_move_original_unreadable','verification_pending');
 const d=r.data||{},hash=d.sha256||(typeof d.content==='string'?await sha256(d.content):null),size=d.size??(typeof d.content==='string'?new TextEncoder().encode(d.content).length:null);
 need(/^[a-f0-9]{64}$/.test(hash||'')&&Number.isSafeInteger(size)&&size>=0,'ima_move_original_hash_required','verification_pending');
 return {sha256:hash,size};
}
async function manifest(ctx,e,selected,sourcePath){
 const out=[],seen=new Set();
 async function walk(item,parent,path,depth){
  need(depth<=48&&out.length<500&&!seen.has(item.media_id),'ima_move_subtree_limit_or_cycle','blocked');seen.add(item.media_id);
  const row={...shape(item),folder_id:parent,file_size:String(item.file_size??''),md5_sum:String(item.md5_sum??''),path};
  if(row.kind==='folder'){
   const listing=await readFolder(ctx,e,row.media_id),nextPath=pathRows(listing.path);
   need(stable(nextPath)===stable([...path,{directory_id:row.media_id,name:row.title}]),'ima_move_subtree_path_mismatch','conflict');
   out.push(row);for(const child of listing.items)await walk(child,row.media_id,nextPath,depth+1);
  }else{Object.assign(row,await contentHash(ctx,row));out.push(row);}
 }
 for(const item of selected)await walk(item,item.parent_folder_id,sourcePath,0);
 return out.sort((a,b)=>a.media_id.localeCompare(b.media_id));
}
async function snapshot(q,ctx,e){
 need(q.source_folder_id!==q.destination_folder_id,'ima_move_same_parent','invalid_input');
 need(Array.isArray(q.media_ids)&&q.media_ids.length>0&&q.media_ids.length<=20&&new Set(q.media_ids).size===q.media_ids.length,'ima_move_unique_media_required','invalid_input');
 const roots=Object.values(e.b.categories).map(x=>x.folder_id);need(!q.media_ids.some(id=>roots.includes(id)),'ima_fixed_root_move_forbidden');
 const source=await readFolder(ctx,e,q.source_folder_id),target=await readFolder(ctx,e,q.destination_folder_id);
 pathCategory(source.path,e.b);const category=pathCategory(target.path,e.b);
 need(!target.path.some(x=>q.media_ids.includes(x.folder_id)),'ima_move_into_descendant_forbidden');
 try{const registered=await resolveDirectory(ctx,category,q.destination_folder_id);need(stable(registered.path)===stable(pathRows(target.path)),'ima_move_destination_registry_drift','conflict');}catch(error){if(error.message?.startsWith('ima_'))throw error;need(false,'ima_move_destination_must_be_registered','conflict');}
 const selected=q.media_ids.map(id=>source.items.find(x=>x.media_id===id));need(selected.every(Boolean),'ima_move_source_items_changed','conflict');
 need(new Set(selected.map(x=>x.title.normalize('NFKC').toLocaleLowerCase())).size===selected.length,'ima_move_source_name_collision','conflict');
 for(const item of selected){need(!target.items.some(x=>x.title.normalize('NFKC').toLocaleLowerCase()===item.title.normalize('NFKC').toLocaleLowerCase()),'ima_move_same_name_conflict','conflict');
  if(shape(item).kind==='folder'){const number=String(item.title).match(/^\d+_/u)?.[0];if(number)need(!target.items.some(x=>shape(x).kind==='folder'&&String(x.title).startsWith(number)),'ima_move_directory_number_conflict','conflict');}
 }
 const tree=await manifest(ctx,e,selected,pathRows(source.path));
 return {kb_id:e.b.kb_id,native_knowledge_base_id:e.binding.native_knowledge_base_id,source_folder_id:q.source_folder_id,destination_folder_id:q.destination_folder_id,media_ids:[...q.media_ids].sort(),source_path:pathRows(source.path),destination_path:pathRows(target.path),primary_category:category,manifest:tree};
}
const activeKey=e=>e.account+':'+e.b.kb_id;
async function preflight(ctx,e){
 need(!(await root(ctx).get('settings','migration'))?.frozen,'ima_move_migration_in_progress');
 need((await ctx.store.get('settings','service'))?.publication_enabled===true,'ima_move_workspace_not_enabled');
 const formal=await root(ctx).get('settings','service');need(formal?.ready===true,'ima_move_service_not_ready');
}
const view=op=>({status:op.status,request_id:op.request_id,preview_hash:op.preview_hash,preview:op.snapshot,task_id:op.task_id||null,items:op.items||[],index_synchronized:op.index_synchronized===true,message:op.message||null});
async function preview(q,ctx){
 const e=await environment(ctx);await preflight(ctx,e);
 return withShortLease(ctx,'governance:directory-plans:'+e.b.kb_id,async ctx=>{
  const old=await ctx.store.get('native_moves',q.request_id);
  if(old){need(stable(old.request)===stable(q),'ima_move_request_id_reused','conflict');return view(old);}
  const active=await root(ctx).get('native_move_active',activeKey(e));need(!active||active.resolved,'ima_move_pending_operation_requires_reconcile','conflict');
  const snap=await snapshot(q,ctx,e),op={request_id:q.request_id,request:q,snapshot:snap,native_user_sha256:e.native_user_sha256,status:'preview',created_at:now()};
  op.preview_hash=await sha256(stable({snapshot:snap,native_user_sha256:e.native_user_sha256,workspace:ctx.workspace||'formal'}));
  need(await ctx.store.create('native_moves',q.request_id,op),'ima_move_preview_race','conflict');return view(op);
 });
}
async function validateRoundtrips(ctx,e,op){
 if(ctx.workspace!=='isolated'||op.status!=='succeeded')return;
 const prior=(await collectionRows(ctx,'native_moves')).map(x=>x.value).filter(x=>x.status==='succeeded'&&x.native_user_sha256===e.native_user_sha256&&x.snapshot.kb_id===e.b.kb_id&&x.snapshot.native_knowledge_base_id===e.binding.native_knowledge_base_id);
 const proof=computeRoundtrips(prior);
 await root(ctx).put('native_move_validation',e.account,{native_user_sha256:e.native_user_sha256,...proof,isolated_scope:{kb_id:e.b.kb_id,native_knowledge_base_id:e.binding.native_knowledge_base_id,roots_hash:e.binding.roots_hash},verified_at:now()});
}
async function verify(ctx,e,op){
 const snap=op.snapshot,source=await readFolder(ctx,e,snap.source_folder_id),target=await readFolder(ctx,e,snap.destination_folder_id),locations=[],items=[];
 for(const id of snap.media_ids){
  const before=snap.manifest.find(x=>x.media_id===id),src=source.items.find(x=>x.media_id===id),dst=target.items.find(x=>x.media_id===id);
  const eventResults=(op.events||[]).flatMap(x=>x.results||[]).filter(x=>x.media_id===id);
  const rejected=eventResults.some(x=>x.ret_code!==undefined&&x.ret_code!==0)||(op.events||[]).some(event=>event.event==='SAMENAME'&&event.results?.some(x=>x.media_id===id));
  if(!src&&dst){
   const after=await manifest(ctx,e,[dst],pathRows(target.path));const original=snap.manifest.filter(x=>x.media_id===id||x.path.some(p=>p.directory_id===id));
   need(after.length===original.length,'ima_move_subtree_readback_mismatch','verification_pending');
   for(const previous of original){const current=after.find(x=>x.media_id===previous.media_id);need(current&&current.title===previous.title&&current.kind===previous.kind&&current.md5_sum===previous.md5_sum&&current.file_size===previous.file_size&&current.sha256===previous.sha256&&current.size===previous.size,'ima_move_identity_or_hash_changed','verification_pending');
    const oldPrefix=snap.source_path.length,newPath=[...snap.destination_path,...previous.path.slice(oldPrefix)];
    need(stable(current.path)===stable(newPath)&&current.folder_id===(previous.media_id===id?snap.destination_folder_id:previous.folder_id),'ima_move_descendant_position_mismatch','verification_pending');
    locations.push({media_id:current.media_id,folder_id:current.folder_id,path:current.kind==='folder'?[...current.path,{directory_id:current.media_id,name:current.title}]:current.path,primary_category:snap.primary_category});
   }
   items.push({media_id:id,status:'moved',same_id:true,hashes_verified:true});
  }else if(src&&!dst&&rejected){
   const after=await manifest(ctx,e,[src],pathRows(source.path)),original=snap.manifest.filter(x=>x.media_id===id||x.path.some(p=>p.directory_id===id));
   need(stable(after)===stable(original),'ima_move_rejected_subtree_changed','verification_pending');items.push({media_id:id,status:'conflict',unchanged:true});
  }else items.push({media_id:id,status:'unknown'});
 }
 op={...op,items};
 if(items.some(x=>x.status==='unknown')){
  op.status='unknown';op.kb_id=snap.kb_id;op.verified_at=now();await ctx.store.put('native_moves',op.request_id,op);
  if(locations.length&&!(await root(ctx).get('settings','migration'))?.frozen)await synchronizeMoveIndex(ctx,op,locations);
  return view(op);
 }
 op.verified_at=now();op.kb_id=snap.kb_id;op.status='verification_pending';await ctx.store.put('native_moves',op.request_id,op);
 need(!(await root(ctx).get('settings','migration'))?.frozen,'ima_move_index_sync_paused_for_migration','verification_pending');
 await synchronizeMoveIndex(ctx,op,locations);
 op={...op,status:items.every(x=>x.status==='moved')?'succeeded':items.some(x=>x.status==='moved')?'partial':'conflict',index_synchronized:true,locations};
 await ctx.store.put('native_moves',op.request_id,op);
 await settleLibraryLock(ctx,e,op);
 return view(op);
}
async function settleLibraryLock(ctx,e,op){
 const active=await root(ctx).get('native_move_active',activeKey(e));
 if(active?.request_id!==op.request_id)return;
 if(!active.resolved)need(await root(ctx).compareAndSwap('native_move_active',activeKey(e),active,{...active,resolved:true}),'ima_move_lock_finalization_pending','verification_pending');
 await root(ctx).releaseLock(active.resource_key,active.lock_owner);
}
async function run(q,ctx,reconcile){
 const e=await environment(ctx);
 return withShortLease(ctx,'governance:directory-plans:'+e.b.kb_id,async ctx=>{
  let op=await ctx.store.get('native_moves',q.request_id);need(op,'ima_move_preview_required','invalid_input');
  need(op.native_user_sha256===e.native_user_sha256&&op.snapshot.kb_id===e.b.kb_id,'ima_move_account_or_library_changed','conflict');
  if(!reconcile)need(op.preview_hash===q.preview_hash,'ima_move_preview_hash_mismatch','conflict');
  if(['succeeded','partial'].includes(op.status)||op.status==='conflict'&&op.index_synchronized){
   await settleLibraryLock(ctx,e,op);
   await validateRoundtrips(ctx,e,op);return {...view(op),replayed:true};
  }
  const active=await root(ctx).get('native_move_active',activeKey(e));need(!active||active.resolved||active.request_id===op.request_id,'ima_move_other_request_pending','conflict');
  if(!reconcile&&op.status==='preview'){
   await preflight(ctx,e);
   if(ctx.workspace!=='isolated')need((await moveConnectionProof(ctx,e.current)).move_verified,'ima_move_isolated_roundtrip_required');
   const fresh=await snapshot(op.request,ctx,e);need(stable(fresh)===stable(op.snapshot),'ima_move_preview_stale','conflict');
   // Do not race an existing upload. Match the provider's per-library resource lock.
   const resource=stable({domain:'knowledge',note_id:'ima-kb:'+e.b.kb_id},true),owner='native-move:'+q.request_id;
   need(await root(ctx).acquireLock(resource,owner),'ima_move_library_write_in_progress','conflict');
   try{need(stable(await snapshot(op.request,ctx,e))===stable(op.snapshot),'ima_move_preview_stale','conflict');}catch(error){await root(ctx).releaseLock(resource,owner);throw error;}
   await root(ctx).put('native_move_active',activeKey(e),{request_id:op.request_id,resource_key:resource,lock_owner:owner,resolved:false});
   op={...op,status:'unknown',dispatched_at:now()};await ctx.store.put('native_moves',op.request_id,op);
   const body={src_knowledge_base_id:e.binding.native_knowledge_base_id,dst_knowledge_base_id:e.binding.native_knowledge_base_id,dst_folder_id:op.snapshot.destination_folder_id,media_ids:op.snapshot.media_ids,action:0};
   try{const result=await e.client.move(body,async event=>{op.events=[...(op.events||[]),event];if(event.task_id)op.task_id=event.task_id;if(event.event==='SAMENAME')op.conflict=true;await ctx.store.put('native_moves',op.request_id,op);});op.conflict=op.conflict||result.conflict===true;}
   catch{op.message='ima_move_stream_interrupted_reconcile_original_request';}
   await ctx.store.put('native_moves',op.request_id,op);
  }else if(reconcile&&q.resume_task){
   need(op.status!=='preview'&&op.task_id&&!op.conflict,'ima_move_original_task_unavailable_or_conflicted');
   try{await e.client.resume(op.task_id,async event=>{op.events=[...(op.events||[]),event];if(event.event==='SAMENAME')op.conflict=true;await ctx.store.put('native_moves',op.request_id,op);});}catch{op.message='ima_move_task_recovery_interrupted';}
  }else if(op.status==='preview')return view(op);
  let result;
  try{result=await verify(ctx,e,op);}catch(error){op.status='verification_pending';op.message=error.message?.startsWith('ima_')?error.message:'ima_move_readback_or_index_pending';await ctx.store.put('native_moves',op.request_id,op);return view(op);}
  const finished=await root(ctx).get('native_move_active',activeKey(e));if(finished?.request_id===op.request_id&&finished.resolved)await root(ctx).releaseLock(finished.resource_key,finished.lock_owner);
  try{await validateRoundtrips(ctx,e,await ctx.store.get('native_moves',op.request_id));}catch{result.connection_validation_pending=true;}
  return result;
 });
}
export async function moveAction(name,q,ctx){try{
 need(typeof q.request_id!=='string'||q.request_id.trim().length>0,'ima_move_request_id_required','invalid_input');
 if(name==='ima_bind_move_workspace')return await bind(q,ctx);
 if(name==='ima_move_preview')return await preview(q,ctx);
 if(name==='ima_move_execute'||name==='ima_move_reconcile')return await run(q,ctx,name==='ima_move_reconcile');
 return {status:'unsupported'};
 }catch(error){return {status:error.status||'unavailable',message:error.message?.startsWith('ima_')?error.message:'ima_move_unavailable',...(error.message==='ima_native_incomplete_list'&&error.diagnostics?{diagnostics:error.diagnostics}:{})};}}
