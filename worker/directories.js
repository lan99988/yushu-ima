import {settings,fail,requiredText} from './governance.js';
import {withShortLease,sha256,stable} from './storage.js';

const now=()=>new Date().toISOString();
const string={type:'string',minLength:1,maxLength:1000};
const workspace={type:'string',enum:['formal','isolated']};
const tool=(name,description,properties,required,readOnlyHint=false)=>({name,description,inputSchema:{type:'object',properties:{...properties,workspace},required,additionalProperties:false},annotations:{readOnlyHint,destructiveHint:false,idempotentHint:true,openWorldHint:true}});
export const directoryTools=[
 tool('ima_folder_plan','查询已有目录并提出本批带编号完整路径；只保存提案，不创建远端目录。修改方案后必须重新询问用户。',{primary_category:string,paths:{type:'array',minItems:1,maxItems:100,items:{type:'object',properties:{topics:{type:'array',minItems:1,items:{type:'string',minLength:1,maxLength:80}},purpose:string,card_ids:{type:'array',items:string}},required:['topics','purpose'],additionalProperties:false}},plan_id:string,expected_revision:{type:'integer',minimum:1}},['primary_category','paths']),
 tool('ima_folder_apply','用户确认本批具体路径后才创建、逐层读回并登记；拒绝则不创建。confirmation是宿主记录的真实用户回复，不是核实后入库的泛化授权。未知结果沿原提案reconcile。',{plan_id:string,revision:{type:'integer',minimum:1},decision:{type:'string',enum:['confirm','decline']},confirmation:{type:'string',minLength:1,maxLength:4000},reconcile:{type:'boolean'}},['plan_id','revision','decision','confirmation']),
 tool('ima_list_directories','读取已登记目录树及真实ID；优先复用已有目录，不按名称猜ID。',{primary_category:string},[],true),
];
const topicOf=name=>String(name).replace(/^\d+[_\s.-]+/u,'').normalize('NFKC').trim();
const same=(a,b)=>topicOf(a).toLocaleLowerCase()===topicOf(b).toLocaleLowerCase();
const safeTopic=value=>{const t=requiredText(value,'directory_topic',80).trim();if(t!==value||!t||t==='.'||t==='..'||/[\\/:*?"<>|\x00-\x1f\x7f]/u.test(t)||/^\d+[_\s.-]/u.test(t))fail('directory_topic_requires_plain_safe_name');return t;};
async function rows(ctx,collection){const out=[];let cursor='',seen=new Set();do{const p=await ctx.store.list(collection,{limit:100,cursor});out.push(...p.items.map(x=>x.value));if(!p.has_more)break;if(!p.next_cursor||seen.has(p.next_cursor))fail('directory_pagination_incomplete','unavailable');seen.add(p.next_cursor);cursor=p.next_cursor;}while(true);return out;}
function root(b,category){if(!Object.hasOwn(b.categories,category))fail('primary_category_not_registered');const r=b.categories[category];return {directory_id:r.folder_id,folder_id:r.folder_id,kb_id:b.kb_id,primary_category:category,parent_folder_id:null,name:r.folder_name,topic:topicOf(r.folder_name),depth:1,path:[{directory_id:r.folder_id,name:r.folder_name}],status:'ready'};}
export async function resolveDirectory(ctx,category,directory_id){
 const {b}=await settings(ctx);const top=root(b,category);if(!directory_id||directory_id===top.directory_id)return top;
 const record=await ctx.store.get('directories',directory_id);if(!record||record.status!=='ready'||record.kb_id!==b.kb_id||record.primary_category!==category)fail('directory_category_or_registration_mismatch','conflict');
 const chain=[],seen=new Set();let item=record;
 while(item.directory_id!==top.directory_id){if(seen.has(item.directory_id))fail('directory_cycle','conflict');seen.add(item.directory_id);if(item.kb_id!==b.kb_id||item.primary_category!==category||item.status!=='ready')fail('directory_ancestor_category_mismatch','conflict');chain.unshift({directory_id:item.directory_id,name:item.name});if(item.parent_folder_id===top.directory_id)break;item=await ctx.store.get('directories',item.parent_folder_id);if(!item)fail('directory_parent_missing','conflict');}
 const path=[...top.path,...chain];if(record.depth!==path.length)fail('directory_depth_mismatch','conflict');return {...record,folder_id:record.directory_id,path};
}
async function siblings(ctx,b,parent){const r=await ctx.invoke('kb',{action:'folder.list',kb_id:b.kb_id,folder_id:parent});if(r.status!=='succeeded'||r.data?.has_more!==false||!Array.isArray(r.data?.items))fail('directory_parent_readback_incomplete','verification_pending');return r.data.items.filter(x=>x.kind==='folder'||String(x.media_id).startsWith('folder_'));}
function dispatchEvidence(value){
 if(value==null)return false;
 if(typeof value==='string'){try{value=JSON.parse(value);}catch{return true;}}
 if(!value||typeof value!=='object'||Array.isArray(value))return true;
 if(value.dispatched_at||value.invocation_id||value.running_until||value.stage||Object.keys(value.stages||{}).length)return true;
 // kb_id and parent_folder_id describe the input scope, not a created resource.
 if(value.resource&&Object.entries(value.resource).some(([k,v])=>k!=='kb_id'&&k!=='parent_folder_id'&&/(^|_)ids?$/.test(k)&&(Array.isArray(v)?v.length:!!v)))return true;
 return ['state','receipt'].some(k=>value[k]!=null&&dispatchEvidence(value[k]));
}
async function undispatched(ctx,value,node){
 if(node.kind!=='create')return true;
 if(node.directory_id||node.state==='ready'||dispatchEvidence(node.receipt))return false;
 if(!node.request_id)return node.state==='proposed';
 const op=await (ctx.baseStore||ctx.store).get('operations',node.request_id);
 // runOperation durably reserves before any provider call. No row plus a bare
 // intent (or an explicit invoke gate block) proves we never reached it. An
 // unknown/unavailable response without that ledger proof stays reconcile-only.
 if(!op)return !node.receipt||node.receipt.status==='blocked';
 if(!['reserved','blocked'].includes(op.status)||dispatchEvidence(op))return false;
 const r=op.request,ref=r?._folder_plan;
 return op.domain==='kb'&&r?.action==='folder.create'&&r.request_id===node.request_id&&r.kb_id===value.kb_id&&r.folder_id===node.actual_parent_id&&r.name===node.name&&ref?.plan_id===value.plan_id&&ref.revision===value.revision&&ref.node_id===node.node_id;
}
async function allUndispatched(ctx,value){for(const node of value.nodes)if(!await undispatched(ctx,value,node))return false;return true;}
async function plan(q,ctx){
 const {p,b}=await settings(ctx);root(b,q.primary_category);if(!Array.isArray(q.paths)||!q.paths.length||q.paths.length>100)fail('directory_paths_required');
 return withShortLease(ctx,'governance:directory-plans:'+b.kb_id,async ctx=>{
  const previous=q.plan_id?await ctx.store.get('directory_plans',q.plan_id):null;
  if(q.plan_id&&(!previous||previous.revision!==q.expected_revision||!['proposed','needs_revision','applying'].includes(previous.status)||!await allUndispatched(ctx,previous)))fail('directory_plan_revision_conflict','conflict');
  if(previous)await ctx.store.create('directory_plan_history',previous.plan_id+':'+previous.revision,previous);
  const id=q.plan_id||'folder_plan_'+crypto.randomUUID(),revision=(previous?.revision||0)+1,top=root(b,q.primary_category),nodes=[],targets=[],cache=new Map(),byPath=new Map();
  const registered=await rows(ctx,'directories');
  for(const path of q.paths){
   if(!Array.isArray(path.topics)||!path.topics.length)fail('directory_topics_required');requiredText(path.purpose,'directory_purpose',1000);if(path.card_ids&&(!Array.isArray(path.card_ids)||path.card_ids.some(x=>typeof x!=='string'||!x)))fail('directory_card_ids_invalid');
   let parent=top.directory_id,full=top.path,depth=1,node;
   for(const raw of path.topics){const topic=safeTopic(raw),pathKey=parent+'\0'+topic.toLocaleLowerCase();
    if(byPath.has(pathKey)){node=byPath.get(pathKey);parent=node.directory_id||'proposed:'+node.node_id;full=node.path;depth=node.depth;continue;}
    let list=cache.get(parent);if(!list){list=parent.startsWith('proposed:')?[]:await siblings(ctx,b,parent);cache.set(parent,list);}
    const matches=list.filter(x=>same(x.title,topic)||registered.some(r=>r.directory_id===x.media_id&&(r.aliases||[]).some(a=>same(a,topic))));if(matches.length>1)fail('directory_ambiguous_existing_name','conflict');
    const found=matches[0],existing=found&&registered.find(r=>r.directory_id===found.media_id),number=found?Number(String(found.title).match(/^\d+/)?.[0]||0):Math.max(0,...list.map(x=>Number(String(x.title).match(/^\d+/)?.[0]||0)))+1;
    if(existing&&(existing.kb_id!==b.kb_id||existing.primary_category!==q.primary_category||existing.parent_folder_id!==parent))fail('directory_existing_registry_drift','conflict');
    const name=found?found.title:String(number).padStart(2,'0')+'_'+topic,node_id='node_'+await sha256(pathKey);
    node={node_id,parent_ref:parent,name,topic,number,purpose:path.purpose,aliases:[],depth:depth+1,kind:existing?'reuse':found?'adopt':'create',...(found?{directory_id:found.media_id}:{}),path:[...full,{directory_id:found?.media_id||null,name}],state:existing?'ready':'proposed'};
    nodes.push(node);byPath.set(pathKey,node);if(!found)list.push({media_id:'proposed:'+node_id,title:name,kind:'folder'});parent=node.directory_id||'proposed:'+node_id;full=node.path;depth=node.depth;
   }
   targets.push({node_id:node.node_id,card_ids:path.card_ids||[],path:full});
  }
  const value={plan_id:id,revision,status:'proposed',policy_version:p.policy_version,kb_id:b.kb_id,account_sha256:b.account_sha256,primary_category:q.primary_category,nodes,targets,created_at:previous?.created_at||now(),updated_at:now(),needs_confirmation:nodes.some(n=>n.kind!=='reuse')};
  await ctx.store.put('directory_plans',id,value);return {status:'preview',plan:value};
 });
}
export async function authorizeFolderCreate(ctx,q){
 const reference=q._folder_plan;if(!reference)return {status:'blocked',message:'confirmed_directory_plan_required'};
 const plan=await ctx.store.get('directory_plans',reference.plan_id),node=plan?.nodes.find(n=>n.node_id===reference.node_id);
 if(!plan||plan.revision!==reference.revision||plan.status!=='applying'||!plan.confirmation||!node||node.kind!=='create'||node.request_id!==q.request_id||plan.kb_id!==q.kb_id||node.actual_parent_id!==q.folder_id||node.name!==q.name)return {status:'conflict',message:'directory_confirmation_or_target_mismatch'};
 return null;
}
async function apply(q,ctx){
 requiredText(q.plan_id,'directory_plan_id',200);if(!Number.isInteger(q.revision)||!['confirm','decline'].includes(q.decision))fail('directory_decision_or_revision_required');requiredText(q.confirmation,'explicit_user_confirmation_required',4000);
 const {p,b}=await settings(ctx);if(p.policy_version!=='1.1.0')return {status:'blocked',message:'directory_policy_upgrade_required'};
 return withShortLease(ctx,'governance:directory-plans:'+b.kb_id,async ctx=>{
  let value=await ctx.store.get('directory_plans',q.plan_id);
  if(!value||value.revision!==q.revision||value.kb_id!==b.kb_id||value.account_sha256!==b.account_sha256)fail('directory_plan_revision_or_scope_conflict','conflict');
  if(value.status==='applied')return {status:'succeeded',plan:value,replayed:true};
  if(value.status==='declined'){if(q.decision!=='decline')fail('directory_plan_already_declined','conflict');return {status:'succeeded',plan:value,replayed:true};}
  if(q.decision==='confirm'&&value.status==='needs_revision')return {status:'conflict',message:'directory_plan_revision_required',plan:value};
  if(q.decision==='decline'){if(!['proposed','needs_revision','applying'].includes(value.status)||!await allUndispatched(ctx,value))fail('directory_creation_already_started','conflict');value={...value,status:'declined',confirmation:{text:q.confirmation,source:'host_recorded_user_reply',revision:q.revision,at:now()},fallback:'use_suitable_existing_directory'};await ctx.store.put('directory_plans',value.plan_id,value);return {status:'succeeded',plan:value};}
  if(value.status==='proposed'){value={...value,status:'applying',confirmation:{text:q.confirmation,source:'host_recorded_user_reply',revision:q.revision,at:now()}};await ctx.store.put('directory_plans',value.plan_id,value);}
  for(const node of value.nodes){
   if(node.state==='ready')continue;
   const parent=node.parent_ref.startsWith('proposed:')?value.nodes.find(n=>n.node_id===node.parent_ref.slice(9)):null;
   const parentId=parent?parent.directory_id:node.parent_ref;if(!parentId)fail('directory_parent_not_ready','verification_pending');
   const parentRecord=await resolveDirectory(ctx,value.primary_category,parentId);node.actual_parent_id=parentId;
   if(node.kind==='create'){
    const started=!!node.request_id,canContinue=started&&await undispatched(ctx,value,node);
    if(started&&!canContinue&&!q.reconcile)return {status:'verification_pending',message:'directory_unknown_requires_original_reconcile',plan:value};
    if(!started||canContinue){const listing=await siblings(ctx,b,parentId);if(listing.some(x=>x.title===node.name||same(x.title,node.topic)||Number(String(x.title).match(/^\d+/)?.[0]||0)===node.number)){value.status='needs_revision';await ctx.store.put('directory_plans',value.plan_id,value);return {status:'conflict',message:'directory_parent_changed_replan_required',plan:value};}if(!started)node.request_id='dir_'+await sha256(stable({plan_id:value.plan_id,revision:value.revision,node_id:node.node_id,kb_id:b.kb_id,parentId,name:node.name}));node.state='unknown';await ctx.store.put('directory_plans',value.plan_id,value);}
    const request={action:'folder.create',kb_id:b.kb_id,folder_id:parentId,name:node.name,request_id:node.request_id,execute:true,...(started&&!canContinue?{reconcile:true}:{}),_folder_plan:{plan_id:value.plan_id,revision:value.revision,node_id:node.node_id}};
    let r;try{r=await ctx.invoke('kb',request);}catch{r={status:'unknown'};}
    node.receipt=r;await ctx.store.put('directory_plans',value.plan_id,value);
    if(r.status!=='succeeded'||!r.resource?.folder_id)return {status:r.status==='succeeded'?'verification_pending':r.status,plan:value,request_id:node.request_id};node.directory_id=r.resource.folder_id;
   }
   const actual=await siblings(ctx,b,parentId);if(!actual.some(x=>x.media_id===node.directory_id&&x.title===node.name))return {status:'verification_pending',message:'directory_created_parent_readback_pending',plan:value};
   const record={directory_id:node.directory_id,folder_id:node.directory_id,kb_id:b.kb_id,primary_category:value.primary_category,parent_folder_id:parentId,name:node.name,topic:node.topic,number:node.number,depth:parentRecord.depth+1,path:[...parentRecord.path,{directory_id:node.directory_id,name:node.name}],purpose:node.purpose,aliases:node.aliases,status:'ready',verified_at:now(),creation_request_id:node.request_id||null,plan_id:value.plan_id,plan_revision:value.revision};
   const old=await ctx.store.get('directories',node.directory_id);if(old&&(old.kb_id!==record.kb_id||old.parent_folder_id!==record.parent_folder_id||old.name!==record.name))fail('directory_registration_conflict','conflict');
   if(!old&&!await ctx.store.create('directories',node.directory_id,record))fail('directory_registration_concurrent_conflict','conflict');node.state='ready';node.path=record.path;await ctx.store.put('directory_plans',value.plan_id,value);
  }
  value={...value,status:'applied',completed_at:now()};await ctx.store.put('directory_plans',value.plan_id,value);return {status:'succeeded',plan:value};
 });
}
export async function directoryAction(action,q,ctx){try{
 if(action==='plan')return await plan(q,ctx);if(action==='apply')return await apply(q,ctx);
 if(action==='list'){const {b}=await settings(ctx);const categories=q.primary_category?[q.primary_category]:Object.keys(b.categories);const result=categories.map(c=>root(b,c));for(const r of await rows(ctx,'directories'))if(categories.includes(r.primary_category)&&r.kb_id===b.kb_id)result.push(await resolveDirectory(ctx,r.primary_category,r.directory_id));return {status:'succeeded',directories:result};}
 return {status:'unsupported',message:'unknown_directory_action'};
 }catch(e){return {status:e.status||'unavailable',message:e.status?e.message:'directory_storage_or_transport_error'};}}
