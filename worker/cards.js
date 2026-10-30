import {governance,settings,sha,packed,requiredText,fields,fail,webUrl,currentEntryVersion} from './governance.js';
import {withShortLease} from './storage.js';
import {resolveDirectory} from './directories.js';
import {withMovePublicationLease,projectCurrentLocation} from './move-index.js';

const str=(description,maxLength=10000)=>({type:'string',description,minLength:1,maxLength});
const obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const arr=(items,maxItems=50)=>({type:'array',items,maxItems});
const id=str('服务返回的稳定卡片 ID',200),hashSchema={...str('服务返回或按原文字节计算的 SHA-256',64),pattern:'^[a-f0-9]{64}$'};
const category=str('政策登记的主分类 code',80),expected={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER,description:'当前乐观版本；已有卡片内容变更必须匹配'};
const source=obj({kind:{type:'string',enum:['url','book','personal','provided_material']},locator:str('来源定位',4000),author:str('原作者',500),title:str('来源标题',500),published_date:str('发布日期',10)},['kind','locator']);
const relation=obj({from_card_id:id,to_card_id:id,relation:str('有语义的关联类型',100),reason:str('为什么关联，保留不同来源',4000)});
const image=obj({blob_key:str('已明确提交的私有图片 blob key',1000),sha256:hashSchema},['blob_key','sha256']);
const intakeProps={directory_id:str('已登记的真实目标目录 ID；不参与内容 hash',500),source_id:str('明确提交的来源 ID',500),source_url:str('来源 HTTP(S) URL',4000),title:str('卡片标题',80),content:str('明确提交的完整原稿，永久保留',9000000),kind:{type:'string',enum:['fact','ir_opinion','life_opinion']},source_locator:str('来源中的定位',4000),category,card_id:id,task_id:str('导入时保留的外部任务 ID',200),legacy_input_hash:str('导入时原系统旧 hash，另行保留',200),expected_version:expected,author:str('观点主张者',500),context:str('观点适用语境',4000),tags:arr(str('标签',80),20),sources:arr(source),images:arr(image,20),relations:arr(relation,100)};
const evidence=obj({url:str('宿主实际打开核查的 URL',4000),locator:str('来源内定位',4000),supports:str('支持的具体断言',4000),excerpt:str('实际核查的原文摘录',10000),checked_at:str('实际核查时间，必须带时区',100),checker:str('实际核查者',500),input_hash:hashSchema,revision_hash:hashSchema,category});
const reviewProps={card_id:id,expected_version:expected,input_hash:hashSchema,mode:{type:'string',enum:['web_verified']},verdict:{type:'string',enum:['pass','revise','uncertain','reject']},rationale:str('实际判断和理由',4000),content:str('完整审定正文',9000000),revision_hash:hashSchema,category,policy_version:{type:'string',enum:['1.0.0','1.1.0']},evidence:{type:'array',items:evidence,minItems:0,maxItems:50}};
function tool(name,description,inputSchema,readOnlyHint=false){return {name,description,inputSchema:{...inputSchema,properties:{...inputSchema.properties,workspace:{type:'string',enum:['formal','isolated'],description:'可选；由main选择正式或test_隔离存储后剥离，不传入业务处理函数。'}}},annotations:{readOnlyHint,destructiveHint:false,idempotentHint:true,openWorldHint:!readOnlyHint}};}
export const cardTools=[
 tool('ima_card_route','选择后续发布使用的已登记同分类目录；独立保存路由与有效审核。未完成发布时禁止改目标；已发布卡仅影响下一版本，不移动历史文件。',obj({card_id:id,directory_id:str('已登记的真实目标目录 ID',500),expected_version:expected},['card_id','directory_id'])),
 tool('ima_card_intake','明确提交原稿/图片快照或导入待审卡。保留原稿；外部ID与旧hash可追溯，更新需乐观版本。',obj(intakeProps,['source_id','title','content','kind','source_locator','category'])),
 tool('ima_card_review_submit','记录一次实际 web_verified 核查与证据；证据绑定输入、审定正文和分类。存疑保留待审，不捏造历史审核。',obj(reviewProps)),
 tool('ima_card_publish','将已审定卡按正式政策 prepare→防重放写入→远程读回索引；未知保持原请求号，禁止重发。',obj({card_id:id})),
 tool('ima_card_status','读取私有卡片状态；include_content 可读取原稿与审定稿，或按entry_id读取已登记条目原文。',obj({card_id:id,entry_id:str('已登记条目UUID',36),version:str('条目版本',20),include_content:{type:'boolean'}},[]),true),
 tool('ima_card_list_pending','分页列出尚未完整发布的私有卡片。',obj({limit:{type:'integer',minimum:1,maximum:100},cursor:{type:'string',maxLength:1000}},[]),true),
 tool('ima_card_reconcile','仅按原请求号只读恢复未知发布；成功收据与远程原文完全一致后才 published。',obj({card_id:id}))
];
function validate(v,s,path='arguments'){
 if(s.type==='object'){fields(v,Object.keys(s.properties),s.required);for(const [k,x]of Object.entries(v))validate(x,s.properties[k],path+'.'+k);}
 else if(s.type==='array'){if(!Array.isArray(v)||v.length<(s.minItems||0)||v.length>(s.maxItems??50))fail(path+'_array');v.forEach(x=>validate(x,s.items,path));}
 else if(s.type==='string'){requiredText(v,path,s.maxLength);if(s.pattern&&!new RegExp(s.pattern).test(v))fail(path+'_pattern');}
 else if(s.type==='integer'){if(!Number.isSafeInteger(v)||v<(s.minimum??0)||v>(s.maximum??Number.MAX_SAFE_INTEGER))fail(path+'_integer');}
 else if(s.type==='boolean'&&typeof v!=='boolean')fail(path+'_boolean');
 if(s.enum&&!s.enum.includes(v))fail(path+'_enum');
}
async function uuid5(name){const ns=new Uint8Array([0x6b,0xa7,0xb8,0x11,0x9d,0xad,0x11,0xd1,0x80,0xb4,0x00,0xc0,0x4f,0xd4,0x30,0xc8]);const value=new TextEncoder().encode('knowledge-card-flow:'+name),bytes=new Uint8Array(ns.length+value.length);bytes.set(ns);bytes.set(value,ns.length);const h=new Uint8Array(await crypto.subtle.digest('SHA-1',bytes)).slice(0,16);h[6]=(h[6]&15)|80;h[8]=(h[8]&63)|128;const s=Array.from(h,x=>x.toString(16).padStart(2,'0')).join('');return [s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join('-');}
async function putJson(ctx,key,value){await ctx.blobs.put(key,JSON.stringify(value),{contentType:'application/json; charset=utf-8'});return key;}
async function readJson(ctx,key){const blob=await ctx.blobs.get(key);if(!blob)fail('private_blob_missing','verification_pending');return JSON.parse(await blob.text());}
async function load(ctx,id){const row=await ctx.store.get('cards',id);if(!row)fail('card_not_found','not_found');return row;}
async function content(ctx,row){return {...row,...await readJson(ctx,row.snapshot_key),original:await readJson(ctx,row.original_key),...(row.review_key?{review:await readJson(ctx,row.review_key)}:{}),...(row.publication_key?{publication:await readJson(ctx,row.publication_key)}:{})};}
async function lock(ctx,id,fn){return withShortLease(ctx,'card:'+id,fn);}
function checkCategory(p,c){if(!p.categories.some(x=>x.code===c))fail('primary_category_not_registered');}
async function target(ctx,category,directory_id){
 const {p,b}=await settings(ctx);
 if(directory_id&&directory_id!==b.categories[category]?.folder_id&&p.policy_version!=='1.1.0')fail('directory_policy_upgrade_required','conflict');
 const resolved=await resolveDirectory(ctx,category,directory_id);
 return Object.fromEntries(['directory_id','folder_id','kb_id','primary_category','depth','path'].map(k=>[k,resolved[k]]));
}
async function saveRoute(ctx,row,directory_id,expected_version){
 if(expected_version!==undefined&&row.version!==expected_version)fail('stale_card_route','conflict');
 if(row.publication_key&&row.status!=='published')fail('publication_in_progress_route_frozen','conflict');
 const snapshot=await readJson(ctx,row.snapshot_key),review=row.review_key?await readJson(ctx,row.review_key):null;
 const category=review?.category||snapshot.category,directory_snapshot=await target(ctx,category,directory_id);
 const old=await ctx.store.get('card_routes',row.card_id);
 if(old?.directory_id===directory_snapshot.directory_id&&old.primary_category===category)return {status:'succeeded',card:{...row,route:old},replayed:true};
 const route={card_id:row.card_id,...directory_snapshot,revision:(old?.revision||0)+1,updated_at:new Date().toISOString()};
 await ctx.store.put('card_routes',row.card_id,route);
 const next={...row,version:row.version+1};await ctx.store.put('cards',row.card_id,next);
 return {status:'succeeded',card:{...next,route}};
}
async function route(q,ctx){return lock(ctx,q.card_id,async ctx=>saveRoute(ctx,await load(ctx,q.card_id),q.directory_id,q.expected_version));}
// 1.1 changes directory policy only. A review's attested category (which may
// already correct the intake category) is still checked against every evidence
// record and the resolved target; routing never changes these attestations.
function compatibleReview(r,p){return r.policy_version===p.policy_version||(r.policy_version==='1.0.0'&&p.policy_version==='1.1.0');}

async function intake(q,ctx){
 const {p}=await settings(ctx);checkCategory(p,q.category);if(q.source_url)webUrl(q.source_url);if(q.kind!=='fact'){requiredText(q.author,'opinion_author',500);requiredText(q.context,'opinion_context',4000);}
 const sources=structuredClone(q.sources||[]);if(q.source_url&&!sources.some(x=>x.locator===q.source_url))sources.push({kind:'url',locator:q.source_url,...(q.author?{author:q.author}:{})});if(!sources.some(x=>x.locator===q.source_id+' / '+q.source_locator))sources.push({kind:'provided_material',locator:q.source_id+' / '+q.source_locator,...(q.author?{author:q.author}:{})});for(const s of sources)if(s.kind==='url')webUrl(s.locator);
 const images=[];for(const image of q.images||[]){const blob=await ctx.blobs.get(image.blob_key);if(!blob)fail('image_blob_missing');const bytes=await blob.arrayBuffer();if(await sha(bytes)!==image.sha256)fail('image_hash_mismatch');const type=blob.httpMetadata?.contentType;if(!type?.startsWith('image/'))fail('image_content_type_required');const blob_key='cards/images/'+image.sha256;await ctx.blobs.put(blob_key,bytes,{contentType:type});images.push({blob_key,sha256:image.sha256,contentType:type});}
 const task_id=q.task_id||'task_'+await sha(q.source_id),card_id=q.card_id||'card_'+await sha(packed({task_id,locator:q.source_locator}));
 const snapshot={source_id:q.source_id,...(q.source_url?{source_url:q.source_url}:{}),title:q.title,content:q.content,kind:q.kind,source_locator:q.source_locator,category:q.category,sources,images,tags:q.tags||[],relations:q.relations||[],...(q.author?{author:q.author}:{}),...(q.context?{context:q.context}:{}),...(q.legacy_input_hash?{legacy_input_hash:q.legacy_input_hash}:{})};
 for(const rel of snapshot.relations){if(rel.from_card_id!==card_id||rel.to_card_id===card_id)fail('relation_origin_invalid');await load(ctx,rel.to_card_id);}
 const input_hash=await sha(packed(snapshot));return lock(ctx,card_id,async(ctx)=>{const old=await ctx.store.get('cards',card_id);if(old){if(old.input_hash===input_hash)return q.directory_id?saveRoute(ctx,old,q.directory_id,q.expected_version):{status:'succeeded',card:old,replayed:true};if(q.expected_version!==old.version||(old.publication_key&&old.status!=='published'))fail('stale_card_or_publication_in_progress','conflict');const prior=await readJson(ctx,old.snapshot_key);if(old.task_id!==task_id||prior.source_id!==q.source_id)fail('external_identity_mismatch','conflict');}
 const priorPublication=old?.publication_key?await readJson(ctx,old.publication_key):null;
 const priorRoute=await ctx.store.get('card_routes',card_id)||(priorPublication?{directory_id:priorPublication.transport_request.folder_id,revision:0}:null);
 const directory_snapshot=q.directory_id?await target(ctx,q.category,q.directory_id):priorRoute?await target(ctx,q.category,priorRoute.directory_id):null;
 if(!await ctx.store.create('card_tasks',task_id,{task_id,source_id:q.source_id})){const task=await ctx.store.get('card_tasks',task_id);if(task?.source_id!==q.source_id)fail('external_task_source_mismatch','conflict');}
 const snapshot_key='cards/'+await sha(card_id)+'/snapshots/'+input_hash+'.json';await putJson(ctx,snapshot_key,snapshot);const row={card_id,task_id,entry_id:await uuid5(card_id),input_hash,version:(old?.version||0)+1,status:'pending_review',created_at:old?.created_at||new Date().toISOString(),snapshot_key,original_key:old?.original_key||snapshot_key,...(q.legacy_input_hash?{legacy_input_hash:q.legacy_input_hash}:{})};
 if(old){await ctx.store.create('card_history',card_id+':'+old.version,old);await ctx.store.put('cards',card_id,row);}else if(!await ctx.store.create('cards',card_id,row))fail('concurrent_card_intake','conflict');await ctx.store.create('card_tasks',task_id,{task_id,source_id:q.source_id});
 if(directory_snapshot){const route={card_id,...directory_snapshot,revision:(priorRoute?.revision||0)+1,updated_at:new Date().toISOString()};await ctx.store.put('card_routes',card_id,route);return {status:'succeeded',card:{...row,route}};}
 return {status:'succeeded',card:row};});
}
export function knowledgeDate(value){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));}
async function review(q,ctx){if(q.verdict==='pass'&&!q.evidence.length)fail('evidence_required_for_pass');return lock(ctx,q.card_id,async(ctx)=>{const row=await load(ctx,q.card_id);if(row.version!==q.expected_version||row.input_hash!==q.input_hash||row.publication_key)fail('stale_review','conflict');const {p}=await settings(ctx);if(q.policy_version!==p.policy_version)fail('review_policy_mismatch','conflict');checkCategory(p,q.category);if(await sha(q.content)!==q.revision_hash)fail('revision_hash_mismatch','conflict');
 for(const e of q.evidence){webUrl(e.url);if(e.input_hash!==row.input_hash||e.revision_hash!==q.revision_hash||e.category!==q.category)fail('evidence_binding_mismatch','conflict');if(!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(e.checked_at)||!Number.isFinite(Date.parse(e.checked_at))||Date.parse(e.checked_at)>Date.now()+300000)fail('checked_at_invalid');}
 const review={...q,created_at:new Date().toISOString(),attestation:'host_web_verified'};const review_key='cards/'+await sha(row.card_id)+'/reviews/'+await sha(packed(review))+'.json';await putJson(ctx,review_key,review);await ctx.store.create('card_history',row.card_id+':'+row.version,row);const next={...row,review_key,version:row.version+1,status:q.verdict==='pass'?'reviewed':'pending_review'};await ctx.store.put('cards',row.card_id,next);return {status:'succeeded',card:next};});}
