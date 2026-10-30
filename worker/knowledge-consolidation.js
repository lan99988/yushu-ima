import {sha256,stable,withShortLease} from './storage.js';
import {settings,governance,normalize,packed} from './governance.js';
import {readTextOriginal} from './native-content.js';
import {contentAction,nativeDeleteLockBinding} from './content-mutations.js';
import {collectionRows,withMovePublicationLease,resolveCurrentContent} from './move-index.js';
import {scopedStore} from './admin.js';

const need=(ok,message,status='blocked')=>{if(!ok)throw Object.assign(Error(message),{status});};
const unique=xs=>[...new Map(xs.map(x=>[stable(x),x])).values()];
const clean=q=>Object.fromEntries(Object.entries(q).filter(([k])=>!['execute','reconcile','confirmation','preview_hash','workspace'].includes(k)));
const root=ctx=>ctx.baseStore||ctx.store;
async function acceptance(ctx){
 const base=root(ctx),account=await sha256(ctx.env.IMA_OPENAPI_CLIENTID||''),proof=await base.get('knowledge_consolidation_validation',account),isolated=await scopedStore(base,'isolated').get('settings','bindings'),binding=await base.get('native_move_bindings',account+':isolated');
 if(!proof)return null;
 const {b}=await settings(ctx),formal=await base.get('native_move_bindings',account+':formal');
 const valid=!!(proof?.status==='verified'&&proof.account_sha256===account&&isolated?.account_sha256===account&&proof.isolated_kb_id===isolated.kb_id&&proof.roots_hash===await sha256(stable(isolated.categories))&&binding?.account_sha256===account&&binding.kb_id===isolated.kb_id&&binding.roots_hash===proof.roots_hash&&binding.native_knowledge_base_id===proof.isolated_native_id&&binding.native_user_sha256===proof.native_user_sha256&&(ctx.workspace==='isolated'||b.kb_id!==proof.isolated_kb_id&&formal?.native_user_sha256===proof.native_user_sha256&&formal.native_knowledge_base_id!==proof.isolated_native_id));
 return valid?proof:null;
}
export async function consolidationRuntime(ctx){
 let proof=null;try{proof=await acceptance(ctx);}catch{}
 const caps=await contentAction('ima_content_capabilities',{},ctx),service=await root(ctx).get('settings','service'),workspace=await ctx.store.get('settings','service');
 const native=caps.status==='succeeded'&&caps.native_delete_implemented&&(ctx.workspace==='isolated'||caps.formal_delete_enabled);
 return {implemented:true,enabled:!!(service?.ready&&workspace?.publication_enabled&&!(await root(ctx).get('settings','migration'))?.frozen&&native&&(ctx.workspace==='isolated'||proof)),supported_source_types:['registered_knowledge_object'],max_sources:20,max_text_bytes:1048576,native_delete_enabled:!!native,requires_isolated_acceptance:ctx.workspace!=='isolated',acceptance_valid:!!proof,isolated_acceptance:proof};
}
async function certify(ctx,op){
 if(ctx.workspace!=='isolated'||op.status!=='succeeded'||op.sources.length<2)return;
 const {b}=await settings(ctx),account=await sha256(ctx.env.IMA_OPENAPI_CLIENTID||'');
 const recorded=await root(ctx).get('knowledge_consolidation_validation',account);if(recorded?.request_id===op.request_id||recorded?.verified_at>op.created_at)return;
 const binding=await root(ctx).get('native_move_bindings',account+':isolated'),formal=await root(ctx).get('settings','bindings');
 need(binding?.kb_id===b.kb_id&&b.account_sha256===account&&formal?.kb_id!==b.kb_id&&binding.roots_hash===await sha256(stable(b.categories)),'consolidation_acceptance_binding_changed','verification_pending');
 // An unknown provider receipt may prove eventual absence, but cannot certify
 // this implementation's native deletion acceptance.
 if(op.deletions.some(d=>d.receipt?.status!=='succeeded'||d.receipt.provider_result?.status!=='accepted'||d.receipt.provider_result.ret_code!==0))return;
 for(const s of op.sources){const blob=await ctx.blobs.get(s.backup_blob_key);need(blob&&await sha256(new Uint8Array(await blob.arrayBuffer()))===s.sha256,'consolidation_acceptance_backup_missing','verification_pending');}
 need((await readTextOriginal(ctx,op.object.media_id)).sha256===op.new_sha256,'consolidation_acceptance_master_changed','verification_pending');
 const proof={status:'verified',account_sha256:account,native_user_sha256:binding.native_user_sha256,isolated_kb_id:b.kb_id,isolated_native_id:binding.native_knowledge_base_id,roots_hash:binding.roots_hash,request_id:op.request_id,preview_hash:op.preview_hash,master_key:op.master_key,master_entry_id:op.object.entry_id,master_media_id:op.object.media_id,readback_sha256:op.new_sha256,backups:op.receipt.backups,deletions:op.deletions,index_and_relations_verified:true,verified_at:new Date().toISOString()};
 await root(ctx).put('knowledge_consolidation_validation',account,proof);
}
const view=op=>({status:op.status,request_id:op.request_id,policy_version:'2.0.0',preview_hash:op.preview_hash,master_key:op.master_key,delete_media_ids:op.sources.map(s=>s.media_id),requires_confirmation:op.requires_confirmation,supported_source_types:['registered_knowledge_object'],phase:op.phase,...(op.status==='preview'?{object:op.candidate.object,entry:op.candidate.entry}:{}),...(op.object?{object:op.object}:{}),...(op.receipt?{receipt:op.receipt}:{}),...(op.message?{message:op.message}:{})});
export async function consolidationProgress(op,ctx){
 const children=[];
 for(const d of op.deletions||[]){
  const native=await ctx.store.get('content_operations',d.request_id),scan=native?.absence_scan,index=native?.index_sync;
  children.push({request_id:d.request_id,media_id:d.media_id,status:native?.status||d.receipt?.status||'not_found',provider_status:native?.provider_result?.status||null,lock_binding:await nativeDeleteLockBinding(ctx,native),stage:native?.verification_stage||null,scan:{folders_checked:scan?.seen?.length||0,pending_folders:scan?.queue?.length||0,items_checked:scan?.item_count||0,complete:scan?.complete===true,current_stage:scan?.native_listing?'openapi':'native'},index:{rows_checked:index?.rows_checked||0,complete:index?.complete===true},message:native?.message||null});
 }
 return {phase:op.phase,total_sources:op.sources?.length||0,cleaned_count:children.filter(x=>x.status==='succeeded').length,children};
}
async function yieldPending(ctx,op,message){op.status='verification_pending';op.message=message;await persist(ctx,op);return {...view(op),progress:await consolidationProgress(op,ctx)};}
async function boundedConsolidationRead(ctx,read){
 const remaining=ctx.consolidationDeadline-Date.now();need(remaining>0,'consolidation_verification_slice_pending','verification_pending');let timer;
 try{return await Promise.race([Promise.resolve().then(read),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('consolidation_verification_slice_pending'),{status:'verification_pending'})),remaining);})]);}finally{clearTimeout(timer);}
}
async function persist(ctx,op){await ctx.store.put('knowledge_consolidations',op.request_id,op);}
async function readSource(ctx,s){
 let source;try{source=await readTextOriginal(ctx,s.media_id);}catch(e){if(e.status==='invalid_input')throw Object.assign(Error('consolidation_source_requires_utf8_text_up_to_1MiB'),{status:'blocked'});throw e;}need(source.sha256===s.sha256,'consolidation_source_hash_mismatch','conflict');return source;
}
function graphPlan(rows,keys,master,q,merged){
 const resolve=k=>keys.has(k)?master:k;
 const next=rows.filter(x=>!keys.has(x.object_key)).map(x=>({...x,...(x.merged_into?{merged_into:resolve(x.merged_into)}:{}),parent_key:x.parent_key?resolve(x.parent_key):null,relations:unique((x.relations||[]).map(r=>({...r,target_key:resolve(r.target_key)}))).filter(r=>r.target_key!==x.object_key)}));
 next.push({...merged,object_key:master,parent_key:(Object.hasOwn(q.object,'parent_key')?q.object.parent_key:merged.parent_key)?resolve(Object.hasOwn(q.object,'parent_key')?q.object.parent_key:merged.parent_key):null,relations:unique([...(merged.relations||[]),...(q.object.relations||[])].map(r=>({...r,target_key:resolve(r.target_key)}))).filter(r=>r.target_key!==master)});
 const byKey=new Map(next.map(x=>[x.object_key,x]));
 for(const row of next){if(row.parent_key===row.object_key)row.parent_key=null;const seen=new Set([row.object_key]);let parent=row.parent_key;while(parent){need(!seen.has(parent),'consolidation_parent_cycle','conflict');seen.add(parent);need(byKey.has(parent),'consolidation_parent_missing');parent=byKey.get(parent).parent_key;}}
 return next;
}
async function preview(q,ctx,api,hash){
 need(q.policy_version==='2.0.0','knowledge_policy_version_mismatch','conflict');need(q.mode==='organize','consolidation_organize_only','invalid_input');
 need(q.object&&q.entry&&q.material,'object_and_entry_required','invalid_input');
 need(Array.isArray(q.merge_sources)&&q.merge_sources.length>0&&q.merge_sources.length<=20,'consolidation_sources_required','invalid_input');
 const rows=(await collectionRows(ctx,'knowledge_objects')).map(x=>x.value),sources=[],objects=[];
 for(const s of q.merge_sources){
  need(s&&typeof s.media_id==='string'&&s.media_id&&typeof s.folder_id==='string'&&s.folder_id&&/^[a-f0-9]{64}$/.test(s.sha256||''),'consolidation_source_identity_required','invalid_input');
  need(!sources.some(x=>x.media_id===s.media_id),'consolidation_duplicate_source','invalid_input');
  const o=s.object_key?rows.find(x=>x.object_key===s.object_key):rows.find(x=>x.media_id===s.media_id&&!x.merged_into);
  need(o&&!o.merged_into,'consolidation_unregistered_native_source_not_supported');need(!o.pending_request&&!o.consolidation_request,'knowledge_object_update_pending','conflict');
  need(o.media_id===s.media_id&&(!s.entry_id||s.entry_id===o.entry_id)&&(s.revision===undefined||s.revision===o.revision),'consolidation_source_identity_mismatch','conflict');
  const indexed=await governance('entry.get',{entry_id:o.entry_id,include_content:true},ctx);
  need(indexed.status==='succeeded'&&indexed.entry.media_id===s.media_id&&(indexed.entry.current_location?.folder_id||indexed.entry.folder_id)===s.folder_id,'consolidation_source_index_mismatch','conflict');
  need((indexed.entry.current_content?.sha256||indexed.entry.content_sha256)===s.sha256,'consolidation_governed_source_hash_mismatch','conflict');
  await readSource(ctx,s);sources.push({...s,object_key:o.object_key,entry_id:o.entry_id,revision:o.revision});objects.push(o);
 }
 const target=objects.find(x=>x.object_key===q.object.key);need(target,'consolidation_current_target_source_required','conflict');need(q.expected_version===target.revision,'stale_knowledge_object_version','conflict');
 // A canonical concept wins, otherwise the oldest registered object. Date ties
 // use immutable UUIDs rather than caller-controlled source ordering.
 const operations=(await collectionRows(ctx,'knowledge_operations')).map(x=>x.value);
 const oldest=o=>o.created_at||operations.filter(x=>x.object?.entry_id===o.entry_id&&x.created_at).map(x=>x.created_at).sort()[0]||o.created_date;
 const sorted=[...objects].sort((a,b)=>(a.type==='concept'?0:1)-(b.type==='concept'?0:1)||String(oldest(a)).localeCompare(String(oldest(b)))||a.entry_id.localeCompare(b.entry_id));
 const master=sorted[0],typeChanged=master.type!==q.object.type;
 need(!typeChanged||(master.type==='question'&&q.object.type==='concept'),'knowledge_object_type_changed','conflict');
 const requires_confirmation=objects.length>1||typeChanged||q.major_change===true||master.primary_category!==q.entry.primary_category;
 const merged={...master,type:q.object.type,sources:unique(objects.flatMap(o=>o.sources||[])),materials:unique(objects.flatMap(o=>o.materials||[])),tags:unique(objects.flatMap(o=>o.tags||[])),aliases:unique(objects.flatMap(o=>[...(o.aliases||[]),...(o.title!==q.entry.title?[o.title]:[]),...(o.object_key!==master.object_key?[o.object_key]:[])])),history:unique(objects.flatMap(o=>[...(o.history||[]),...(o.object_key!==master.object_key?[{object_key:o.object_key,entry_id:o.entry_id,revision:o.revision,date:o.updated_date,answer:o.current_answer,media_id:o.media_id,summary:'归并前完整对象保留于事务备份'}]:[])])),relations:unique(objects.flatMap(o=>o.relations||[])),images:unique(objects.flatMap(o=>o.images||[]))};
 need(new Set(merged.images.map(x=>x.image_id)).size===merged.images.length,'consolidation_image_identity_collision');
 const keys=new Set(objects.map(x=>x.object_key)),graph=graphPlan(rows,keys,master.object_key,q,merged),masterGraph=graph.find(x=>x.object_key===master.object_key);
 const child={...clean(q),action:'ingest',request_id:'kc_'+await sha256((ctx.workspace||'formal')+':'+q.request_id),object:{...q.object,key:master.object_key,parent_key:masterGraph.parent_key||undefined,relations:masterGraph.relations},expected_version:master.revision,major_change:requires_confirmation,confirmation:requires_confirmation?'归并父事务具体确认绑定后执行':undefined};delete child.merge_sources;
 const candidate=await api.prepare(child,ctx,{old:merged});
 need(candidate.object.aliases.length<=20&&candidate.object.tags.length<=20,'consolidation_metadata_limit');
 const {p,b}=await settings(ctx);
 const normalized=normalize(candidate.entry,p),{body,...metadata}=normalized;
 const rendered='# '+normalized.title+'\n\n```json\n'+packed({...metadata,policy_version:p.policy_version,body_sha256:await sha256(body)},2)+'\n```\n\n---\n\n'+body;
 need(new TextEncoder().encode(rendered).length<=1048576,'consolidation_rendered_text_exceeds_native_deletion_limit');
 const op={request_id:q.request_id,hash,status:'preview',phase:'preview',master_key:master.object_key,sources,objects,requires_confirmation,child,candidate:{...candidate,bytes:Array.from(candidate.bytes),imageWrites:(candidate.imageWrites||[]).map(x=>({...x,bytes:Array.from(x.bytes)}))},graph,graph_before:rows,settings_hash:await sha256(stable({p,b})),deletions:[],created_at:new Date().toISOString()};
 op.preview_hash=await sha256(stable({...op,created_at:undefined}));await persist(ctx,op);return view(op);
}
async function validateSnapshot(ctx,op){
 const {p,b}=await settings(ctx);need(await sha256(stable({p,b}))===op.settings_hash,'consolidation_settings_changed','conflict');
 const rows=(await collectionRows(ctx,'knowledge_objects')).map(x=>x.value);need(stable(rows)===stable(op.graph_before),'consolidation_preview_stale','conflict');
 for(const s of op.sources)await readSource(ctx,s);
}
async function backups(ctx,op){
 for(const s of op.sources){const bytes=(await readSource(ctx,s)).bytes,key='knowledge-consolidation/'+await sha256(op.request_id)+'/'+s.sha256+'.md';await ctx.blobs.put(key,bytes,{contentType:'text/markdown; charset=utf-8'});const saved=await ctx.blobs.get(key);need(saved&&await sha256(new Uint8Array(await saved.arrayBuffer()))===s.sha256,'consolidation_backup_verification_failed','verification_pending');s.backup_blob_key=key;await persist(ctx,op);}
 // Existing material archives must be intact before any source can be removed.
 for(const o of op.objects)for(const m of o.materials||[]){const saved=await ctx.blobs.get(m.blob_key);need(saved&&await sha256(new Uint8Array(await saved.arrayBuffer()))===m.sha256,'consolidation_material_backup_missing','verification_pending');}
}
async function migrate(ctx,op){
 const {b}=await settings(ctx),master=await ctx.store.get('knowledge_objects',op.master_key);need(master?.revision===op.candidate.object.revision,'consolidation_master_not_committed','verification_pending');
 const key=stable({kb_id:b.kb_id,media_id:master.media_id});
 await ctx.store.put('media_content_states',key,{state:'current',kb_id:b.kb_id,media_id:master.media_id,sha256:op.new_sha256,version:master.revision+'.0',filename:master.filename,request_id:op.request_id});
 for(const before of op.graph_before){
  if(before.object_key===op.master_key)continue;
  const source=op.objects.some(x=>x.object_key===before.object_key),desired=source?{...before,merged_into:op.master_key,consolidation_request:op.request_id}:op.graph.find(x=>x.object_key===before.object_key);
  if(!desired)continue;const current=await ctx.store.get('knowledge_objects',before.object_key);
  need(stable(current)===stable(before)||current?.consolidation_request===op.request_id||stable(current)===stable(desired),'consolidation_graph_drift','conflict');await ctx.store.put('knowledge_objects',before.object_key,desired);
  need(stable(await ctx.store.get('knowledge_objects',before.object_key))===stable(desired),'consolidation_graph_readback_failed','verification_pending');
 }
 // Historical rows keep their original evidence. Current projections resolve
 // all deleted media to the new master, after native deletion has completed.
 op.object=master;op.phase='migrated';await persist(ctx,op);
}
async function projections(ctx,op){
 const {b}=await settings(ctx),master=op.object;
 for(const s of op.sources){const projection={state:'replaced',kb_id:b.kb_id,media_id:master.media_id,sha256:op.new_sha256,version:master.revision+'.0',filename:master.filename,merged_into:op.master_key,request_id:op.request_id,backup_blob_key:s.backup_blob_key};await ctx.store.put('media_content_states',stable({kb_id:b.kb_id,media_id:s.media_id}),projection);}
 for(const collection of ['governance_index','cards'])for(const {key,value} of await collectionRows(ctx,collection)){
  const current=value.media_id?await resolveCurrentContent(ctx,b.kb_id,value.media_id):null;
  if(current?.media_id===master.media_id){await ctx.store.put(collection,key,{...value,current_content:current,merged_into:op.master_key});need(stable((await ctx.store.get(collection,key)).current_content)===stable(current),'consolidation_projection_verification_failed','verification_pending');}
 }
}
async function settle(ctx,op){
 const active=await ctx.store.get('settings','knowledge_consolidation_active');
 if(active?.request_id===op.request_id&&!active.resolved)await ctx.store.put('settings','knowledge_consolidation_active',{...active,resolved:true});
}
async function run(q,ctx,op,api){
 if(op.status==='preview'){
  need(q.preview_hash===op.preview_hash,'consolidation_preview_hash_mismatch','conflict');
  if(op.requires_confirmation){const c=q.confirmation;need(c&&typeof c.text==='string'&&c.text.trim()&&c.text.length<=4000&&c.preview_hash===op.preview_hash&&stable(c.delete_media_ids)===stable(op.sources.map(s=>s.media_id)),'consolidation_specific_confirmation_required');op.confirmation=c;op.child.confirmation=c.text;}
  await validateSnapshot(ctx,op);
  const capabilities=await contentAction('ima_content_capabilities',{},ctx);need(capabilities.status==='succeeded'&&capabilities.native_delete_implemented&&(ctx.workspace==='isolated'||capabilities.formal_delete_enabled),'consolidation_native_deletion_acceptance_required');
  if(ctx.workspace!=='isolated')need(await acceptance(ctx),'consolidation_isolated_acceptance_required');
  const active=await ctx.store.get('settings','knowledge_consolidation_active');need(!active||active.resolved||active.request_id===op.request_id,'consolidation_other_request_pending','conflict');
  await ctx.store.put('settings','knowledge_consolidation_active',{request_id:op.request_id,child_request_id:op.child.request_id,resolved:false});
  op.status='verification_pending';op.phase='backups';await persist(ctx,op);
 }
 if(op.phase==='backups'){
  const active=await ctx.store.get('settings','knowledge_consolidation_active');need(!active||active.resolved||active.request_id===op.request_id,'consolidation_other_request_pending','conflict');await ctx.store.put('settings','knowledge_consolidation_active',{request_id:op.request_id,child_request_id:op.child.request_id,resolved:false});
  await backups(ctx,op);
  for(const s of op.sources){if(!op.deletions.some(d=>d.media_id===s.media_id)){
   const request_id=op.child.request_id+'-delete-'+op.deletions.length,p=await contentAction('ima_delete_preview',{request_id,media_id:s.media_id,folder_id:s.folder_id},ctx);need(p.status==='preview'&&p.preview?.original?.sha256===s.sha256,p.message||'consolidation_delete_preview_failed',p.status==='conflict'?'conflict':'blocked');op.deletions.push({request_id,media_id:s.media_id,preview_hash:p.preview_hash});await persist(ctx,op);
  }}
  op.phase='ingest';await persist(ctx,op);
 }
 if(op.phase==='ingest'){
  // The child ingest already persists unknown before dispatch and recovers
  // solely by its original transport id. A crash before child creation is safe.
  const saved=await ctx.store.get('knowledge_operations',op.child.request_id),candidate={...op.candidate,bytes:new Uint8Array(op.candidate.bytes),imageWrites:op.candidate.imageWrites.map(x=>({...x,bytes:new Uint8Array(x.bytes)}))};
  const r=await api.ingest({...op.child,execute:true,...(saved?{reconcile:true}:{})},ctx,{candidate});
  if(r.status!=='succeeded'){op.status=r.status;op.message=r.message;await persist(ctx,op);return view(op);}
  const original=await readTextOriginal(ctx,r.object.media_id),childOp=await ctx.store.get('knowledge_operations',op.child.request_id);
  need(await sha256(childOp.transport.content)===original.sha256,'consolidation_new_master_readback_mismatch','verification_pending');
  op.new_sha256=original.sha256;op.object=r.object;op.phase='readback_verified';op.status='verification_pending';delete op.message;await persist(ctx,op);
 }
 if(op.phase==='readback_verified')await migrate(ctx,op);
 if(op.phase==='migrated'||op.phase==='deleting'){
  for(const d of op.deletions){if(d.receipt?.status==='succeeded'){
   const settled=await contentAction('ima_delete_reconcile',{request_id:d.request_id},ctx);if(settled.status!=='succeeded')return yieldPending(ctx,op,settled.message||'consolidation_child_finalization_pending');
   continue;
  }
   if(Date.now()>=ctx.consolidationDeadline)return yieldPending(ctx,op,'consolidation_verification_slice_pending');
   need((await boundedConsolidationRead(ctx,()=>readTextOriginal(ctx,op.object.media_id))).sha256===op.new_sha256,'consolidation_new_master_readback_mismatch','verification_pending');
   const master=await ctx.store.get('knowledge_objects',op.master_key);need(master?.media_id===op.object.media_id&&master.revision===op.object.revision,'consolidation_master_index_drift','verification_pending');
   for(const before of op.graph_before){if(before.object_key===op.master_key)continue;const row=await ctx.store.get('knowledge_objects',before.object_key),source=op.objects.some(o=>o.object_key===before.object_key);need(source?row?.merged_into===op.master_key:stable(row)===stable(op.graph.find(o=>o.object_key===before.object_key)),'consolidation_graph_drift','verification_pending');}
   const pending=await ctx.store.get('content_operations',d.request_id);if(pending?.status==='preview')await boundedConsolidationRead(ctx,()=>readSource(ctx,op.sources.find(s=>s.media_id===d.media_id)));
   // Never mark dispatch until the native engine has a durable operation. If
   // execution dies while its operation is preview, reconcile may safely enter
   // execute again; unknown native operations always use read-only reconcile.
   const native=await ctx.store.get('content_operations',d.request_id);need(native,'consolidation_delete_operation_missing','verification_pending');
   const name=native.status==='preview'?'ima_delete_execute':'ima_delete_reconcile';op.phase='deleting';await persist(ctx,op);
   d.receipt=await contentAction(name,{request_id:d.request_id,...(name==='ima_delete_execute'?{preview_hash:d.preview_hash}:{})},ctx);await persist(ctx,op);
   if(d.receipt.status!=='succeeded'){op.status=d.receipt.status;op.message=d.receipt.message;await persist(ctx,op);return {...view(op),progress:await consolidationProgress(op,ctx)};}
   if(Date.now()>=ctx.consolidationDeadline)return yieldPending(ctx,op,'consolidation_verification_slice_pending');
  }
  op.phase='projections';op.status='verification_pending';await persist(ctx,op);
 }
 if(op.phase==='projections'){
  await projections(ctx,op);
  for(const o of op.objects){const row=await ctx.store.get('knowledge_objects',o.object_key);if(row?.consolidation_request===op.request_id){delete row.consolidation_request;await ctx.store.put('knowledge_objects',o.object_key,row);}}
  op.receipt={status:'succeeded',master_key:op.master_key,media_id:op.object.media_id,ingest_request_id:op.child.request_id,backups:op.sources.map(s=>({media_id:s.media_id,sha256:s.sha256,blob_key:s.backup_blob_key})),deletions:op.deletions,readback_verified:true,index_and_relations_verified:true};op.phase='complete';op.status='succeeded';delete op.message;await persist(ctx,op);
  await certify(ctx,op);await settle(ctx,op);
 }
 return view(op);
}
export async function consolidate(q,ctx,api){
 try{
  need(typeof q.request_id==='string'&&q.request_id.trim()&&q.request_id.length<=200,'request_id_required','invalid_input');
  for(const k of ['execute','reconcile','major_change'])if(k in q)need(typeof q[k]==='boolean',k+'_must_be_boolean','invalid_input');
  const hash=await sha256(stable(clean(q))),{b}=await settings(ctx);
  return await withMovePublicationLease(ctx,b.kb_id,ctx=>withShortLease(ctx,'governance:knowledge-consolidation',async ctx=>{
   let op=await ctx.store.get('knowledge_consolidations',q.request_id);
   if(op){need(op.hash===hash,'knowledge_request_id_reused','conflict');if(op.status==='succeeded'){await certify(ctx,op);await settle(ctx,op);return {...view(op),replayed:true};}if(op.status==='preview'&&q.reconcile)return view(op);if(!q.execute&&!q.reconcile)return view(op);if(op.status!=='preview'&&!q.reconcile)return view(op);}
   else {need(!q.reconcile,'knowledge_original_request_missing');need(!q.execute,'consolidation_preview_required','conflict');return preview(q,ctx,api,hash);}
   ctx={...ctx,consolidationDeadline:Date.now()+60000};
   try{return await run(q,ctx,op,api);}catch(e){if(!['preview','succeeded'].includes(op.status)){op.status=e.status||'verification_pending';op.message=e.status?e.message:'consolidation_storage_or_transport_pending';await persist(ctx,op);}throw e;}
  }));
 }catch(e){return {status:e.status||'verification_pending',request_id:q.request_id,message:e.status?e.message:'consolidation_storage_or_transport_pending',supported_source_types:['registered_knowledge_object']};}
}
