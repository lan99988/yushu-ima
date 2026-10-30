import test from 'node:test';
import assert from 'node:assert/strict';
import {TOOLS,context,dispatch} from '../worker/app.js';
import {runtime} from './fixtures/runtime.mjs';
import {contract} from './fixtures/cloud-context.mjs';
import {sha256,stable} from '../worker/storage.js';
import {sessionAction} from '../worker/ima-session.js';
import {moveAction} from '../worker/moves.js';

test('real move has separate binding, immutable preview and reconcile tools',()=>{
 for(const name of ['ima_bind_move_workspace','ima_move_preview','ima_move_execute','ima_move_reconcile']){
  const tool=TOOLS.find(x=>x.name===name);assert.ok(tool,`${name} missing`);
  assert.equal(tool.inputSchema.additionalProperties,false);
 }
 assert.equal(TOOLS.find(x=>x.name==='ima_move_execute').annotations.readOnlyHint,false);
});

async function fixture(){
 const e={...runtime(),IMA_SESSION_ENCRYPTION_KEY:Buffer.alloc(32,5).toString('base64')},ctx=context(e,'isolated');
 const b={...structuredClone(contract.bindings),account_sha256:await sha256(e.IMA_OPENAPI_CLIENTID)};
 await ctx.store.put('settings','bindings',b);await ctx.store.put('settings','policy',contract.policy);
 await ctx.baseStore.put('settings','bindings',{...b,kb_id:'formal-kb'});
 await ctx.baseStore.put('settings','service',{ready:true,publication_enabled:true});await ctx.store.put('settings','service',{publication_enabled:true});
 await sessionAction('install',{installation_id:'move-fixture-login-00001',account_info:{userId:'move-user',token:'access',refreshToken:'refresh',tokenExpiredTime:Date.now()+7200000,refreshTokenExpiredTime:Date.now()+86400000}},ctx);
 ctx.sessionFetcher=async()=>Response.json({code:0,token:'renewed',token_valid_time:7200});await sessionAction('verify',{},ctx);
 const tree=new Map(),parents=new Map(),names=new Map(),nativeId='7000000000000002';
 tree.set('',[]);let moves=0,resumes=0,mode='success';
 function folder(id,parent,title){const item={media_id:id,title,media_type:99,parent_folder_id:parent,file_size:'0',md5_sum:''};tree.set(id,[]);tree.get(parent).push(item);parents.set(id,parent);names.set(id,title);return item;}
 function file(id,parent,title,content){const item={media_id:id,title,media_type:7,parent_folder_id:parent,file_size:String(new TextEncoder().encode(content).length),md5_sum:'stable-md5'};tree.get(parent).push(item);contents.set(id,content);return item;}
 const contents=new Map();for(const r of Object.values(b.categories))folder(r.folder_id,'',r.folder_name);
 const src=b.categories.learning.folder_id,dst=b.categories.education_research.folder_id;
 folder('folder_sub',src,'01_测试');folder('folder_deep','folder_sub','01_子层');folder('folder_more','folder_deep','01_第三层');folder('folder_last','folder_more','01_第四层');
 file('file_one','folder_last','hello.md','你好，移动。');file('file_root',src,'root.md','根文件');
 const path=id=>{const rows=[];while(id){rows.unshift({folder_id:id,name:names.get(id),parent_folder_id:parents.get(id)||nativeId});id=parents.get(id);}return [{folder_id:nativeId,name:b.kb_name,parent_folder_id:''},...rows];};
 ctx.nativeFetcher=async(url,options)=>{
  const q=JSON.parse(options.body);
  if(url.endsWith('/get_knowledge_list'))return Response.json({code:0,knowledge_base_info:{id:nativeId},current_path:path(q.folder_id),knowledge_list:structuredClone(tree.get(q.folder_id)||[]),is_end:true});
  if(url.endsWith('/resume_cross_kb_op')){resumes++;return new Response('event: COMPLETE\ndata: {"results":[]}\n\n',{headers:{'content-type':'text/event-stream'}});}
  assert.ok(url.endsWith('/move_knowledge'));moves++;
  if(mode==='throw')throw Error('secret upstream');
  if(!mode.startsWith('conflict'))for(const id of q.media_ids){const entry=[...tree.values()].flat().find(x=>x.media_id===id),from=entry.parent_folder_id;tree.set(from,tree.get(from).filter(x=>x.media_id!==id));entry.parent_folder_id=q.dst_folder_id;tree.get(q.dst_folder_id).push(entry);if(tree.has(id))parents.set(id,q.dst_folder_id);}
  if(mode==='hash-change')contents.set('file_root','篡改');
  const event=mode.startsWith('conflict')?'SAMENAME':'COMPLETE';
  const data=JSON.stringify({task_id:'task-test-1',results:(mode==='conflict-one'?q.media_ids.slice(0,1):q.media_ids).map(media_id=>({media_id,...(mode.startsWith('conflict')?{ret_code:7}:{})}))});
  return new Response(`event: ${event}\ndata: ${data}\n\n`,{headers:{'content-type':'text/event-stream'}});
 };
 ctx.invoke=async(domain,q)=>{
  if(q.action==='kb.get')return {status:'succeeded',data:{knowledge_base:{name:b.kb_name}}};
  if(q.action==='folder.list')return {status:'succeeded',data:{items:(tree.get(q.folder_id||'')||[]).map(x=>({...x,kind:x.media_type===99?'folder':'file'})),has_more:false}};
  if(q.action==='media.read'){const content=contents.get(q.media_id);return {status:'succeeded',data:{content,sha256:await sha256(content),size:new TextEncoder().encode(content).length}};}
  throw Error('unexpected action');
 };
 const bind=await moveAction('ima_bind_move_workspace',{native_knowledge_base_id:nativeId},ctx);assert.equal(bind.status,'succeeded',JSON.stringify(bind));
 const preview=(request_id,media_ids=['file_root'],source_folder_id=src,destination_folder_id=dst)=>moveAction('ima_move_preview',{request_id,media_ids,source_folder_id,destination_folder_id},ctx);
 const execute=p=>moveAction('ima_move_execute',{request_id:p.request_id,preview_hash:p.preview_hash},ctx);
 return {e,ctx,b,tree,parents,names,contents,src,dst,preview,execute,folder,file,setMode:v=>mode=v,moves:()=>moves,resumes:()=>resumes};
}

