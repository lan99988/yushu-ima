import {withMovePublicationLease} from './move-index.js';
import {consolidate,consolidationRuntime,consolidationProgress} from './knowledge-consolidation.js';
import {sha256,stable,withShortLease} from './storage.js';
import {governance,settings} from './governance.js';
import {knowledgeDate} from './cards.js';
import {prepareImages,imageDisplayVerified} from './knowledge-images.js';

export const KNOWLEDGE_POLICY=Object.freeze({version:'2.0.0',identity:'knowledge_object_not_source',organization:'complete_entry_with_linked_topics',source_fidelity:true,current_answer_and_dated_history:true,event_timeline:true,one_primary_location:true,multiple_tags:true,original_archive:true,opinion_and_experience_attribution:true,major_change_requires_confirmation:true});
const need=(ok,message,status='invalid_input')=>{if(!ok)throw Object.assign(Error(message),{status});};
const text=(v,label,max=9000000)=>{need(typeof v==='string'&&v.trim()&&v.isWellFormed()&&v.length<=max,label+'_required');return v;};
const date=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\d$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const canonical=q=>Object.fromEntries(Object.entries(q).filter(([k])=>!['execute','reconcile','workspace'].includes(k)));
const root=c=>c.baseStore||c.store;
async function all(store,collection){const rows=[];let cursor='';do{const p=await store.list(collection,{limit:200,cursor});rows.push(...p.items.map(x=>x.value));cursor=p.has_more?p.next_cursor:'';}while(cursor);return rows;}
async function uuid(key){const h=(await sha256(key)).slice(0,32).split('');h[12]='5';h[16]='8';const s=h.join('');return [s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join('-');}
function view(op){return {status:op.status,request_id:op.request_id,policy_version:'2.0.0',...(op.object?{object:op.object}:{}),...(op.image_display?{image_display:op.image_display}:{}),...(op.receipt?{receipt:op.receipt}:{}),...(op.message?{message:op.message}:{})};}
const answer=body=>body.split(/\n\s*\n/).find(x=>x.trim()&&!x.trim().startsWith('#'))?.trim().slice(0,600)||body.slice(0,600);

export async function knowledgeTransportAllowed(ctx,domain,q){
 const active=await ctx.store.get('settings','knowledge_consolidation_active');
 if(active&&!active.resolved&&q.execute===true&&!q.reconcile){
  const child=await ctx.store.get('knowledge_operations',active.child_request_id);
  const reads=['get','list','search','media.read','folder.list','kb.get','kb.list','kb.addable','knowledge.search'];
  if(!reads.includes(q.action)&&q.request_id!==child?.transport?.request_id)return false;
 }
 const service=await root(ctx).get('settings','service');
 if(!service?.knowledge_v2_enabled||q.reconcile||!q.execute)return true;
 if(!((domain==='notes'&&['create','append'].includes(q.action))||(domain==='kb'&&['text.create','file.upload','url.import','note.associate'].includes(q.action))))return true;
 const saved=await root(ctx).get('operations',q.request_id);
 // A pre-upgrade durable transaction is recovered by its original identity.
 if(saved&&saved.created_at&&saved.created_at<service.knowledge_v2_activated_at)return true;
 // 先增后删修订的 create 走 replacements 登记表授权；随后的 authorizeReplacementCreate
 // 会复核候选哈希、绑定与同目录重名，因此这里放行不等于绕过内容门禁。
 if(domain==='kb'&&q.action==='text.create'&&q.request_id){
  for(const workspace of ['formal','isolated']){
   const store=workspace===ctx.workspace?ctx.store:(await import('./admin.js')).scopedStore(root(ctx),workspace);
   if(await store.get('replacement_creates',q.request_id))return true;
  }
 }
 for(const workspace of ['formal','isolated']){
  const store=workspace===ctx.workspace?ctx.store:(await import('./admin.js')).scopedStore(root(ctx),workspace);
  const permit=await store.get('knowledge_transports',q.request_id);
  if(permit?.domain===domain&&permit.hash===await sha256(stable(canonical(q))))return true;
 }
 return false;
}
async function permit(ctx,domain,q){await ctx.store.put('knowledge_transports',q.request_id,{domain,hash:await sha256(stable(canonical(q))),created_at:new Date().toISOString()});}

async function prepare(q,ctx,internal={}){
 const active=await ctx.store.get('settings','knowledge_consolidation_active');need(!active||active.resolved||active.child_request_id===q.request_id,'knowledge_consolidation_pending','conflict');
 text(q.request_id,'request_id',200);need(q.policy_version==='2.0.0','knowledge_policy_version_mismatch','conflict');
 need(['organize','archive'].includes(q.mode),'knowledge_mode_required');const m=q.material;need(m&&typeof m==='object','material_required');text(m.source_id,'source_id',500);text(m.locator,'source_locator',4000);
 if(m.published_date!==undefined)need(date(m.published_date),'published_date_invalid');
 if(q.as_of!==undefined)need(date(q.as_of),'as_of_invalid');
 const {p,b}=await settings(ctx),day=knowledgeDate(new Date().toISOString());
 let bytes,originalHash;
 if(m.blob_id){const blob=await ctx.blobs.get(m.blob_id);need(blob,'material_blob_missing');bytes=new Uint8Array(await blob.arrayBuffer());originalHash=await sha256(bytes);if(m.sha256)need(m.sha256===originalHash,'material_hash_mismatch','conflict');}
 else {text(m.content,'material_content');bytes=new TextEncoder().encode(m.content);originalHash=await sha256(bytes);}
 const original={source_id:m.source_id,locator:m.locator,sha256:originalHash,blob_key:'knowledge-materials/'+originalHash,...(m.published_date?{published_date:m.published_date}:{}),...(m.author?{author:m.author}:{}),...(m.context?{context:m.context}:{}),kind:m.kind||'original'};
 if(q.mode==='archive'){
  await prepareImages(q,ctx);
  if(m.storage==='note'&&!m.note_id){text(m.content,'material_content');return {bytes,original,domain:'notes',transport:{action:'create',content:m.content,...(m.folder_id?{folder_id:m.folder_id}:{}),request_id:'ki_'+await sha256((ctx.workspace||'formal')+':'+q.request_id),execute:false}};}
  if(m.note_id){
   text(m.content,'material_content');const before=await ctx.invoke('notes',{action:'get',note_id:m.note_id});
   need(before.status==='succeeded'&&typeof before.data?.title==='string'&&typeof before.data.content==='string','archive_note_target_not_readable','blocked');
   if(m.expected_title!==undefined)need(m.expected_title===before.data.title,'archive_note_title_changed','conflict');
   return {bytes,original,domain:'notes',transport:{action:'append',note_id:m.note_id,expected_title:before.data.title,expected_content_sha256:await sha256(before.data.content),content:m.content,request_id:'ki_'+await sha256((ctx.workspace||'formal')+':'+q.request_id),execute:false}};
  }
  const transport=m.blob_id?{action:'file.upload',blob_id:m.blob_id,filename:text(m.filename,'filename',500),...(m.content_type?{content_type:m.content_type}:{}),sha256:originalHash}:{action:'text.create',filename:m.filename||('原始资料-'+(await sha256(q.request_id)).slice(0,12)+'.md'),content:m.content};
  return {bytes,original,transport:{...transport,kb_id:m.kb_id||b.kb_id,...(m.folder_id?{folder_id:m.folder_id}:{}),request_id:'ki_'+await sha256((ctx.workspace||'formal')+':'+q.request_id),execute:false}};
 }
 const o=q.object,e=q.entry;need(o&&e,'object_and_entry_required');text(o.key,'object_key',500);need(['concept','item','question','event'].includes(o.type),'object_type_invalid');
 text(e.title,'title',80);text(e.body,'body');need(p.categories.some(c=>c.code===e.primary_category),'primary_category_not_registered');
 if(o.type==='event')need(date(q.as_of),'event_as_of_required');
 need(['fact','opinion','personal_experience','inspiration','original'].includes(m.kind),'material_kind_required');
 if(['opinion','personal_experience'].includes(m.kind)){text(m.author,'author',500);text(m.context,'context',4000);}
 let old=internal.old||await ctx.store.get('knowledge_objects',o.key),adopted;
 need(!old?.merged_into,'knowledge_object_merged_use_master','conflict');
 need(!old?.pending_request||old.pending_request===q.request_id,'knowledge_object_update_pending','conflict');
 need((q.expected_version??0)===(old?.revision||0),'stale_knowledge_object_version','conflict');
 if(!old&&o.existing_entry_id){
  need(q.major_change&&q.confirmation?.trim(),'existing_entry_adoption_confirmation_required','blocked');
  const found=await governance('entry.get',{entry_id:o.existing_entry_id,include_content:true},ctx);
  need(found.status==='succeeded'&&typeof found.content==='string','existing_entry_not_readable','blocked');
  const v=found.entry.current_content?.version||found.entry.version;
  adopted={content:found.content,blob_key:'knowledge-materials/'+await sha256(found.content)};
  old={entry_id:o.existing_entry_id,revision:Number(v.split('.')[0]),entry_version:v,type:o.type,body:found.content,current_answer:answer(found.content),primary_category:found.entry.metadata.primary_category,created_date:found.entry.metadata.created_date,sources:found.entry.metadata.sources,tags:found.entry.metadata.tags||[],aliases:found.entry.metadata.aliases||[],materials:[{source_id:'existing-entry:'+o.existing_entry_id,locator:'迁移前完整条目',sha256:await sha256(found.content),blob_key:adopted.blob_key,kind:'original'}]};
 }
 if(old)need(old.type===o.type,'knowledge_object_type_changed','conflict');
 if(q.major_change)need(typeof q.confirmation==='string'&&q.confirmation.trim(),'major_change_confirmation_required','blocked');
 if(old&&old.primary_category!==e.primary_category)need(q.major_change&&q.confirmation?.trim(),'category_change_confirmation_required','blocked');
 const links=o.relations||[];need(Array.isArray(links)&&links.length<=100,'relations_invalid');
 const keys=[...(o.parent_key?[o.parent_key]:[]),...links.map(r=>r.target_key)];
 for(const key of keys){need(key!==o.key,'self_relation_forbidden');need(await ctx.store.get('knowledge_objects',key),'related_object_not_found','blocked');}
 for(const r of links){text(r.relation,'relation',100);text(r.reason,'relation_reason',4000);}
 let parent=o.parent_key;const seen=new Set([o.key]);while(parent){need(!seen.has(parent),'parent_cycle','conflict');seen.add(parent);parent=(await ctx.store.get('knowledge_objects',parent))?.parent_key;}
 const materials=[...(old?.materials||[])];if(!materials.some(x=>x.source_id===original.source_id&&x.sha256===original.sha256))materials.push(original);
 const sources=[...(old?.sources||[]),...(e.sources||[])];const source={kind:m.kind==='personal_experience'?'personal':'provided_material',locator:m.source_id+' / '+m.locator,...(m.author?{author:m.author}:{}),...(m.published_date?{published_date:m.published_date}:{})};sources.push(source);if(m.source_url)sources.push({kind:'url',locator:m.source_url});
 const unique=[...new Map(sources.map(s=>[stable(s),s])).values()];need(unique.length<=50,'source_limit_requires_explicit_source_compaction','blocked');
 const entry_id=old?.entry_id||await uuid(b.account_sha256+':'+b.kb_id+':'+o.key),revision=(old?.revision||0)+1;
 let verification=m.kind==='fact'?'pending':'not_applicable';
 if(m.kind==='fact'&&q.review){
  need(q.review.mode==='web_verified'&&q.review.revision_hash===await sha256(e.body),'review_body_binding_invalid','conflict');
  need(Array.isArray(q.review.evidence)&&q.review.evidence.length>0&&q.review.evidence.length<=50,'review_evidence_required');
  for(const evidence of q.review.evidence){need(/^https?:\/\//.test(evidence.url||''),'evidence_url_required');for(const k of ['locator','supports','excerpt','checker'])text(evidence[k],'evidence_'+k,10000);need(typeof evidence.checked_at==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(evidence.checked_at)&&Number.isFinite(Date.parse(evidence.checked_at))&&Date.parse(evidence.checked_at)<=Date.now()+300000,'evidence_checked_at_invalid');}
  verification='verified';
 }
 const history=[...(old?.history||[]),...(old?[{date:day,revision:old.revision,answer:old.current_answer,media_id:old.media_id,summary:q.change_summary||'补充来源并更新完整答案'}]:[])];
 const kindLabel={fact:'事实性材料（待核查）',opinion:'作者观点',personal_experience:'个人经验',inspiration:'灵感',original:'原始材料'};
 const illustration=await prepareImages(q,ctx,old);
 let body=illustration.body+'\n\n'+(q.as_of?'判断截至：'+q.as_of+'\n\n':'');
 body+='## 材料性质与来源\n\n'+materials.map(s=>'- '+(kindLabel[s.kind]||s.kind)+'：'+s.source_id+'；定位：'+s.locator+(s.author?'；主张者：'+s.author:'')+(s.context?'；语境：'+s.context:'')+(s.published_date?'；发布日期：'+s.published_date:'')).join('\n');
 if(o.parent_key||links.length)body+='\n\n## 相关条目\n\n'+(o.parent_key?'- 主条目：'+o.parent_key+'\n':'')+links.map(r=>'- '+r.target_key+'（'+r.relation+'）：'+r.reason).join('\n');
 if(history.length)body+='\n\n## 结论变化记录\n\n'+history.map(h=>'- '+h.date+'，第'+h.revision+'版：'+h.summary+'。当时答案：'+h.answer).join('\n');
 const entry={entry_id,version:revision+'.0',title:e.title,primary_category:e.primary_category,content_type:e.content_type||(o.type==='event'?'record':'concept'),content_natures:e.content_natures||[m.kind==='opinion'?'source_opinion':m.kind==='personal_experience'?'personal_experience':'ai_synthesis'],sources:unique,verification,verification_note:verification==='verified'?'宿主逐项网页核查；正文SHA256：'+q.review.revision_hash:verification==='pending'?'事实断言尚待逐项证据核查。':'记录观点、经验或原始材料归属；不表示事实已核查。',body,created_date:old?.created_date||day,updated_date:day,tags:[...new Set([...(old?.tags||[]),...(e.tags||[])])],aliases:[...new Set([...(old?.aliases||[]),...(e.aliases||[])])],...(old?{previous_version:old.entry_version||old.revision+'.0'}:{}),...(e.primary_category==='inbox'?{classification_reason:'主分类待确认'}:{})};
 const object={object_key:o.key,type:o.type,entry_id,revision,title:e.title,primary_category:e.primary_category,created_at:old?.created_at||new Date().toISOString(),created_date:entry.created_date,updated_date:day,current_answer:answer(e.body),body:e.body,verification,materials,sources:unique,tags:entry.tags,aliases:entry.aliases,history,parent_key:o.parent_key||null,relations:links};
 if(illustration.images.length)object.images=illustration.images;
 return {bytes,original,entry,object,old,adopted,imageWrites:illustration.writes,policy_version:p.policy_version};
}

// 这些状态表示"确定没有写入"：保留对象的 pending 标记会让该对象永久无法再提交，
// 治理预留也会把该版本号永久占住，后续合法重试会一直 conflict。
const NOT_WRITTEN=new Set(['conflict','blocked','invalid_input']);
async function releasePending(ctx,op){
 if(op.governance?.request_id){
  const {releaseReservationForRequest}=await import('./governance.js');
  await releaseReservationForRequest(ctx,op.governance.request_id);
 }
 if(!op.object)return;
 const saved=await ctx.store.get('knowledge_objects',op.object.object_key);
 if(saved?.pending_request!==op.request_id)return;
 const {pending_request,...rest}=saved;
 await ctx.store.put('knowledge_objects',op.object.object_key,rest);
}
async function complete(ctx,op,receipt){
 op.receipt=receipt;const media_id=receipt?.resource?.media_ids?.[0]||(!op.object?receipt?.resource?.note_id:undefined);
 if(receipt?.status!=='succeeded'||!media_id){
  const notWritten=NOT_WRITTEN.has(receipt?.status);
  if(notWritten)await releasePending(ctx,op);
  op.status=notWritten?'failed':receipt?.status==='unknown'?'unknown':'verification_pending';
  await ctx.store.put('knowledge_operations',op.request_id,op);return view(op);}
 if(op.object?.images?.length){
  const proof=await root(ctx).get('settings','knowledge_image_acceptance');
  if(!imageDisplayVerified(proof,op.object,(await settings(ctx)).b.account_sha256)){op.status='verification_pending';op.message='ima_inline_image_display_and_reopen_acceptance_required';await ctx.store.put('knowledge_operations',op.request_id,op);return view(op);}
  op.image_display={status:'verified',format:proof.format,renderer_version:proof.renderer_version,acceptance_request_id:proof.request_id,checked_at:proof.checked_at};delete op.message;
 }
 if(op.archive_target&&receipt.resource?.note_id){
  const note=await ctx.invoke('notes',{action:'get',note_id:receipt.resource.note_id});
  if(note.status!=='succeeded'){op.status='verification_pending';await ctx.store.put('knowledge_operations',op.request_id,op);return view(op);}
  const association={action:'note.associate',kb_id:op.archive_target,note_id:receipt.resource.note_id,title:note.data.title,request_id:op.transport.request_id+'-associate',execute:true};
  await permit(ctx,'kb',association);
  const recovering=op.association_dispatched===true;op.association_dispatched=true;await ctx.store.put('knowledge_operations',op.request_id,op);
  const associated=await ctx.invoke('kb',{...association,...(recovering?{reconcile:true}:{})});
  if(associated.status!=='succeeded'){op.status='verification_pending';op.receipt={...receipt,association:associated};await ctx.store.put('knowledge_operations',op.request_id,op);return view(op);}
  op.receipt={...receipt,resource:{...receipt.resource,kb_id:op.archive_target,media_ids:associated.resource?.media_ids},association:associated};
 }
 if(op.governance){const committed=await governance('index.commit',{...op.governance,action:'index.commit',media_id},ctx);if(committed.status!=='succeeded'){op.status='verification_pending';op.message=committed.message;await ctx.store.put('knowledge_operations',op.request_id,op);return view(op);}}
 if(op.object){
  const saved=await ctx.store.get('knowledge_objects',op.object.object_key);
  need(saved?.pending_request===op.request_id||saved?.revision===op.object.revision&&saved?.media_id===media_id,'knowledge_pending_owner_changed','conflict');
  const next={...op.object,media_id,filename:op.transport.filename,transport_request_id:op.transport.request_id};
  await ctx.store.put('knowledge_history',op.object.entry_id+':'+op.object.revision,next);await ctx.store.put('knowledge_objects',op.object.object_key,next);op.object=next;
 }
 op.status='succeeded';await ctx.store.put('knowledge_operations',op.request_id,op);
 if(ctx.workspace==='isolated'){const {b}=await settings(ctx),proof=await ctx.store.get('settings','knowledge_acceptance')||{};await ctx.store.put('settings','knowledge_acceptance',{...proof,kb_id:b.kb_id,account_sha256:b.account_sha256,roots_hash:await sha256(stable(b.categories)),[op.object?(op.object.revision>1?'update':'create'):'archive']:true,verified_at:new Date().toISOString()});}
 return view(op);
}
export async function knowledgeAction(q,ctx,internal={}){try{
 if(q.action==='consolidate')return consolidate(q,ctx,{prepare,ingest:knowledgeAction});
 if(q.action==='policy.get'){const service=await root(ctx).get('settings','service'),proof=await root(ctx).get('settings','knowledge_image_acceptance');return {status:'succeeded',policy:KNOWLEDGE_POLICY,runtime:{consolidation:await consolidationRuntime(ctx),unified_ingest_enforced:service?.knowledge_v2_enabled===true,images:{format:'markdown_data_uri',original_bytes:true,translation_below_image:true,visual_review_required:true,reader_reopen_acceptance:imageDisplayVerified(proof)?'recorded':'pending',max_image_bytes:4194304,max_total_image_bytes:6291456}}};}
 if(q.action==='operation.get'){const consolidation=await ctx.store.get('knowledge_consolidations',q.request_id);if(consolidation)return {status:consolidation.status,request_id:q.request_id,phase:consolidation.phase,progress:await consolidationProgress(consolidation,ctx),preview_hash:consolidation.preview_hash,receipt:consolidation.receipt,object:consolidation.object};const op=await ctx.store.get('knowledge_operations',text(q.request_id,'request_id',200));return op?view(op):{status:'not_found',request_id:q.request_id};}
 if(q.action==='object.get'){
  const requested=text(q.object_key,'object_key',500);let key=requested,object;const seen=new Set();
  do{need(!seen.has(key),'knowledge_merged_cycle','conflict');seen.add(key);object=await ctx.store.get('knowledge_objects',key);if(!object)return {status:'not_found'};key=object.merged_into;}while(key);
  const rows=(await all(ctx.store,'knowledge_objects')).filter(x=>!x.merged_into);return {status:'succeeded',object,...(requested!==object.object_key?{resolved_from:requested}:{}),children:rows.filter(x=>x.parent_key===object.object_key),backlinks:rows.filter(x=>(x.relations||[]).some(r=>r.target_key===object.object_key))};
 }
 if(q.action==='object.search'){const query=text(q.query,'query',500).normalize('NFKC').toLocaleLowerCase();const rows=await all(ctx.store,'knowledge_objects');return {status:'succeeded',items:rows.filter(x=>!x.merged_into&&[x.object_key,x.title,...(x.aliases||[]),...(x.tags||[])].some(v=>typeof v==='string'&&v.normalize('NFKC').toLocaleLowerCase().includes(query))),scope:'registered knowledge objects only',has_more:false};}
 need(q.action==='ingest','unknown_knowledge_action');
 for(const key of ['execute','reconcile','major_change'])if(key in q)need(typeof q[key]==='boolean',key+'_must_be_boolean');
 if('expected_version' in q)need(Number.isSafeInteger(q.expected_version)&&q.expected_version>=0,'expected_version_invalid');
 text(q.request_id,'request_id',200);const hash=await sha256(stable(canonical(q)));
 const completed=await ctx.store.get('knowledge_operations',q.request_id);
 if(completed?.status==='succeeded'){need(completed.hash===hash,'knowledge_request_id_reused','conflict');return {...view(completed),replayed:true};}
 const key='governance:knowledge:'+(q.object?.key||q.request_id);
 const {b}=await settings(ctx);return await withMovePublicationLease(ctx,b.kb_id,ctx=>withShortLease(ctx,key,async ctx=>{
  const saved=await ctx.store.get('knowledge_operations',q.request_id);
  if(saved){need(saved.hash===hash,'knowledge_request_id_reused','conflict');if(saved.status==='succeeded')return {...view(saved),replayed:true};if(!q.reconcile)return view(saved);
   const receipt=await ctx.invoke(saved.domain||'kb',{...saved.transport,execute:true,reconcile:true});return complete(ctx,saved,receipt);
  }
  need(!q.reconcile,'knowledge_original_request_missing','blocked');
  const candidate=internal.candidate||await prepare(q,ctx);
  if(!q.execute)return {status:'preview',request_id:q.request_id,policy_version:'2.0.0',object:candidate.object,entry:candidate.entry,mode:q.mode};
  need(!candidate.object?.images?.some(i=>i.review_status!=='checked'),'image_visual_review_required','blocked');
  if(candidate.object?.images?.length&&ctx.workspace!=='isolated')need(imageDisplayVerified(await root(ctx).get('settings','knowledge_image_acceptance'),candidate.object,(await settings(ctx)).b.account_sha256),'ima_inline_image_display_and_reopen_acceptance_required','blocked');
  for(const image of candidate.imageWrites||[]){await ctx.blobs.put(image.blob_key,image.bytes,{contentType:image.content_type});const saved=await ctx.blobs.get(image.blob_key);need(saved&&await sha256(new Uint8Array(await saved.arrayBuffer()))===await sha256(image.bytes),'image_original_persistence_failed','verification_pending');}
  await ctx.blobs.put(candidate.original.blob_key,candidate.bytes,{contentType:q.material.content_type||'text/plain; charset=utf-8'});
  if(candidate.adopted)await ctx.blobs.put(candidate.adopted.blob_key,candidate.adopted.content,{contentType:'text/markdown; charset=utf-8'});
  const check=await ctx.blobs.get(candidate.original.blob_key);need(check&&await sha256(new Uint8Array(await check.arrayBuffer()))===candidate.original.sha256,'original_material_persistence_failed','verification_pending');
  let transport=candidate.transport,governanceRequest;
  if(candidate.entry){const rid='ki_'+await sha256((ctx.workspace||'formal')+':'+q.request_id),{scope}=await settings(ctx),reserved=await ctx.store.get('governance_requests',scope+':'+rid);governanceRequest={...(reserved?reserved.naming_profile?{naming_profile:reserved.naming_profile}:{}:{naming_profile:'title_only_v1'}),action:'entry.prepare',policy_version:candidate.policy_version,request_id:'ki_'+await sha256((ctx.workspace||'formal')+':'+q.request_id),entry:candidate.entry};const p=await governance('entry.prepare',governanceRequest,ctx);if(p.status!=='preview')return p;transport=p.transport_request;}
  const op={request_id:q.request_id,hash,status:'unknown',mode:q.mode,domain:candidate.domain||'kb',created_at:new Date().toISOString(),transport,original:candidate.original,...(q.material.associate_to_kb?{archive_target:q.material.kb_id}:{}),...(q.review?{review:q.review}:{}),...(candidate.object?{object:candidate.object,governance:governanceRequest}:{})};
  if(candidate.object)await ctx.store.put('knowledge_objects',candidate.object.object_key,{...(candidate.old||{object_key:candidate.object.object_key,revision:0}),pending_request:q.request_id});
  await ctx.store.put('knowledge_operations',q.request_id,op);await permit(ctx,op.domain,transport);
  let receipt;try{receipt=await ctx.invoke(op.domain,{...transport,execute:true});}catch{receipt={status:'unknown'};}
  return complete(ctx,op,receipt);
 }));
}catch(e){return {status:e.status||'unavailable',request_id:q?.request_id,message:e.status?e.message:'knowledge_storage_or_transport_error'};}}

const string=(description,maxLength=9000000)=>({type:'string',description,maxLength});
const jsonObject=properties=>({type:'object',properties,additionalProperties:false});
const entry=jsonObject(Object.fromEntries(['title','primary_category','body','content_type','verification','verification_note'].map(k=>[k,string(k)])));
for(const k of ['tags','aliases','content_natures'])entry.properties[k]={type:'array',items:string(k,500),maxItems:20};
entry.properties.sources={type:'array',items:jsonObject(Object.fromEntries(['kind','locator','author','title','published_date'].map(k=>[k,string(k,4000)]))),maxItems:50};
const object=jsonObject({key:string('稳定知识对象键',500),type:{type:'string',enum:['concept','item','question','event']},existing_entry_id:string('经读取和用户确认接管的旧条目UUID',36),parent_key:string('主条目键',500),relations:{type:'array',items:jsonObject({target_key:string('关联条目键',500),relation:string('关联类型',100),reason:string('关联理由',4000)}),maxItems:100}});
const material=jsonObject(Object.fromEntries(['source_id','locator','content','kind','author','context','published_date','source_url','blob_id','filename','sha256','content_type','note_id','expected_title','kb_id','folder_id','storage'].map(k=>[k,string(k)])));
material.properties.associate_to_kb={type:'boolean'};
const review=jsonObject({mode:{type:'string',enum:['web_verified']},revision_hash:string('正文SHA256',64),evidence:{type:'array',items:jsonObject(Object.fromEntries(['url','locator','supports','excerpt','checked_at','checker','input_hash','revision_hash','category'].map(k=>[k,string(k)]))),maxItems:50}});
const images={type:'array',maxItems:20,items:{...jsonObject({...Object.fromEntries(['image_id','blob_id','sha256','source_id','locator','caption','ocr_text','translation','language','position'].map(k=>[k,string(k,50000)])),review_status:{type:'string',enum:['checked','needs_review']}}),required:['image_id','blob_id','sha256','source_id','locator','caption','ocr_text','translation','language','position','review_status']}};
export const knowledgeTools=[
 {name:'ima_knowledge_policy',description:'读取全系统统一知识2.0规范。',inputSchema:jsonObject({}),annotations:{readOnlyHint:true}},
 {name:'ima_knowledge_search',description:'按对象名、别名或标签查共享条目索引；另查ima原生搜索发现旧资料。',inputSchema:{...jsonObject({query:string('检索词',500),workspace:{type:'string',enum:['formal','isolated']}}),required:['query']},annotations:{readOnlyHint:true}},
 {name:'ima_knowledge_get',description:'读取知识对象、专题、反向关联和当前正文。',inputSchema:{...jsonObject({object_key:string('稳定对象键',500),workspace:{type:'string',enum:['formal','isolated']}}),required:['object_key']},annotations:{readOnlyHint:true}},
 {name:'ima_knowledge_ingest',description:'全系统统一知识录入；图片原字节内嵌并附中文译文，正式图卡需ima阅读与重开验收。未知沿原号reconcile。',inputSchema:{...jsonObject({request_id:string('稳定请求号',200),policy_version:{type:'string',enum:['2.0.0']},mode:{type:'string',enum:['organize','archive']},object,material,entry,review,images,expected_version:{type:'integer',minimum:0},major_change:{type:'boolean'},confirmation:string('真实用户授权内容',4000),as_of:string('判断截至日期',10),change_summary:string('本次重要变化',4000),execute:{type:'boolean'},reconcile:{type:'boolean'},workspace:{type:'string',enum:['formal','isolated']}}),required:['request_id','policy_version','mode','material']},annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:false}}
];

const ingestSchema=knowledgeTools.find(t=>t.name==='ima_knowledge_ingest').inputSchema;
knowledgeTools.push({name:'ima_knowledge_consolidate',description:'已登记对象续版与多卡归并。先execute:false获取固定preview_hash，原号执行及reconcile。真实删除沿现有原生能力门槛；未登记原生项blocked。',inputSchema:{...jsonObject({...ingestSchema.properties,mode:{type:'string',enum:['organize']},merge_sources:{type:'array',minItems:1,maxItems:20,items:{...jsonObject({media_id:string('真实媒体ID',500),folder_id:string('真实目录ID',500),sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},object_key:string('已登记对象键',500),entry_id:string('稳定条目UUID',36),revision:{type:'integer',minimum:1}}),required:['media_id','folder_id','sha256']}},preview_hash:{type:'string',pattern:'^[a-f0-9]{64}$'},confirmation:{...jsonObject({text:string('真实用户确认内容',4000),preview_hash:{type:'string',pattern:'^[a-f0-9]{64}$'},delete_media_ids:{type:'array',minItems:1,maxItems:20,items:string('确认移除的具体媒体ID',500)}}),required:['text','preview_hash','delete_media_ids']}}),required:['request_id','policy_version','mode','object','entry','material','expected_version','merge_sources']},annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:true}});