async function finish(ctx,row,publication,receipt){
 const result=receipt?.status==='succeeded'&&receipt?.receipt?.status?receipt.receipt:receipt;const ids=result?.resource?.media_ids;
 if(result?.status!=='succeeded'||!Array.isArray(ids)||ids.length!==1){const next={...row,status:result?.status==='unknown'?'unknown':'verification_pending'};await ctx.store.put('cards',row.card_id,next);return {status:next.status,card:{...next,publication}};}
 const commit=await governance('index.commit',{...publication.governance_request,action:'index.commit',media_id:ids[0]},ctx);if(commit.status!=='succeeded'){const next={...row,status:commit.status==='unknown'?'unknown':'verification_pending'};await ctx.store.put('cards',row.card_id,next);return {...commit,card:{...next,publication}};}
 const index=await governance('index.lookup',{entry_id:row.entry_id},ctx);const registered=index.versions?.find(x=>x.request_id===publication.request_id&&x.version===publication.governance_request.entry.version&&x.media_id===ids[0]&&x.content_sha256===publication.content_sha256);if(index.status!=='succeeded'||!registered)return {status:'verification_pending',card:row};
 const next=await projectCurrentLocation(ctx,{...row,status:'published',version:row.version+1,media_id:ids[0],entry_version:registered.version},publication.transport_request.kb_id);await ctx.store.put('cards',row.card_id,next);return {status:'succeeded',card:{...next,publication},index:registered};
}
async function recover(ctx,row){if(!row.publication_key)return {status:'blocked',message:'publication_not_prepared',card:row};const pub=await readJson(ctx,row.publication_key);if(row.status==='published'){const next=await projectCurrentLocation(ctx,row,pub.transport_request.kb_id);if(next!==row)await ctx.store.put('cards',row.card_id,next);return {status:'succeeded',card:{...next,publication:pub},replayed:true};}let receipt;try{receipt=await ctx.invoke('kb',{...pub.transport_request,execute:true,reconcile:true});}catch{return {status:'unknown',card:{...row,publication:pub},request_id:pub.request_id};}return finish(ctx,row,pub,receipt);}
async function publish(q,ctx,reconcile=false){
 const {b}=await settings(ctx);
 return withMovePublicationLease(ctx,b.kb_id,async ctx=>{
  const active=await (ctx.baseStore||ctx.store).get('native_move_active',b.account_sha256+':'+b.kb_id);
  if(active&&!active.resolved)return {status:'blocked',message:'ima_move_pending_operation_requires_reconcile'};
  return lock(ctx,q.card_id,async(ctx)=>{let row=await load(ctx,q.card_id);if(row.publication_key||reconcile)return recover(ctx,row);if(row.status!=='reviewed'||!row.review_key)return {status:'blocked',message:'verified_review_required',card:row};const snapshot=await readJson(ctx,row.snapshot_key),r=await readJson(ctx,row.review_key);const {p,b}=await settings(ctx);if(r.mode!=='web_verified'||r.verdict!=='pass'||r.input_hash!==row.input_hash||r.revision_hash!==await sha(r.content)||!compatibleReview(r,p)||!r.evidence.length)fail('review_no_longer_bound','conflict');for(const e of r.evidence)if(e.input_hash!==row.input_hash||e.revision_hash!==r.revision_hash||e.category!==r.category)fail('evidence_no_longer_bound','conflict');
 const route=await ctx.store.get('card_routes',row.card_id),directory_snapshot=await target(ctx,r.category,route?.directory_id);
 const lookup=await governance('index.lookup',{entry_id:row.entry_id},ctx);if(lookup.status!=='succeeded')return lookup;const last=lookup.latest;const entryVersion=last?(BigInt(currentEntryVersion(last).split('.')[0])+1n)+'.0':'1.0';const sources=[...snapshot.sources];for(const e of r.evidence)if(!sources.some(s=>s.locator===e.url))sources.push({kind:'url',locator:e.url});
 let body=r.content;if(snapshot.kind!=='fact')body+='\n\n主张者：'+snapshot.author+'\n语境：'+snapshot.context+'\n';if(snapshot.relations.length)body+='\n\n关联与理由：\n'+snapshot.relations.map(x=>'- '+x.to_card_id+'（'+x.relation+'）：'+x.reason).join('\n')+'\n';
 const entry={entry_id:row.entry_id,version:entryVersion,title:snapshot.title,primary_category:r.category,content_type:snapshot.kind==='fact'?'concept':'viewpoint',content_natures:['ai_synthesis'],sources,verification:'verified',verification_note:'宿主实际来源核查；模式 web_verified；审定 SHA-256：'+r.revision_hash,created_date:knowledgeDate(row.created_at),updated_date:knowledgeDate(r.created_at),body,life_goals:[],human_dimensions:[],tags:snapshot.tags,aliases:[],...(last?{previous_version:currentEntryVersion(last)}:{}),...(r.category==='inbox'?{classification_reason:'宿主尚不能确定主分类，待后续整理'}:{}),...(p.policy_version==='1.1.0'?{directory_id:directory_snapshot.directory_id}:{})};
 const request_id='kcf_'+await sha(packed({entry,policy_version:p.policy_version,account_sha256:b.account_sha256,kb_id:b.kb_id,folder_id:directory_snapshot.folder_id,workspace:ctx.workspace||'formal'})),governance_request={action:'entry.prepare',policy_version:p.policy_version,request_id,entry};const prepared=await governance('entry.prepare',governance_request,ctx);if(prepared.status!=='preview')return prepared;
 if(!route)await ctx.store.put('card_routes',row.card_id,{card_id:row.card_id,...prepared.directory_snapshot,revision:1,updated_at:new Date().toISOString()});
 const pub={request_id,governance_request,directory_snapshot:prepared.directory_snapshot,transport_request:prepared.transport_request,content_sha256:prepared.artifact.content_sha256,input_hash:row.input_hash,revision_hash:r.revision_hash};const publication_key='cards/'+await sha(row.card_id)+'/publications/'+request_id+'.json';await putJson(ctx,publication_key,pub);row={...row,status:'unknown',publication_key};await ctx.store.put('cards',row.card_id,row);
 // Persist dispatch intent atomically before calling the transport. A crash stays recover-only.
 if(!await ctx.store.create('card_dispatches',request_id,{card_id:row.card_id,input_hash:row.input_hash,revision_hash:r.revision_hash}))return recover(ctx,row);
 let receipt;try{receipt=await ctx.invoke('kb',{...prepared.transport_request,execute:true});}catch{return {status:'unknown',request_id,card:{...row,publication:pub}};}return finish(ctx,row,pub,receipt);
 });
 });}