test('connection state agrees with authenticated binding and actual move acceptance',async()=>{
 const f=await fixture();
 try{
  const bound=await sessionAction('status',{},f.ctx);
  assert.equal(bound.session.authenticated,true);assert.equal(bound.session.account_bound,true);assert.deepEqual(bound.session.bound_workspaces,['isolated']);
  assert.equal(bound.session.connection_state,'authenticated_bound');
  const key=await sha256(f.e.IMA_OPENAPI_CLIENTID),binding=await f.ctx.baseStore.get('native_move_bindings',key+':isolated');
  await f.ctx.baseStore.put('native_move_validation',key,{native_user_sha256:binding.native_user_sha256,file_roundtrip:true,folder_roundtrip:true,isolated_scope:{kb_id:binding.kb_id,native_knowledge_base_id:binding.native_knowledge_base_id,roots_hash:binding.roots_hash}});
  const ready=await sessionAction('status',{},f.ctx);
  assert.equal(ready.session.move_verified,true);assert.equal(ready.session.connection_state,'move_ready');assert.equal(f.moves(),0);
 }finally{f.e.close();}
});

test('preview cannot move roots, descendants, duplicate names or stale content',async()=>{
 const f=await fixture();assert.equal((await f.preview('root',[f.src])).message,'ima_fixed_root_move_forbidden');
 assert.equal((await f.preview('cycle',['folder_sub'],f.src,'folder_last')).message,'ima_move_into_descendant_forbidden');
 f.file('collision',f.dst,'root.md','same');assert.equal((await f.preview('collision')).message,'ima_move_same_name_conflict');f.tree.set(f.dst,[]);
 const p=await f.preview('stale');assert.equal(p.status,'preview');f.contents.set('file_root','changed');
 assert.equal((await f.execute(p)).message,'ima_move_preview_stale');assert.equal(f.moves(),0);f.e.close();
});

