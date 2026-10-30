import {D1Store,runOperation,sha256} from './storage.js';
import {blobAccess,uploadBlob} from './blobs.js';
import {invokeIma,IMA_WRITE_ACTIONS} from './ima.js';
import {governance} from './governance.js';
import {cardAction,cardTools} from './cards.js';
import {adminAction,scopedStore} from './admin.js';
import {legacyTools} from './tool-definitions.js';
import {PAGE} from './page.js';
import {directoryAction,directoryTools,authorizeFolderCreate} from './directories.js';
import {sessionAction} from './ima-session.js';
import {authorizationKey,finishAuthorization} from './ima-session-relay.js';
import {moveAction,moveTools} from './moves.js';
import {contentAction,contentTools} from './content-mutations.js';
import {authorizeReplacementCreate} from './replacements.js';
import {knowledgeAction,knowledgeTools,knowledgeTransportAllowed} from './knowledge.js';

const S=(description,extra={})=>({type:'string',description,...extra});
const requestId=S('本次操作的稳定唯一请求号；恢复时沿用原号',{minLength:1,maxLength:200});
const ident=label=>S(label+'，从真实查询结果取得',{minLength:1,maxLength:1024});
const write=(name,description,properties,required)=>({name,description,inputSchema:{type:'object',properties:{...properties,request_id:requestId,execute:{type:'boolean',description:'用户明确要求执行时为true；默认仅预览'},reconcile:{type:'boolean',description:'仅核对原请求的未知结果，不重新写入'}},required:[...required,'request_id'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:name==='ima_delete_note',idempotentHint:true,openWorldHint:true}});
const read=(name,description,properties={},required=[])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}});
const existing=legacyTools.map(({name,description,inputSchema,annotations})=>structuredClone({name,description,inputSchema,annotations})).map(t=>{
  if(!t.annotations.readOnlyHint){t.inputSchema.properties.request_id=requestId;t.inputSchema.properties.reconcile={type:'boolean'};t.inputSchema.required=[...t.inputSchema.required,'request_id'];}
  if(t.name==='ima_append_note'){t.inputSchema.properties.expected_title=S('刚读取确认的原标题');t.inputSchema.required.push('expected_title');}
  if(['ima_list_notes','ima_search_notes','ima_get_note'].includes(t.name))t.inputSchema.properties.include_deleted={type:'boolean',description:'用户明确要求查看墓碑笔记时才启用，默认隐藏'};
  if(t.name==='ima_get_note')t.inputSchema.properties.title_hint=S('已知标题，用于辅助定位');
  if(t.name==='ima_attach_note_to_knowledge')t.description+=' 当前关联仅支持知识库根目录，不能传非空folder_id。';
  return t;
});
const extra=[
  read('ima_begin_connection','为用户本人本次新扫码登录提供云端公钥；仅供受控安装器密封授权包，不读取既有客户端会话。'),
  {name:'ima_verify_connection',description:'新扫码授权接入后校验并刷新ima登录；不会移动知识资料。刷新失败保留原会话状态，不自动重试或输出凭据。',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true}},
  {name:'ima_finish_connection',description:'接收受控安装器为本次新扫码生成的密封授权包；参数只含密文，禁止提交明文token或任意来源的授权包。接入不代表真实移动已验收。',inputSchema:{type:'object',additionalProperties:false,required:['envelope'],properties:{envelope:{type:'object',additionalProperties:false,required:['installation_id','issued_at','key_id','wrapped_key','iv','ciphertext'],properties:{installation_id:S('本次安装器生成的稳定编号',{minLength:16,maxLength:100}),issued_at:S('密封时间',{maxLength:40}),key_id:S('本次begin返回的公钥ID',{pattern:'^[a-f0-9]{64}$'}),wrapped_key:S('RSA包装的AES密钥，仅密文',{maxLength:512}),iv:S('随机IV的base64',{maxLength:24}),ciphertext:S('新会话的AES-GCM密文及认证标签',{maxLength:140000})}}}},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
  read('ima_connection_status','查看原生ima登录连接的脱敏状态；连接成功不等于真实移动已验收，不返回登录凭据。'),
  read('ima_hash_text','计算完整UTF-8正文的SHA-256，供审定证据绑定；不持久保存正文。',{content:S('要原样计算的完整正文',{maxLength:9000000})},['content']),
  write('ima_rename_note','改笔记标题，先核对原标题；正文保持不变。',{note_id:ident('笔记ID'),expected_title:S('原标题'),title:S('新标题',{minLength:1,maxLength:500})},['note_id','expected_title','title']),
  write('ima_delete_note','可恢复的笔记墓碑删除：给标题加【已删除】，保留原文；不等于永久删除知识库文件。',{note_id:ident('笔记ID'),expected_title:S('原标题')},['note_id','expected_title']),
  write('ima_restore_note','恢复墓碑笔记，核对当前标题并保留正文。',{note_id:ident('笔记ID'),expected_title:S('当前标题')},['note_id','expected_title']),
  write('ima_create_knowledge_base','明确要求时创建个人知识库并读回；接口不可用时停止。',{name:S('知识库名称',{minLength:1,maxLength:200})},['name']),
  write('ima_create_folder','明确要求时在指定库创建目录。正式知识卡仍沿用已登记11类，不以建目录自动改变分类规则。',{kb_id:ident('知识库ID'),folder_id:ident('父目录ID'),name:S('目录名称',{minLength:1,maxLength:200})},['kb_id','name']),
  write('ima_create_text_file','创建UTF-8文本文件并上传、原文读回。经核查的知识卡应使用ima_card系列工具。',{kb_id:ident('知识库ID'),folder_id:ident('目录ID'),filename:S('单个txt/md/markdown/html文件名'),content:S('完整正文',{minLength:1,maxLength:10000000})},['kb_id','filename','content']),
  write('ima_upload_file','上传已私有暂存的原始文件，保持字节；不能传本机文件路径。',{kb_id:ident('知识库ID'),folder_id:ident('目录ID'),blob_id:ident('上传返回的blob_id'),filename:S('原始文件名'),content_type:S('实际MIME'),sha256:S('上传返回的SHA256',{pattern:'^[a-f0-9]{64}$'})},['kb_id','blob_id','filename']),
  read('ima_read_media','读取ima条目原文；结果可能包含原文、哈希或受控私有blob引用。',{media_id:ident('媒体ID')},['media_id']),
  write('ima_export_media','把原文导出到私有材料区，返回下载引用及校验结果，不写服务器或用户的任意本机路径。',{media_id:ident('媒体ID')},['media_id']),
  read('ima_governance','读取共享政策、绑定、知识索引和版本；不修改分类政策。',{action:{type:'string',enum:['policy.get','bindings.get','cloud.verify','index.lookup','entry.get','directory.list']},primary_category:S('可选一级分类，用于目录树'),entry_id:S('稳定知识UUID'),version:S('版本号'),include_content:{type:'boolean'}},['action']),
];
export const TOOLS=[...existing,...extra,...cardTools,...directoryTools,...moveTools,...contentTools,...knowledgeTools];
export function validateArgs(value,schema,path='arguments'){
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error(path+' 必须是对象');
    for(const k of schema.required||[])if(!Object.hasOwn(value,k))throw Error('缺少必填参数 '+k);
    for(const [k,v]of Object.entries(value)){if(!Object.hasOwn(schema.properties||{},k)){if(schema.additionalProperties===false)throw Error('不支持的参数 '+k);continue;}validateArgs(v,schema.properties[k],path+'.'+k);}
  }else if(schema.type==='string'){
    if(typeof value!=='string'||!value.isWellFormed()||[...value].length<(schema.minLength||0)||[...value].length>(schema.maxLength||10000000)||schema.pattern&&!new RegExp(schema.pattern).test(value))throw Error(path+' 字符串无效');
  }else if(schema.type==='integer'){
    if(!Number.isInteger(value)||value<(schema.minimum??Number.MIN_SAFE_INTEGER)||value>(schema.maximum??Number.MAX_SAFE_INTEGER))throw Error(path+' 整数范围无效');
  }else if(schema.type==='boolean'){if(typeof value!=='boolean')throw Error(path+' 必须是布尔值');}
  else if(schema.type==='array'){
    if(!Array.isArray(value)||value.length<(schema.minItems||0)||value.length>(schema.maxItems||1000))throw Error(path+' 数组数量无效');
    if(schema.uniqueItems&&new Set(value.map(x=>JSON.stringify(x))).size!==value.length)throw Error(path+' 不允许重复');
    value.forEach((v,i)=>validateArgs(v,schema.items,path+'['+i+']'));
  }
  if(schema.enum&&!schema.enum.includes(value))throw Error(path+' 不在允许值中');
}
function clean(message,env,maxLength){let out=String(message);for(const k of ['IMA_OPENAPI_CLIENTID','IMA_OPENAPI_APIKEY','IMA_CLOUD_BRIDGE_TOKEN','IMA_SESSION_ENCRYPTION_KEY'])if(env[k])out=out.replaceAll(env[k],'[已隐藏]');return maxLength?out.slice(0,maxLength):out;}
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
function bridgeAllowed(request,env){const actual=request.headers.get('x-ima-bridge-token')||'',expected=env.IMA_CLOUD_BRIDGE_TOKEN||'';if(!expected||actual.length!==expected.length)return false;let different=0;for(let i=0;i<actual.length;i++)different|=actual.charCodeAt(i)^expected.charCodeAt(i);return different===0;}
function authenticated(request){return !!request.headers.get('oai-authenticated-user-id');}
function originAllowed(request){const origin=request.headers.get('origin');return !origin||origin===new URL(request.url).origin;}
async function bodyJson(request){const text=await request.text();if(new TextEncoder().encode(text).length>12*1024*1024)throw Error('JSON请求超过12MiB，请把大材料作为附件上传');const q=JSON.parse(text);if(!q||typeof q!=='object'||Array.isArray(q))throw Error('JSON对象必填');return q;}
export function context(env,workspace='formal'){
  const base=new D1Store(env.DB),store=scopedStore(base,workspace),blobs=blobAccess(env.BUCKET);
  const ctx={env,store,blobs,baseStore:base,workspace};
  ctx.invoke=async(domain,q)=>{
    const isWrite=IMA_WRITE_ACTIONS[domain]?.includes(q.action)&&q.execute&&!q.reconcile;
    if(isWrite){
      if(!await knowledgeTransportAllowed(ctx,domain,q))return {status:'blocked',request_id:q.request_id,message:'knowledge_ingest_required'};
      const migration=await base.get('settings','migration');if(migration?.frozen)return {status:'blocked',message:'治理数据正在迁移，保留请求，稍后继续。'};
      const service=await base.get('settings','service');if(!service?.ready)return {status:'blocked',message:'共享治理尚未完成初始化'};
      const bindings=await base.get('settings','bindings');
      if(q.kb_id){const active=await base.get('native_move_active',await sha256(env.IMA_OPENAPI_CLIENTID||'')+':'+q.kb_id);if(active&&!active.resolved)return {status:'blocked',message:'真实移动结果待核对，同库写入暂缓，请沿原移动请求核对。'};}
      if(q.kb_id){const active=await base.get('native_content_active',await sha256(env.IMA_OPENAPI_CLIENTID||'')+':'+q.kb_id);if(active&&!active.resolved)return {status:'blocked',message:'原生删除结果待核对，同库写入暂缓，请沿原删除请求核对。'};}
      if(q.kb_id&&q.kb_id===bindings?.kb_id&&!service.publication_enabled)return {status:'blocked',message:'正式渠道尚未启用发布'};
      if(domain==='kb'&&q.action==='text.create'&&q.request_id?.startsWith('edit-add-')){
        let found=false;for(const w of ['formal','isolated']){const store=scopedStore(base,w);if(await store.get('replacement_creates',q.request_id)){found=true;const actual=w===workspace?ctx:context(env,w),denied=await authorizeReplacementCreate(actual,q);if(denied)return denied;}}
        if(!found)return {status:'blocked',message:'ima_replacement_registered_create_required'};
      }
      if(domain==='kb'&&q.action==='folder.create'){
        for(const managedWorkspace of ['formal','isolated']){
          const managedBindings=await scopedStore(base,managedWorkspace).get('settings','bindings');
          if(q.kb_id===managedBindings?.kb_id){const actual=managedWorkspace===workspace?ctx:context(env,managedWorkspace);const denied=await authorizeFolderCreate(actual,q);if(denied)return denied;}
        }
      }
    }
    return runOperation(domain,q,{store:base,blobs,env,provider:invokeIma});
  };
  return ctx;
}
function mapped(name,a){
  const args={...a};const extra={...(args.request_id?{request_id:args.request_id}:{}),...(args.reconcile?{reconcile:true}:{})};
  switch(name){
    case 'ima_list_notebooks':return ['notes',{action:'list_notebooks',...args}];
    case 'ima_list_notes':return ['notes',{action:'list',...args}];
    case 'ima_search_notes':return ['notes',{action:'search',...args}];
    case 'ima_get_note':return ['notes',{action:'get',...args}];
    case 'ima_create_note':if(args.folder_name&&!args.folder_id)throw Error('请先查询笔记本取得folder_id');delete args.folder_name;return ['notes',{...args,action:'create',execute:true}];
    case 'ima_append_note':return ['notes',{...args,action:'append',execute:true}];
    case 'ima_rename_note':return ['notes',{action:'rename',...args}];
    case 'ima_delete_note':return ['notes',{action:'delete',...args}];
    case 'ima_restore_note':return ['notes',{action:'restore',...args}];
    case 'ima_list_knowledge_bases':return ['kb',{action:'kb.addable',...args}];
    case 'ima_search_knowledge_bases':return ['kb',{action:'kb.list',...args}];
    case 'ima_get_knowledge_bases':return ['kb',{action:'kb.get',ids:args.ids}];
    case 'ima_browse_knowledge':return ['kb',{action:'folder.list',kb_id:args.knowledge_base_id,folder_id:args.folder_id}];
    case 'ima_search_knowledge':return ['kb',{action:'knowledge.search',kb_id:args.knowledge_base_id,query:args.query}];
    case 'ima_get_media_info':return ['kb',{action:'media.info',...args}];
    case 'ima_import_webpages':return ['kb',{action:'url.import',kb_id:args.knowledge_base_id,folder_id:args.folder_id,urls:args.urls,...extra,execute:true}];
    case 'ima_attach_note_to_knowledge':return ['kb',{action:'note.associate',kb_id:args.knowledge_base_id,note_id:args.note_id,title:args.title,folder_id:args.folder_id,...extra,execute:true}];
    case 'ima_create_knowledge_base':return ['kb',{action:'kb.create',...args}];
    case 'ima_create_folder':return ['kb',{action:'folder.create',...args}];
    case 'ima_create_text_file':return ['kb',{action:'text.create',...args}];
    case 'ima_upload_file':return ['kb',{action:'file.upload',...args}];
    case 'ima_read_media':return ['kb',{action:'media.read',...args}];
    case 'ima_export_media':return ['kb',{action:'media.export',...args}];
    default:throw Error('未知工具');
  }
}
export async function dispatch(name,args,ctx){
  if(name.startsWith('ima_knowledge_')){
    const {workspace='formal',...q}=args,actual=workspace===ctx.workspace?ctx:context(ctx.env,workspace);
    const action={ima_knowledge_policy:'policy.get',ima_knowledge_search:'object.search',ima_knowledge_get:'object.get',ima_knowledge_ingest:'ingest',ima_knowledge_consolidate:'consolidate'}[name];
    if((await ctx.baseStore.get('settings','migration'))?.frozen&&['ingest','consolidate'].includes(action)&&!q.reconcile)return {status:'blocked',message:'migration_frozen'};
    return knowledgeAction({...q,action},actual);
  }
  if(contentTools.some(x=>x.name===name)){
    const {workspace='formal',...q}=args,actual=workspace===ctx.workspace?ctx:context(ctx.env,workspace);
    return contentAction(name,q,actual);
  }
  if(moveTools.some(x=>x.name===name)){
    const {workspace='formal',...q}=args,actual=workspace===ctx.workspace?ctx:context(ctx.env,workspace);
    return moveAction(name,q,actual);
  }
  if(name==='ima_begin_connection')return authorizationKey(ctx);
  if(name==='ima_verify_connection')return sessionAction('verify',{},ctx);
  if(name==='ima_finish_connection')return finishAuthorization(args.envelope,ctx);
  if(name==='ima_connection_status')return sessionAction('status',{},ctx);
  if(['ima_folder_plan','ima_folder_apply','ima_list_directories'].includes(name)){
    const {workspace='formal',...q}=args,actual=workspace===ctx.workspace?ctx:context(ctx.env,workspace);
    if(name!=='ima_list_directories'&&(await ctx.baseStore.get('settings','migration'))?.frozen)return {status:'blocked',message:'迁移期间暂停目录变更'};
    return directoryAction(name==='ima_folder_plan'?'plan':name==='ima_folder_apply'?'apply':'list',q,actual);
  }
  if(name==='ima_hash_text')return {status:'succeeded',sha256:await sha256(args.content),encoding:'UTF-8'};
  if(name.startsWith('ima_card_')){
    const {workspace='formal',...q}=args;const actual=workspace===ctx.workspace?ctx:context(ctx.env,workspace);
    if(!['ima_card_status','ima_card_list_pending','ima_card_reconcile'].includes(name)){
      if((await ctx.baseStore.get('settings','migration'))?.frozen)return {status:'blocked',message:'迁移期间暂停资料变更'};
      if(name==='ima_card_publish'&&!(await actual.store.get('settings','service'))?.publication_enabled)return {status:'blocked',message:'此渠道尚未启用发布'};
    }
    return cardAction(name,q,actual);
  }
  if(name==='ima_governance'){if(args.action==='directory.list'){const {action,...q}=args;return directoryAction('list',q,ctx);}return governance(args.action,args,ctx);}
  const [domain,q]=mapped(name,args);
  if(name==='ima_get_knowledge_bases'){
    const results=[];for(const kb_id of q.ids){const r=await ctx.invoke('kb',{action:'kb.get',kb_id});if(r.status!=='succeeded')return r;results.push(r.data);}return {status:'succeeded',data:results};
  }
  return ctx.invoke(domain,q);
}
async function mcp(request,env,bridgeAuthenticated=false){
  if(request.method!=='POST')return json({error:'POST JSON-RPC required'},405);
  const message=await bodyJson(request),{id=null,method,params={}}=message;
  if(message.jsonrpc!=='2.0'||typeof method!=='string'||!params||typeof params!=='object')return json({jsonrpc:'2.0',id,error:{code:-32600,message:'Invalid request'}},400);
  const ok=result=>json({jsonrpc:'2.0',id,result});
  if(method==='server/discover')return ok({supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
  if(method==='initialize')return ok({protocolVersion:params.protocolVersion||'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ima-knowledge-cloud',version:'2.6.1'},instructions:'每次保存或补充先调用ima_knowledge_policy核对真实能力和目标绑定，并结合ima_knowledge_search及原生检索读取候选全文。没有相同对象才用ima_knowledge_ingest新建；已有已登记主卡更新和多卡归并使用ima_knowledge_consolidate，先预览再按实际授权执行。概念标题只用名称，独立问题用完整问句；同一具体事物整合成完整主卡，保留来源、论证、分歧及历史。多张既有卡移除和重大改写先展示具体方案取得真实用户确认。verification_pending沿原request_id和完整载荷reconcile分段继续，不另起写入；成功收据、主卡读回及相应清理/索引核验齐全才完成。未登记旧卡或能力未就绪时保留预览。archive保留原貌，图片及目录仍遵守独立门禁。'});
  if(method.startsWith('notifications/'))return new Response(null,{status:202});
  if(method==='ping')return ok({});
  if(method==='tools/list')return ok({tools:TOOLS.map(({name,description,inputSchema,annotations})=>({name,description,inputSchema,annotations}))});
  if(method!=='tools/call')return json({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}});
  if(!authenticated(request)&&!bridgeAuthenticated)return json({jsonrpc:'2.0',id,error:{code:-32001,message:'需要ChatGPT所有者身份'}},401);
  const def=TOOLS.find(t=>t.name===params.name);if(!def)return ok({isError:true,content:[{type:'text',text:'未知工具'}]});
  try{
    const args=params.arguments??{};validateArgs(args,def.inputSchema);const result=await dispatch(def.name,args,context(env));
    const bad=!['succeeded','preview','already_indexed','tombstoned'].includes(result.status);
    const blocks=[{type:'text',text:clean(JSON.stringify(result),env)}];
    if(def.name==='ima_card_status'&&args.include_content&&Array.isArray(result.card?.images)){
      const ctx=context(env,args.workspace||'formal');
      for(const image of result.card.images.slice(0,10)){
        const blob=await ctx.blobs.get(image.blob_key);const mime=blob?.httpMetadata?.contentType;
        if(!blob||blob.size>2*1024*1024||!['image/png','image/jpeg','image/webp'].includes(mime))continue;
        const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
        blocks.push({type:'image',data:btoa(binary),mimeType:mime});
      }
    }
    return ok({...(bad?{isError:true}:{}),content:blocks});
  }catch(e){return ok({isError:true,content:[{type:'text',text:clean(e.message,env,4000)}]});}
}
export default {
  async fetch(request,env){
    try{
      const path=new URL(request.url).pathname;
      if(!originAllowed(request))return json({status:'forbidden'},403);
      if(path==='/mcp')return mcp(request,env);
      if(path==='/'&&request.method==='GET')return new Response(PAGE,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'"}});
      const bridge=path.startsWith('/bridge/v1/');
      if(bridge?!bridgeAllowed(request,env):!authenticated(request))return json({status:'forbidden',message:'需要所有者或受控本机桥接身份'},401);
      if(path==='/bridge/v1/mcp')return mcp(request,env,true);
      const ctx=context(env);
      if((path==='/bridge/v1/blobs'||path==='/api/blobs')&&request.method==='POST')return json(await uploadBlob(request,ctx));
      if((path.startsWith('/api/blobs/')||path.startsWith('/bridge/v1/blobs/'))&&request.method==='GET'){
        const key=decodeURIComponent(path.split('/blobs/')[1]);const object=await ctx.blobs.get(key);if(!object)return json({status:'not_found'},404);
        return new Response(object.body,{headers:{'content-type':'application/octet-stream','content-disposition':'attachment','cache-control':'no-store','x-content-type-options':'nosniff'}});
      }
      if(path==='/bridge/v1/admin/import'&&request.method==='POST')return json(await adminAction(await bodyJson(request),ctx));
      if(path==='/bridge/v1/session'&&request.method==='POST'){
        const {action,...q}=await bodyJson(request);
        return json(await sessionAction(action,q,ctx));
      }
      if(bridge&&request.method==='POST'){
        const domain=path.slice('/bridge/v1/'.length),q=await bodyJson(request);
        if(domain==='knowledge'){
          const {workspace='formal',...args}=q;
          if(!['formal','isolated'].includes(workspace))return json({status:'invalid_input',message:'invalid_workspace'});
          if((await ctx.baseStore.get('settings','migration'))?.frozen&&['ingest','consolidate'].includes(args.action)&&!args.reconcile)return json({status:'blocked',message:'migration_frozen'});
          return json(await knowledgeAction(args,workspace===ctx.workspace?ctx:context(env,workspace)));
        }
        if(['notes','kb'].includes(domain)){
          const result=await ctx.invoke(domain,q);
          if(q.action==='media.read'&&result.data?.blob_id)result.data.download_url=new URL('/bridge/v1/blobs/'+result.data.blob_id,request.url).href;
          return json(result);
        }
        if(domain==='governance'){
          if(q.action==='operation.get')return json({status:'succeeded',operation:await ctx.store.get('operations',q.request_id)});
          if(q.action==='operation.absence'){
            const service=await ctx.store.get('settings','service'),migration=await ctx.store.get('settings','migration');
            if(!service?.ready||migration?.frozen)return json({status:'unavailable',absent:false});
            return json({status:'succeeded',absent:!(await ctx.store.get('operations',q.request_id))});
          }
          if(q.action==='directory.list')return json(await directoryAction('list',Object.fromEntries(Object.entries(q).filter(([k])=>k!=='action')),ctx));
          if(q.action==='service.health'){
            const service=await ctx.store.get('settings','service'),policy=await governance('policy.get',{},ctx),bindings=await governance('bindings.get',{},ctx);
            if(policy.status!=='succeeded'||bindings.status!=='succeeded')return json({status:'unavailable',ready:false});
            return json({status:'succeeded',ready:service?.ready===true,publication_enabled:service?.publication_enabled===true,policy_version:policy.policy.policy_version,kb_id:bindings.bindings.kb_id});
          }
          return json(await governance(q.action,q,ctx));
        }
        if(domain==='directories'){
          const {workspace='formal',action,...args}=q;const name=action==='plan'?'ima_folder_plan':action==='apply'?'ima_folder_apply':action==='list'?'ima_list_directories':null;const def=TOOLS.find(t=>t.name===name);if(!def)return json({status:'unsupported'});validateArgs({...args,workspace},def.inputSchema);return json(await dispatch(name,{...args,workspace},ctx));
        }
        if(domain==='moves'){
          const {action,workspace='formal',...args}=q;
          const name={bind:'ima_bind_move_workspace',preview:'ima_move_preview',execute:'ima_move_execute',reconcile:'ima_move_reconcile'}[action];
          const def=TOOLS.find(t=>t.name===name);if(!def)return json({status:'unsupported'});validateArgs({...args,workspace},def.inputSchema);return json(await dispatch(name,{...args,workspace},ctx));
        }
        if(domain==='cards'){
          const {workspace='formal',action,...args}=q;
          if(action==='cards.list'){
            const actual=workspace==='isolated'?context(env,'isolated'):ctx;const cards=[];let cursor='';
            do{const page=await actual.store.list('cards',{limit:100,cursor});for(const {value:row} of page.items){
              if(row.task_id!==args.task_id)continue;
              const item={...row};
              if(row.review_key){const obj=await actual.blobs.get(row.review_key);if(obj)item.review_source=JSON.parse(await obj.text()).mode;}
              if(row.publication_key){const obj=await actual.blobs.get(row.publication_key);if(obj){const pub=JSON.parse(await obj.text()),op=await ctx.baseStore.get('operations',pub.request_id);item.publication={entry_id:row.entry_id,version:row.entry_version||pub.governance_request.entry.version,media_id:row.media_id,request_id:pub.request_id,receipt:op?.receipt};}}
              cards.push(item);
            }cursor=page.has_more?page.next_cursor:'';}while(cursor);
            return json({status:'succeeded',cards});
          }
          return json(await dispatch('ima_card_'+String(action).replace(/^card\./,''),{...args,workspace},ctx));
        }
      }
      if(path==='/api/overview'&&request.method==='GET'){
        const p=await governance('policy.get',{},ctx),b=await governance('bindings.get',{},ctx),service=await ctx.store.get('settings','service');
        return json({status:p.status==='succeeded'&&b.status==='succeeded'?'succeeded':'unavailable',version:'2.5.2',policy_version:p.policy?.policy_version||null,knowledge_base:b.bindings?.kb_name||null,service,material_storage:'private',migration:await ctx.store.get('settings','migration')});
      }
      if(path==='/api/directories'&&request.method==='GET')return json(await directoryAction('list',{},ctx));
      if(path==='/api/ima-session/status'&&request.method==='GET')return json(await sessionAction('status',{},ctx));
      if(path==='/api/ima-session/revoke'&&request.method==='POST')return json(await sessionAction('revoke',{},ctx));
      if(path==='/api/pending'&&request.method==='GET')return json(await cardAction('list_pending',{limit:50},ctx));
      if(path==='/api/check'&&request.method==='POST')return json(await ctx.invoke('kb',{action:'kb.addable'}));
      return json({status:'not_found'},404);
    }catch(e){return json({status:'unavailable',message:clean(e.message,env,4000)},503);}
  }
};
