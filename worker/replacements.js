import {sha256,stable} from './storage.js';
import {readTextOriginal} from './native-content.js';
import {nativeWorkspaceEnvironment,readNativeFolder} from './moves.js';
import {collectionRows} from './move-index.js';
import {scopedStore} from './admin.js';

const root=ctx=>ctx.baseStore||ctx.store,key=(kb_id,media_id)=>stable({kb_id,media_id});
const need=(ok,message,status='blocked')=>{if(!ok)throw Object.assign(Error(message),{status});};
const now=()=>new Date().toISOString();
function envelope(content){
 const normalized=content.replaceAll('\r\n','\n').replaceAll('\r','\n');
 const head=normalized.match(/^(\uFEFF?# [^\n]+\n\n)```json\n([\s\S]*?)\n```\n\n---\n\n([\s\S]*)$/u);
 const tail=head?null:normalized.match(/^(\uFEFF?# [^\n]+\n\n)([\s\S]*?)\n---\n\n```json\n([\s\S]*?)\n```\n?$/u);
 if(!head&&!tail){need(!/^\uFEFF?(?:# [^\n]+\n\n```json|---\n)/u.test(normalized)&&!/(?:^|\n)---\n\n```json\n/u.test(normalized),'ima_replacement_ambiguous_metadata','invalid_input');return null;}
 let metadata;try{metadata=JSON.parse(head?head[2]:tail[3]);}catch{need(false,'ima_replacement_invalid_metadata_json','invalid_input');}
 need(metadata&&typeof metadata==='object'&&!Array.isArray(metadata),'ima_replacement_metadata_object_required','invalid_input');return {heading:(head||tail)[1],metadata,body:head?head[3]:tail[2],layout:head?'head':'tail'};
}
export async function revisionArtifact(original,supplied,filename,date){
 const prior=envelope(original),candidate=envelope(supplied);let content=supplied,newVersion=null;
 if(prior){
  need(typeof prior.metadata.entry_id==='string'&&/^[1-9]\d*\.(?:0|[1-9]\d*)$/u.test(prior.metadata.version||''),'ima_replacement_governed_identity_required','invalid_input');
  if(candidate)for(const field of ['entry_id','title','primary_category','content_type','sources'])need(stable(candidate.metadata[field])===stable(prior.metadata[field]),'ima_replacement_metadata_identity_or_sources_changed','conflict');
  let body=candidate?candidate.body:supplied;body=body.replaceAll('\r\n','\n').replaceAll('\r','\n');if(!body.endsWith('\n'))body+='\n';need(body.trim().length>0,'ima_replacement_body_required','invalid_input');need(body!==prior.body||prior.layout==='head','ima_replacement_no_content_change','invalid_input');
  const [major,minor]=prior.metadata.version.split('.');newVersion=major+'.'+(BigInt(minor)+1n);need(newVersion.length<=20,'ima_replacement_version_limit','invalid_input');
  const metadata={...prior.metadata,previous_version:prior.metadata.version,version:newVersion,body_sha256:await sha256(body),updated_date:date,verification:'pending',verification_note:'正文已按用户请求修订，待重新核查；历史审核证据保留。'};
  content=prior.heading+body+'\n---\n\n```json\n'+JSON.stringify(metadata,null,2)+'\n```\n';
 }else need(!candidate,'ima_replacement_unexpected_metadata_header','invalid_input');
 need(content!==original,'ima_replacement_no_content_change','invalid_input');
 const digest=await sha256(content),ext=filename.match(/\.(md|markdown|txt)$/iu)?.[0];need(ext,'ima_replacement_text_filename_required','invalid_input');
 const stem=filename.slice(0,-ext.length),name=newVersion&&stem.endsWith('__v'+prior.metadata.version)?stem.slice(0,-prior.metadata.version.length)+newVersion+ext:stem+'__修订_'+digest.slice(0,10)+ext;
 need(new TextEncoder().encode(name).length<=255,'ima_replacement_filename_limit','invalid_input');return {content,filename:name,sha256:digest,...(newVersion?{version:newVersion}:{})};
}
export async function registerReplacement(ctx,e,op,content){
 const identity=await sha256(stable({account:e.account,kb_id:e.b.kb_id,workspace:ctx.workspace,request_id:op.request_id}));
 const plan={mode:'create_then_delete',request_id:op.request_id,workspace:ctx.workspace||'formal',create_tool:'ima_create_text_file',create_arguments:{kb_id:e.b.kb_id,folder_id:op.snapshot.folder_id,filename:op.snapshot.candidate.filename,content,request_id:'edit-add-'+identity,execute:true},delete_tool:'ima_delete_preview',delete_arguments:{folder_id:op.snapshot.folder_id,media_id:op.snapshot.media_id,request_id:'edit-remove-'+identity},candidate_sha256:op.snapshot.candidate.sha256,original_sha256:op.snapshot.original.sha256,new_id_expected:true,review_status:'pending'};
 const {candidate,...source}=op.snapshot;
 const row={request_id:op.request_id,status:'planned',plan,candidate,source,candidate_content:content,backup:op.backup,native_user_sha256:e.native_user_sha256,account_sha256:e.account,created_at:now()};
 await ctx.store.put('replacements',op.request_id,row);const saved=await ctx.store.get('replacements',op.request_id);need(saved?.candidate_content===content&&await sha256(saved.candidate_content)===candidate.sha256,'ima_replacement_database_candidate_not_verified','verification_pending');
 await ctx.store.put('replacement_creates',plan.create_arguments.request_id,{replacement_request_id:op.request_id});await ctx.store.put('replacement_deletes',plan.delete_arguments.request_id,{replacement_request_id:op.request_id});return plan;
}
function bound(row,e){need(row&&row.account_sha256===e.account&&row.native_user_sha256===e.native_user_sha256&&row.source.kb_id===e.b.kb_id&&row.source.native_knowledge_base_id===e.binding.native_knowledge_base_id&&row.source.roots_hash===e.binding.roots_hash,'ima_replacement_binding_changed','conflict');}
export async function replacementProof(ctx,e){
 const proof=await root(ctx).get('native_replacement_validation',e.account),binding=await root(ctx).get('native_move_bindings',e.account+':isolated'),config=await scopedStore(root(ctx),'isolated').get('settings','bindings');
 return !!(proof?.replacement_verified&&proof.account_sha256===e.account&&proof.native_user_sha256===e.native_user_sha256&&binding?.native_user_sha256===e.native_user_sha256&&binding.account_sha256===e.account&&binding.kb_id===proof.isolated_kb_id&&binding.kb_id===config?.kb_id&&binding.native_knowledge_base_id===proof.isolated_native_id&&binding.roots_hash===proof.roots_hash&&binding.roots_hash===await sha256(stable(config.categories))&&(ctx.workspace==='isolated'||e.b.kb_id!==binding.kb_id&&e.binding.native_knowledge_base_id!==binding.native_knowledge_base_id));
}
export async function authorizeReplacementCreate(ctx,q){try{
 const link=await ctx.store.get('replacement_creates',q.request_id);need(link,'ima_replacement_registered_create_required','conflict');const row=await ctx.store.get('replacements',link.replacement_request_id),e=await nativeWorkspaceEnvironment(ctx);bound(row,e);
 const expected=row.plan.create_arguments;need(q.action==='text.create'&&q.kb_id===expected.kb_id&&q.folder_id===expected.folder_id&&q.filename===expected.filename&&typeof q.content==='string'&&await sha256(q.content)===row.candidate.sha256&&q.content===row.candidate_content,'ima_replacement_create_does_not_match_database','conflict');
 const prior=await root(ctx).get('operations',q.request_id);if(prior?.receipt?.status==='succeeded'||prior?.dispatched_at&&!['reserved','blocked'].includes(prior.status))return null;
 if(ctx.workspace!=='isolated')need(await replacementProof(ctx,e),'ima_replacement_isolated_acceptance_required');
 const source=await readNativeFolder(ctx,e,row.source.folder_id);need(source.items.some(x=>x.media_id===row.source.media_id&&x.title===row.source.title),'ima_replacement_original_missing','conflict');
 const original=await readTextOriginal(ctx,row.source.media_id);need(original.sha256===row.source.original.sha256&&original.size===row.source.original.size,'ima_replacement_original_changed','conflict');
 need(!source.items.some(x=>x.title===expected.filename),'ima_replacement_destination_name_conflict','conflict');return null;
 }catch(error){return {status:error.status||'unavailable',message:error.message?.startsWith('ima_')?error.message:'ima_replacement_create_validation_failed'};}}
async function newCard(ctx,e,row){
 bound(row,e);const add=await root(ctx).get('operations',row.plan.create_arguments.request_id),receipt=add?.receipt,request=add?.request,expected=row.plan.create_arguments;
 need(add?.domain==='kb'&&add.status==='succeeded'&&receipt?.status==='succeeded'&&receipt.receipt?.stages?.readback==='verified','ima_replacement_new_card_not_verified');
 need(request?.action==='text.create'&&request.kb_id===expected.kb_id&&request.folder_id===expected.folder_id&&request.filename===expected.filename&&typeof request.content==='string'&&await sha256(request.content)===row.candidate.sha256,'ima_replacement_create_receipt_request_mismatch','conflict');
 const r=receipt.resource,ids=r?.media_ids;need(r?.action==='text.create'&&r.kb_id===expected.kb_id&&r.folder_id===expected.folder_id&&r.filename===expected.filename&&r.content_sha256===row.candidate.sha256&&receipt.receipt.input_sha256===row.candidate.sha256&&receipt.receipt.input_size===row.candidate.size&&Array.isArray(ids)&&ids.length===1&&ids[0]!==row.source.media_id,'ima_replacement_create_receipt_identity_mismatch','conflict');
 const list=await readNativeFolder(ctx,e,row.source.folder_id),item=list.items.find(x=>x.media_id===ids[0]);need(item?.kind==='file'&&item.title===expected.filename&&Number(item.file_size)===row.candidate.size,'ima_replacement_new_card_location_or_title_changed','conflict');
 const current=await readTextOriginal(ctx,ids[0]);need(current.sha256===row.candidate.sha256&&current.size===row.candidate.size,'ima_replacement_new_card_hash_changed','conflict');
 const blob=await ctx.blobs.get(row.backup.blob_key);need(blob&&await sha256(new Uint8Array(await blob.arrayBuffer()))===row.source.original.sha256,'ima_replacement_original_backup_missing','verification_pending');
 return {new_media_id:ids[0],new_sha256:current.sha256,new_size:current.size,new_filename:item.title,create_request_id:expected.request_id};
}
export async function replacementForDelete(ctx,e,request_id,snapshot){
 const link=await ctx.store.get('replacement_deletes',request_id);if(!link)return null;
 const row=await ctx.store.get('replacements',link.replacement_request_id);bound(row,e);const {replacement,...actual}=snapshot;
 need(stable(actual)===stable(row.source),'ima_replacement_old_card_changed','conflict');if(ctx.workspace!=='isolated')need(await replacementProof(ctx,e),'ima_replacement_isolated_acceptance_required');
 return {request_id:row.request_id,...await newCard(ctx,e,row),original_media_id:row.source.media_id};
}
async function validateReplacement(ctx,e,deletion,row,result){
 if(ctx.workspace!=='isolated'||deletion.provider_result?.status!=='accepted'||deletion.provider_result.ret_code!==0)return;
 const formal=await root(ctx).get('settings','bindings'),formalNative=await root(ctx).get('native_move_bindings',e.account+':formal');need(formal?.kb_id!==e.b.kb_id&&(!formalNative||formalNative.native_knowledge_base_id!==e.binding.native_knowledge_base_id),'ima_replacement_isolated_must_be_distinct','conflict');
 await root(ctx).put('native_replacement_validation',e.account,{account_sha256:e.account,native_user_sha256:e.native_user_sha256,isolated_kb_id:e.b.kb_id,isolated_native_id:e.binding.native_knowledge_base_id,roots_hash:e.binding.roots_hash,replacement_verified:true,request_id:row.request_id,old_media_id:row.source.media_id,new_media_id:result.new_media_id,verified_at:result.verified_at});
}
export async function finishReplacement(ctx,e,deletion){
 const link=await ctx.store.get('replacement_deletes',deletion.request_id);if(!link)return null;let row=await ctx.store.get('replacements',link.replacement_request_id);bound(row,e);
 // A previous pass may have projected the replacement before a later audit
 // write failed. Reapply the projection after deletion reconciliation rather
 // than leaving its temporary deleted-state projection as the current value.
 const checked=await newCard(ctx,e,row),current={state:'replaced',kb_id:e.b.kb_id,media_id:checked.new_media_id,previous_media_id:row.source.media_id,sha256:checked.new_sha256,size:checked.new_size,filename:checked.new_filename,folder_id:row.source.folder_id,request_id:row.request_id,delete_request_id:deletion.request_id,backup_blob_key:row.backup.blob_key,review_status:'pending',verified_at:now(),...(row.candidate.version?{version:row.candidate.version}:{})};
 await ctx.store.put('media_content_states',key(e.b.kb_id,row.source.media_id),current);await ctx.store.put('media_content_states',key(e.b.kb_id,checked.new_media_id),{...current,state:'current'});
 const path=row.source.path.filter(x=>x.folder_id.startsWith('folder_')).map(x=>({directory_id:x.folder_id,name:x.name}));
 await ctx.store.put('media_locations',key(e.b.kb_id,checked.new_media_id),{kb_id:e.b.kb_id,media_id:checked.new_media_id,folder_id:row.source.folder_id,path,request_id:row.request_id,verified_at:current.verified_at});
 for(const collection of ['governance_index','cards'])for(const {key:recordKey,value} of await collectionRows(ctx,collection))if(value.media_id===row.source.media_id||value.current_content?.media_id===row.source.media_id){
  await ctx.store.put('media_content_states',key(e.b.kb_id,value.media_id),current);need(await ctx.store.compareAndSwap(collection,recordKey,value,{...value,current_content:current}),'ima_replacement_index_sync_conflict','verification_pending');
 }
 const result={status:'succeeded',mode:'create_then_delete',request_id:row.request_id,old_media_id:row.source.media_id,...checked,delete_request_id:deletion.request_id,index_synchronized:true,review_status:'pending',verified_at:current.verified_at};row={...row,status:'succeeded',result};await ctx.store.put('replacements',row.request_id,row);
 await validateReplacement(ctx,e,deletion,row,result);
 return result;
}