test('single native dispatch verifies bytes, updates current location, preserves publication evidence and is replay safe',async()=>{
 const f=await fixture(),historical={media_id:'file_root',folder_id:f.src,directory_snapshot:{path:['history']},metadata:{primary_category:'learning'},review_key:'original-review',content_sha256:await sha256('根文件')};
 await f.ctx.store.put('governance_index','entry',historical);await f.ctx.store.put('cards','card',{card_id:'card',...historical});
 const p=await f.preview('single');const r=await f.execute(p);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(f.moves(),1);
 assert.equal((await f.execute(p)).replayed,true);assert.equal(f.moves(),1);
 const row=await f.ctx.store.get('governance_index','entry');assert.equal(row.current_location.folder_id,f.dst);const {current_location,...retained}=row;assert.deepEqual(retained,historical);
 assert.equal((await f.ctx.store.get('cards','card')).review_key,'original-review');f.e.close();
});

test('unknown and repeated execute never resubmit, reconcile only reads original positions',async()=>{
 const f=await fixture();const p=await f.preview('unknown');f.setMode('throw');assert.equal((await f.execute(p)).status,'unknown');
 assert.equal((await f.execute(p)).status,'unknown');assert.equal(f.moves(),1);
 assert.equal((await moveAction('ima_move_reconcile',{request_id:'unknown'},f.ctx)).status,'unknown');assert.equal(f.moves(),1);assert.equal(f.resumes(),0);
 assert.equal((await f.preview('blocked-new')).status,'conflict');f.e.close();
});

test('SAMENAME retains originals and reports conflict without overwriting or leaving the library blocked',async()=>{
 const f=await fixture();const p=await f.preview('conflict-after-preview');f.setMode('conflict');const r=await f.execute(p);
 assert.equal(r.status,'conflict',JSON.stringify(r));assert.equal(r.items[0].unchanged,true);assert.equal(f.moves(),1);
 assert.equal((await f.preview('after-conflict')).status,'preview');f.e.close();
});

test('changed bytes after dispatch keep verification pending and never synchronize a false location',async()=>{
 const f=await fixture();await f.ctx.store.put('governance_index','entry',{media_id:'file_root',folder_id:f.src});
 const p=await f.preview('bad-hash');f.setMode('hash-change');const r=await f.execute(p);assert.equal(r.status,'verification_pending');
 assert.equal((await f.ctx.store.get('governance_index','entry')).current_location,undefined);assert.equal(f.moves(),1);f.e.close();
});

test('one conflicted item never resolves unseen items in a batch or releases its library lock',async()=>{
 const f=await fixture();f.file('file_other',f.src,'other.md','另一条');const p=await f.preview('batch-conflict',['file_root','file_other']);
 f.setMode('conflict-one');const r=await f.execute(p);assert.equal(r.status,'unknown');assert.equal(r.items.filter(x=>x.status==='unknown').length,1);
 assert.equal((await f.preview('must-wait')).status,'conflict');assert.equal(f.moves(),1);f.e.close();
});

test('unregistered destination cannot orphan the directory registry',async()=>{
 const f=await fixture();f.folder('folder_unregistered',f.dst,'01_未登记');
 const r=await f.preview('unregistered',['folder_sub'],f.src,'folder_unregistered');assert.equal(r.message,'ima_move_destination_must_be_registered');assert.equal(f.moves(),0);f.e.close();
});

