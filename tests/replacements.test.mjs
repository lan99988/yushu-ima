import test from 'node:test';
import assert from 'node:assert/strict';
import {context} from '../worker/app.js';
import {runtime} from './fixtures/runtime.mjs';
import {contract} from './fixtures/cloud-context.mjs';
import {sha256,stable} from '../worker/storage.js';
import {sessionAction} from '../worker/ima-session.js';
import {moveAction} from '../worker/moves.js';
import {contentAction} from '../worker/content-mutations.js';
import {projectCurrentLocation} from '../worker/move-index.js';
const api=await import('../worker/replacements.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});

async function fixture(){
 const env={...runtime(),IMA_SESSION_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')},ctx=context(env,'isolated'),b={...structuredClone(contract.bindings),account_sha256:await sha256(env.IMA_OPENAPI_CLIENTID)};
 await ctx.store.put('settings','bindings',b);await ctx.store.put('settings','policy',contract.policy);await ctx.store.put('settings','service',{publication_enabled:true});
 await ctx.baseStore.put('settings','bindings',{...b,kb_id:'formal-kb'});await ctx.baseStore.put('settings','service',{ready:true,publication_enabled:true});
 await sessionAction('install',{installation_id:'replacement-fixture-login-01',account_info:{userId:'replacement-user',token:'access',refreshToken:'refresh',tokenExpiredTime:Date.now()+7200000,refreshTokenExpiredTime:Date.now()+86400000}},ctx);
 ctx.sessionFetcher=async()=>Response.json({code:0,token:'renewed',token_valid_time:7200});await sessionAction('verify',{},ctx);
 const nativeId='7000000000000002',folder=b.categories.learning.folder_id,oldId='old-'+nativeId,files=new Map([[oldId,{content:'# 测试\n\n旧正文。\n',title:'测试.md',parent:folder}]]);let deletes=0,deleteMode='success';
 const roots=Object.values(b.categories).map(x=>({media_id:x.folder_id,title:x.folder_name,media_type:99,parent_folder_id:nativeId,file_size:'0',md5_sum:''}));
 const item=([id,f])=>({media_id:id,title:f.title,parent_folder_id:f.parent,media_type:7,file_size:String(new TextEncoder().encode(f.content).length),md5_sum:'md5-'+id});
 const list=id=>id?[...files].filter(([,f])=>f.parent===id).map(item):roots;
 ctx.nativeFetcher=async(url,options)=>{const q=JSON.parse(options.body);
  if(url.endsWith('/get_knowledge_list'))return Response.json({code:0,knowledge_base_info:{id:nativeId},current_path:[{folder_id:nativeId,name:b.kb_name,parent_folder_id:''},...(q.folder_id?[{folder_id:q.folder_id,name:roots.find(x=>x.media_id===q.folder_id).title,parent_folder_id:nativeId}]:[])],knowledge_list:list(q.folder_id),is_end:true});
  if(url.endsWith('/get_knowledge'))return files.has(q.media_id)?Response.json({code:0,knowledge:item([q.media_id,files.get(q.media_id)])}):Response.json({code:404});
  assert.ok(url.endsWith('/del_knowledge'));deletes++;if(deleteMode==='unknown')throw Error('timeout');for(const id of q.media_ids)files.delete(id);return Response.json({code:0,results:q.media_ids.map(media_id=>({media_id,ret_code:0}))});
 };
 ctx.invoke=async(_,q)=>{if(q.action==='kb.get')return {status:'succeeded',data:{knowledge_base:{name:b.kb_name}}};
  if(q.action==='folder.list')return {status:'succeeded',data:{items:list(q.folder_id).map(x=>({...x,kind:x.media_type===99?'folder':'file'})),has_more:false}};
  if(q.action==='media.read'){const file=files.get(q.media_id);if(!file)return {status:'not_found'};return {status:'succeeded',data:{content:file.content,size:new TextEncoder().encode(file.content).length,sha256:await sha256(file.content)}};}throw Error('unexpected provider operation');};
 assert.equal((await moveAction('ima_bind_move_workspace',{native_knowledge_base_id:nativeId},ctx)).status,'succeeded');
 const preview=(id='edit-1',new_content='# 测试\n\n新正文。\n')=>contentAction('ima_edit_preview',{request_id:id,media_id:oldId,folder_id:folder,new_content},ctx);
 const upload=async p=>{const plan=p.replacement_plan,args=plan.create_arguments,id='new-'+await sha256(plan.request_id)+'-'+nativeId;
  files.set(id,{content:args.content,title:args.filename,parent:folder});
  const receipt={status:'succeeded',resource:{action:'text.create',kb_id:b.kb_id,folder_id:folder,filename:args.filename,content_sha256:await sha256(args.content),media_ids:[id]},receipt:{input_sha256:await sha256(args.content),input_size:new TextEncoder().encode(args.content).length,stages:{readback:'verified'}}};
  await ctx.baseStore.put('operations',args.request_id,{request_id:args.request_id,domain:'kb',status:'succeeded',request:{action:'text.create',...args},receipt});return id;};
 const deletePreview=p=>contentAction('ima_delete_preview',p.replacement_plan.delete_arguments,ctx);
 const execute=p=>contentAction('ima_delete_execute',{request_id:p.request_id,preview_hash:p.preview_hash},ctx);
 return {env,ctx,b,oldId,folder,files,preview,upload,deletePreview,execute,deletes:()=>deletes,setDeleteMode:x=>deleteMode=x};
}

test('edit preview persists candidate and original backup before exposing explicit create then delete actions',async()=>{
 const f=await fixture(),p=await f.preview();assert.equal(p.status,'preview',JSON.stringify(p));assert.equal(p.replacement_plan?.mode,'create_then_delete');assert.equal(f.deletes(),0);
 assert.equal(p.replacement_plan.create_tool,'ima_create_text_file');assert.equal(p.replacement_plan.delete_tool,'ima_delete_preview');
 assert.notEqual(p.replacement_plan.create_arguments.filename,'测试.md');assert.ok(await f.ctx.store.get('replacements',p.request_id));assert.ok(p.backup?.blob_key);
 assert.equal((await f.deletePreview(p)).status,'blocked');assert.equal(f.files.has(f.oldId),true);f.env.close();
});
test('verified new card precedes native old deletion and switches current index without rewriting historical evidence',async()=>{
 const f=await fixture(),historical={media_id:f.oldId,review_key:'old-audit',content_sha256:await sha256(f.files.get(f.oldId).content),folder_id:f.folder};await f.ctx.store.put('governance_index','original',historical);await f.ctx.store.put('cards','card',historical);
 const p=await f.preview(),newId=await f.upload(p),d=await f.deletePreview(p);assert.equal(d.status,'preview',JSON.stringify(d));assert.equal(f.files.has(f.oldId),true);const r=await f.execute(d);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(f.deletes(),1);
 assert.equal(f.files.has(newId),true);assert.equal(f.files.has(f.oldId),false);assert.equal(r.replacement?.new_media_id,newId);assert.equal(r.replacement?.status,'succeeded');
 const row=await f.ctx.store.get('governance_index','original');assert.equal(row.media_id,f.oldId);assert.equal(row.review_key,'old-audit');assert.equal(row.current_content.media_id,newId);assert.equal(row.current_content.review_status,'pending');assert.equal(row.current_content.sha256,await sha256(f.files.get(newId).content));
 assert.equal((await contentAction('ima_content_capabilities',{},f.ctx)).replacement_isolated_verified,true);
 const replay=await f.execute(d);assert.equal(replay.replacement.new_media_id,newId);assert.equal(f.deletes(),1);f.env.close();
});
test('new content corruption and old content drift both block removal',async()=>{
 for(const which of ['old','new']){const f=await fixture(),p=await f.preview(),id=await f.upload(p);f.files.get(which==='old'?f.oldId:id).content='外部修改';const d=await f.deletePreview(p);assert.ok(['conflict','blocked','verification_pending'].includes(d.status),JSON.stringify(d));assert.equal(f.deletes(),0);assert.equal(f.files.has(f.oldId),true);f.env.close();}
});
test('delete dispatch rechecks the new file after immutable delete preview',async()=>{
 const f=await fixture(),p=await f.preview(),id=await f.upload(p),d=await f.deletePreview(p);assert.equal(d.status,'preview');f.files.delete(id);assert.notEqual((await f.execute(d)).status,'succeeded');assert.equal(f.deletes(),0);assert.equal(f.files.has(f.oldId),true);f.env.close();
});
test('unknown deletion keeps both the new card and original request, then reconciles only indexes',async()=>{
 const f=await fixture(),p=await f.preview(),id=await f.upload(p),d=await f.deletePreview(p);f.setDeleteMode('unknown');assert.equal((await f.execute(d)).status,'unknown');assert.equal(f.files.has(id),true);assert.equal(f.files.has(f.oldId),true);assert.equal((await f.execute(d)).status,'unknown');assert.equal(f.deletes(),1);
 f.files.delete(f.oldId);const r=await contentAction('ima_delete_reconcile',{request_id:d.request_id},f.ctx);assert.equal(r.status,'succeeded');assert.equal(r.replacement.new_media_id,id);assert.equal(f.deletes(),1);assert.equal((await contentAction('ima_content_capabilities',{},f.ctx)).replacement_isolated_verified,false);f.env.close();
});
test('replacement creation is bound to the exact stored candidate and same library location',async()=>{
 const f=await fixture(),p=await f.preview();assert.equal(typeof api.authorizeReplacementCreate,'function');const args={...p.replacement_plan.create_arguments,action:'text.create'};
 assert.equal(await api.authorizeReplacementCreate(f.ctx,args),null);
 for(const patch of [{content:'不同正文'},{folder_id:'wrong'},{filename:'other.md'},{kb_id:'formal-kb'}]){const r=await api.authorizeReplacementCreate(f.ctx,{...args,...patch});assert.equal(r.status,'conflict',JSON.stringify(r));}
 f.env.close();
});
test('governed Markdown keeps identity/source JSON, versions the revision and does not inherit verified status',async()=>{
 assert.equal(typeof api.revisionArtifact,'function');const metadata={entry_id:'uuid',version:'1.0',title:'标题',primary_category:'learning',sources:[{kind:'book',locator:'p1'}],verification:'verified',body_sha256:await sha256('旧正文\n'),created_date:'2026-10-25'};
 const raw='# 标题\n\n```json\n'+JSON.stringify(metadata,null,2)+'\n```\n\n---\n\n旧正文\n';
 const layoutOnly=await api.revisionArtifact(raw,'旧正文\n','标题__概念__v1.0.md','2026-10-28');assert.ok(layoutOnly.content.startsWith('# 标题\n\n旧正文\n\n---\n'));await assert.rejects(()=>api.revisionArtifact(layoutOnly.content,layoutOnly.content,layoutOnly.filename,'2026-10-28'),/no_content_change/);
 const r=await api.revisionArtifact(raw,'新正文\n','标题__概念__v1.0.md','2026-10-28');assert.equal(r.filename,'标题__概念__v1.1.md');assert.match(r.content,/新正文/);const m=JSON.parse(r.content.match(/```json\n([\s\S]*?)\n```/)[1]);
 assert.ok(r.content.startsWith('# 标题\n\n新正文\n\n---\n\n```json\n'));assert.ok(r.content.trimEnd().endsWith('```'));
 assert.equal(m.entry_id,metadata.entry_id);assert.deepEqual(m.sources,metadata.sources);assert.equal(m.version,'1.1');assert.equal(m.previous_version,'1.0');assert.equal(m.verification,'pending');assert.equal(m.body_sha256,await sha256('新正文\n'));assert.equal(m.updated_date,'2026-10-28');
 const second=await api.revisionArtifact(r.content,'再修订正文\n',r.filename,'2026-10-28');assert.equal(second.version,'1.2');assert.ok(second.content.startsWith('# 标题\n\n再修订正文\n\n---\n\n```json\n'));const secondMeta=JSON.parse(second.content.match(/```json\n([\s\S]*?)\n```/)[1]);assert.equal(secondMeta.body_sha256,await sha256('再修订正文\n'));assert.equal(secondMeta.entry_id,metadata.entry_id);
 const read=await api.revisionArtifact('# 普通卡\n\n原文\n','# 普通卡\n\n新文\n','plain.md','2026-10-28');assert.equal(read.content,'# 普通卡\n\n新文\n');assert.match(read.filename,/修订/);
});
test('ambiguous metadata is blocked instead of dropped; request replay never changes the stored candidate',async()=>{
 assert.equal(typeof api.revisionArtifact,'function');await assert.rejects(()=>api.revisionArtifact('# 标题\n\n```json\n{broken\n','新正文','x.md','2026-10-28'));
 const f=await fixture(),p=await f.preview('same');assert.equal((await f.preview('same')).replacement_plan.request_id,p.request_id);assert.equal((await f.preview('same','另一个正文')).status,'conflict');f.env.close();
});

test('a succeeded creation can be replayed after old deletion without creating another revision',async()=>{
 const f=await fixture(),p=await f.preview();await f.upload(p);const d=await f.deletePreview(p);assert.equal((await f.execute(d)).status,'succeeded');
 assert.equal(await api.authorizeReplacementCreate(f.ctx,{...p.replacement_plan.create_arguments,action:'text.create'}),null);assert.equal(f.deletes(),1);f.env.close();
});
test('the isolated replacement acceptance record can recover after a transient database write failure',async()=>{
 const f=await fixture(),p=await f.preview();await f.upload(p);const d=await f.deletePreview(p),put=f.ctx.baseStore.put.bind(f.ctx.baseStore);let failed=false;
 f.ctx.baseStore.put=async(c,k,v)=>{if(c==='native_replacement_validation'&&!failed){failed=true;throw Error('transient validation storage failure');}return put(c,k,v);};
 assert.equal((await f.execute(d)).status,'verification_pending');const r=await contentAction('ima_delete_reconcile',{request_id:d.request_id},f.ctx);assert.equal(r.status,'succeeded');assert.equal((await contentAction('ima_content_capabilities',{},f.ctx)).replacement_isolated_verified,true);assert.equal((await projectCurrentLocation(f.ctx,{media_id:f.oldId},f.b.kb_id)).current_content.state,'replaced');assert.equal(f.deletes(),1);f.env.close();
});
test('late historical rows resolve both current content and position using the replacement file ID',async()=>{
 const f=await fixture(),p=await f.preview(),id=await f.upload(p),d=await f.deletePreview(p);assert.equal((await f.execute(d)).status,'succeeded');
 await f.ctx.store.put('media_locations',stable({kb_id:f.b.kb_id,media_id:id}),{media_id:id,folder_id:'moved-folder'});
 const row=await projectCurrentLocation(f.ctx,{media_id:f.oldId,review_key:'original'},f.b.kb_id);assert.equal(row.current_content.media_id,id);assert.equal(row.current_location.folder_id,'moved-folder');assert.equal(row.review_key,'original');f.env.close();
});

test('deleting the current replacement updates historical aliases to the actual deleted state',async()=>{
 const f=await fixture();await f.ctx.store.put('governance_index','history',{media_id:f.oldId,review_key:'original'});const p=await f.preview(),id=await f.upload(p),d=await f.deletePreview(p);assert.equal((await f.execute(d)).status,'succeeded');
 const remove=await contentAction('ima_delete_preview',{request_id:'remove-current',media_id:id,folder_id:f.folder},f.ctx);assert.equal((await f.execute(remove)).status,'succeeded');
 const stored=await f.ctx.store.get('governance_index','history');assert.equal(stored.current_content.state,'deleted_from_knowledge_base');assert.equal((await projectCurrentLocation(f.ctx,{media_id:f.oldId},f.b.kb_id)).current_content.state,'deleted_from_knowledge_base');assert.equal(stored.review_key,'original');f.env.close();
});
test('a late historical row follows consecutive replacements to the final live card',async()=>{
 const f=await fixture(),p=await f.preview(),middle=await f.upload(p),d=await f.deletePreview(p);assert.equal((await f.execute(d)).status,'succeeded');
 const next=await contentAction('ima_edit_preview',{request_id:'next-revision',media_id:middle,folder_id:f.folder,new_content:'# 测试\n\n第三版正文。\n'},f.ctx),last=await f.upload(next),remove=await f.deletePreview(next);assert.equal((await f.execute(remove)).status,'succeeded');
 const late=await projectCurrentLocation(f.ctx,{media_id:f.oldId,review_key:'original'},f.b.kb_id);assert.equal(late.current_content.media_id,last);assert.equal(late.current_content.state,'replaced');assert.equal(late.current_location.media_id,last);f.env.close();
});
test('cyclic replacement aliases fail closed instead of pointing at a deleted intermediate file',async()=>{
 const f=await fixture();await f.ctx.store.put('media_content_states',stable({kb_id:f.b.kb_id,media_id:f.oldId}),{state:'replaced',media_id:'second'});await f.ctx.store.put('media_content_states',stable({kb_id:f.b.kb_id,media_id:'second'}),{state:'replaced',media_id:f.oldId});
 await assert.rejects(()=>projectCurrentLocation(f.ctx,{media_id:f.oldId},f.b.kb_id),/ima_replacement_projection_cycle/);f.env.close();
});