export async function cardAction(action,q,ctx){try{const normalized=String(action).replace(/^ima_card_/,'').replace(/^card\./,'');const name='ima_card_'+normalized,def=cardTools.find(t=>t.name===name);if(!def)return {status:'unsupported',message:'unknown_card_action'};const args={...q};if('workspace' in args)fail('workspace_must_be_resolved_by_main');if('action'in args){if(![action,normalized,'card.'+normalized,name].includes(args.action))fail('action_mismatch');delete args.action;}validate(args,def.inputSchema);
 if(normalized==='route')return await route(args,ctx);if(normalized==='intake')return await intake(args,ctx);if(normalized==='review_submit')return await review(args,ctx);if(normalized==='publish'||normalized==='reconcile')return await publish(args,ctx,normalized==='reconcile');
 if(normalized==='status'){if(Boolean(args.card_id)===Boolean(args.entry_id))fail('exactly_one_card_or_entry_id_required');if(args.entry_id)return governance('entry.get',{entry_id:args.entry_id,...(args.version?{version:args.version}:{}),...(args.include_content!==undefined?{include_content:args.include_content}:{})},ctx);const row=await load(ctx,args.card_id);const route=await ctx.store.get('card_routes',row.card_id);return {status:'succeeded',card:{...(args.include_content?await content(ctx,row):row),...(route?{route}:{})}};}
 const page=await ctx.store.list('cards',{limit:args.limit||50,cursor:args.cursor||'',prefix:''});return {status:'succeeded',...page,items:page.items.filter(x=>x.value.status!=='published')};
 }catch(e){return {status:e.status||'unavailable',message:e.status?e.message:'card_storage_or_transport_error'};}}