test('formal execution remains gated until cloud isolated roundtrips are proven',async()=>{
 const f=await fixture();const p=await f.preview('formal-gate');f.ctx.workspace='formal';
 // Reuse the same synthetic settings store solely to exercise the formal gate.
 const binding=await f.ctx.baseStore.get('native_move_bindings',await sha256(f.e.IMA_OPENAPI_CLIENTID)+':isolated');
 await f.ctx.baseStore.put('native_move_bindings',await sha256(f.e.IMA_OPENAPI_CLIENTID)+':formal',binding);
 const r=await f.execute(p);assert.equal(r.message,'ima_move_isolated_roundtrip_required');assert.equal(f.moves(),0);f.e.close();
});

test('reconcile remains possible after publication is disabled and never retries the move',async()=>{
 const f=await fixture();const p=await f.preview('publication-off');f.setMode('hash-change');assert.equal((await f.execute(p)).status,'verification_pending');
 f.contents.set('file_root','根文件');await f.ctx.store.put('settings','service',{publication_enabled:false});
 const r=await moveAction('ima_move_reconcile',{request_id:p.request_id},f.ctx);assert.equal(r.status,'succeeded',JSON.stringify(r));assert.equal(f.moves(),1);f.e.close();
});

test('request IDs and cross API root bindings cannot be changed silently',async()=>{
 const f=await fixture();assert.equal((await f.preview('same-id')).status,'preview');
 assert.equal((await f.preview('same-id',['folder_sub'])).message,'ima_move_request_id_reused');
 f.tree.get('')[0].title='another name';const r=await moveAction('ima_bind_move_workspace',{native_knowledge_base_id:'7000000000000002'},f.ctx);assert.equal(r.message,'ima_native_openapi_roots_mismatch');assert.equal(f.moves(),0);f.e.close();
});

test('folder moves synchronize every registered descendant and cloud proof requires both exact roundtrips',async()=>{
 const f=await fixture();
 await f.ctx.store.put('directories','folder_last',{directory_id:'folder_last',kb_id:f.b.kb_id,primary_category:'learning',parent_folder_id:'folder_more',name:'01_第四层',depth:5,path:[]});
 const a=await f.preview('file-out');assert.equal((await f.execute(a)).status,'succeeded');
 const b=await f.preview('file-back',['file_root'],f.dst,f.src);assert.equal((await f.execute(b)).status,'succeeded');
 assert.equal((await sessionAction('status',{},f.ctx)).session.move_verified,false);
 const c=await f.preview('folder-out',['folder_sub']);assert.equal((await f.execute(c)).status,'succeeded');
 const child=await f.ctx.store.get('directories','folder_last');assert.equal(child.path[0].directory_id,f.dst);assert.equal(child.depth,5);assert.equal(child.primary_category,'education_research');
 const d=await f.preview('folder-back',['folder_sub'],f.dst,f.src);assert.equal((await f.execute(d)).status,'succeeded');
 assert.equal((await sessionAction('status',{},f.ctx)).session.move_verified,true);assert.equal(f.moves(),4);f.e.close();
});

test('an isolated library rebind invalidates an earlier move acceptance proof',async()=>{
 const f=await fixture(),key=await sha256(f.e.IMA_OPENAPI_CLIENTID),binding=await f.ctx.baseStore.get('native_move_bindings',key+':isolated');
 await f.ctx.baseStore.put('native_move_validation',key,{native_user_sha256:binding.native_user_sha256,file_roundtrip:true,folder_roundtrip:true,isolated_scope:{kb_id:binding.kb_id,native_knowledge_base_id:binding.native_knowledge_base_id,roots_hash:binding.roots_hash}});
 assert.equal((await sessionAction('status',{},f.ctx)).session.move_verified,true);
 await f.ctx.baseStore.put('native_move_bindings',key+':isolated',{...binding,native_knowledge_base_id:'7520090731854599'});
 assert.equal((await sessionAction('status',{},f.ctx)).session.move_verified,false);f.e.close();
});
test('a move cannot dispatch without a validated native login and binding',async()=>{
 const e=runtime();
 const r=await dispatch('ima_move_preview',{workspace:'isolated',request_id:'denied',source_folder_id:'folder_a',destination_folder_id:'folder_b',media_ids:['file']},context(e));
 assert.ok(['blocked','unavailable'].includes(r.status));e.close();
});
