import test from 'node:test';
import assert from 'node:assert/strict';
import {D1Store,runOperation,sha256} from '../worker/storage.js';
import * as storage from '../worker/storage.js';
import {cardAction} from '../worker/cards.js';
import {governance} from '../worker/governance.js';
import {runtime} from './fixtures/runtime.mjs';
import {context,draft,reviewRequest,contract,golden} from './fixtures/cloud-context.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {scopedStore} from '../worker/admin.js';

test('expired short owner cannot write or release its successor; provider lock stays permanent',async()=>{
 const store=new D1Store(runtime().DB);
 assert.equal(typeof store.acquireLease,'function');
 const lease=await store.acquireLease('card:one','old');assert.ok(lease);
 await store.put('locks','card:one',{...lease,expires_at:Date.now()-1});
 const next=await store.acquireLease('card:one','next');assert.ok(next);
 await assert.rejects(()=>store.fencedWrite('put','cards','one',{bad:true},[lease]),/lease_lost/);
 await store.releaseLock('card:one','old');assert.equal((await store.get('locks','card:one')).request_id,'next');
 await store.acquireLock('provider:one','unknown-request');
 const permanent=await store.get('locks','provider:one');await store.put('locks','provider:one',{...permanent,created_at:'2000-01-01T00:00:00Z'});
 assert.equal(await store.acquireLock('provider:one','another'),false);
});

test('orphan legacy short locks have a grace period and invalid dates never permit takeover',async()=>{
 const store=new D1Store(runtime().DB);assert.equal(typeof store.acquireLease,'function');
 for(const created_at of [new Date().toISOString(),'invalid']){await store.put('locks','card:legacy',{request_id:'old',created_at});assert.equal(await store.acquireLease('card:legacy','new'),null);}
 await store.put('locks','card:legacy',{request_id:'old',created_at:'2000-01-01T00:00:00Z'});
 assert.ok(await store.acquireLease('card:legacy','new'));
});

test('abandoned card unknown can reconcile with original request; stopped owner cannot overwrite it',async()=>{
 const c=context();const a=await cardAction('intake',draft(),c);await cardAction('review_submit',await reviewRequest(a.card),c);
 const invoke=c.invoke.bind(c);c.invoke=async(d,q)=>q.execute&&!q.reconcile?(c.transport=q,{status:'unknown'}):invoke(d,q);
 await cardAction('publish',{card_id:a.card.card_id},c);const original=(await cardAction('status',{card_id:a.card.card_id,include_content:true},c)).card.publication.request_id;
 await c.store.put('locks','card:'+a.card.card_id,{request_id:'killed-owner',created_at:'2000-01-01T00:00:00Z'});
 c.invoke=invoke;c.receipt={status:'succeeded',request_id:original,resource:{kb_id:c.transport.kb_id,folder_id:c.transport.folder_id,filename:c.transport.filename,content_sha256:await sha256(c.transport.content),media_ids:['recovered']}};
 const r=await cardAction('reconcile',{card_id:a.card.card_id},c);assert.equal(r.card?.status,'published',JSON.stringify(r));assert.equal(r.card.publication.request_id,original);
 assert.equal(c.calls.filter(x=>x.q.execute&&!x.q.reconcile).length,0);
});

test('new card requests distinguish destination accounts, libraries, and category folders',async()=>{
 const ids=[];for(const field of ['base','account','kb','folder']){const c=context();const b=await c.store.get('settings','bindings');if(field==='account')b.account_sha256='f'.repeat(64);if(field==='kb')b.kb_id='another-kb';if(field==='folder')b.categories.learning.folder_id='another-folder';await c.store.put('settings','bindings',b);
 const a=await cardAction('intake',draft(),c);await cardAction('review_submit',await reviewRequest(a.card),c);await cardAction('publish',{card_id:a.card.card_id},c);ids.push(c.transport.request_id);}
 assert.equal(new Set(ids).size,4);
});

test('legacy file request cannot replay a different filename or mismatching blob hash',async()=>{
 const env=runtime(),store=new D1Store(env.DB);const bytes=new TextEncoder().encode('original');const hash=await sha256(bytes);await store.put('blob_metadata','uploads/one',{sha256:hash});
 let writes=0;const ctx={env,store,blobs:{get:async()=>({size:bytes.length,body:new Blob([bytes]).stream(),arrayBuffer:async()=>bytes.buffer})},provider:async(d,q)=>{writes++;return {status:'succeeded',resource:{filename:q.filename}};}};
 const q={action:'file.upload',request_id:'legacy-file',kb_id:'kb',filename:'A.txt',blob_id:'uploads/one',execute:true,_original_request:{action:'file.upload',request_id:'legacy-file',kb_id:'kb',file:'C:\\source\\A.txt'}};
 assert.equal((await runOperation('kb',q,ctx)).status,'succeeded');assert.equal((await runOperation('kb',q,ctx)).replayed,true);
 assert.equal((await runOperation('kb',{...q,filename:'B.txt'},ctx)).status,'conflict');
 assert.equal((await runOperation('kb',{...q,sha256:'0'.repeat(64)},ctx)).status,'conflict');
 ctx.blobs.get=async()=>({size:7,body:new Blob(['changed']).stream()});assert.equal((await runOperation('kb',q,ctx)).status,'conflict');assert.equal(writes,1);
});

test('a terminated process leaves durable intent and its short lease can be taken over',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ima-lease-crash-')),path=join(dir,'ledger.sqlite');let env,child;
 try{
  const source=`import {runtime} from ${JSON.stringify(new URL('./fixtures/runtime.mjs',import.meta.url).href)};import {D1Store,withShortLease} from ${JSON.stringify(new URL('../worker/storage.js',import.meta.url).href)};const store=new D1Store(runtime(process.argv[1]).DB);await withShortLease({store,blobs:{}},'card:crashed',async ctx=>{await ctx.store.put('cards','crashed',{status:'unknown',publication_key:'original-publication'});process.stdout.write('durable\\n');await new Promise(()=>setInterval(()=>{},1000));});`;
  child=spawn(process.execPath,['--input-type=module','-e',source,path],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',b=>stderr+=b);await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error(stderr||'child exited before intent');})]);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  env=runtime(path);const store=new D1Store(env.DB);const old=await store.get('locks','card:crashed');assert.ok(old);
  assert.equal(await store.acquireLease('card:crashed','too-soon'),null);
  await store.put('locks','card:crashed',{...old,expires_at:Date.now()-1});
  await storage.withShortLease({store,blobs:{}},'card:crashed',async ctx=>{const row=await ctx.store.get('cards','crashed');assert.equal(row.publication_key,'original-publication');await ctx.store.put('cards','crashed',{...row,reconciled:true});});
  assert.equal((await store.get('cards','crashed')).reconciled,true);
 }finally{if(child?.exitCode===null&&child?.signalCode===null)child.kill('SIGKILL');env?.close();const target=resolve(dir);if(dirname(target)!==resolve(tmpdir())||!basename(target).startsWith('ima-lease-crash-'))throw Error('unexpected_test_cleanup_path');await rm(target,{recursive:true,force:true});}
});

test('paused old card publisher cannot overwrite the successor recovery or send twice',async()=>{
 const c=context(),a=await cardAction('intake',draft(),c);await cardAction('review_submit',await reviewRequest(a.card),c);
 const invoke=c.invoke.bind(c);let resume,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r);let writes=0;
 c.invoke=async(d,q)=>{if(q.execute&&!q.reconcile){writes++;c.transport=q;started();await gate;return {status:'unknown'};}return invoke(d,q);};
 const old=cardAction('publish',{card_id:a.card.card_id},c);await ready;
 const key='card:'+a.card.card_id,lease=await c.store.get('locks',key);await c.store.put('locks',key,{...lease,expires_at:Date.now()-1});
 const t=c.transport;c.receipt={status:'succeeded',request_id:t.request_id,resource:{kb_id:t.kb_id,folder_id:t.folder_id,filename:t.filename,content_sha256:await sha256(t.content),media_ids:['recovered']}};
 const libraryKey='governance:directory-plans:'+contract.bindings.kb_id,libraryLease=await c.store.get('locks',libraryKey);assert.ok(libraryLease?.expires_at>Date.now());
 assert.equal((await cardAction('reconcile',{card_id:a.card.card_id},c)).status,'conflict');
 assert.equal((await c.store.get('cards',a.card.card_id)).status,'unknown');assert.equal(writes,1);
 await c.store.put('locks',libraryKey,{...libraryLease,expires_at:Date.now()-1});
 const recovery=await cardAction('reconcile',{card_id:a.card.card_id},c);assert.equal(recovery.card?.status,'published',JSON.stringify(recovery));
 resume();assert.equal((await old).status,'conflict');assert.equal((await c.store.get('cards',a.card.card_id)).status,'published');assert.equal(writes,1);
});

test('paused governance commit cannot mutate an index after lease takeover',async()=>{
 const c=context(),q={policy_version:'1.0.0',request_id:'governance-recover',entry:golden.entry};const p=await governance('entry.prepare',q,c);c.receipt=await c.invoke('kb',{...p.transport_request,execute:true});
 let resume,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r);const invoke=c.invoke.bind(c);let reads=0;
 c.invoke=async(d,q)=>{if(q.action==='media.read'&&++reads===1){started();await gate;}return invoke(d,q);};
 const old=governance('index.commit',{...q,media_id:'media-1'},c);await ready;
 const key='governance:'+contract.bindings.account_sha256+':'+contract.bindings.kb_id,lease=await c.store.get('locks',key);await c.store.put('locks',key,{...lease,expires_at:Date.now()-1});
 const libraryKey='governance:directory-plans:'+contract.bindings.kb_id,libraryLease=await c.store.get('locks',libraryKey);assert.ok(libraryLease?.expires_at>Date.now());
 assert.equal((await governance('index.commit',{...q,media_id:'media-1'},c)).status,'conflict');
 assert.equal((await governance('index.lookup',{entry_id:golden.entry.entry_id},c)).versions.length,0);
 await c.store.put('locks',libraryKey,{...libraryLease,expires_at:Date.now()-1});
 assert.equal((await governance('index.commit',{...q,media_id:'media-1'},c)).status,'succeeded');resume();assert.equal((await old).status,'conflict');
 assert.equal((await governance('index.lookup',{entry_id:golden.entry.entry_id},c)).versions.length,1);
});

test('formal and isolated publish the same card through one operation ledger without collision',async()=>{
 const c=context(),root=c.store,env={IMA_OPENAPI_CLIENTID:'shared-account'},b=structuredClone(contract.bindings);b.account_sha256=await sha256(env.IMA_OPENAPI_CLIENTID);await root.put('settings','bindings',b);
 const isolated={...c,baseStore:root,workspace:'isolated',store:scopedStore(root,'isolated')};
 const ib=structuredClone(b);ib.kb_id='isolated-kb';ib.kb_name='隔离库';for(const row of Object.values(ib.categories))row.folder_id='isolated-'+row.folder_id;
 await isolated.store.put('settings','policy',contract.policy);await isolated.store.put('settings','bindings',ib);
 const originals=new Map();let writes=0;
 const provider=async(d,q)=>{if(q.action==='media.read')return {status:'succeeded',data:{content:originals.get(q.media_id)}};assert.equal(q.reconcile,undefined);writes++;const mid='media-'+writes;originals.set(mid,q.content);return {status:'succeeded',resource:{kb_id:q.kb_id,folder_id:q.folder_id,filename:q.filename,content_sha256:await sha256(q.content),media_ids:[mid]}};};
 const invoke=(d,q)=>runOperation(d,q,{env,store:root,provider});c.invoke=invoke;isolated.invoke=invoke;
 const ids=[];for(const ctx of [isolated,c]){const a=await cardAction('intake',draft(),ctx);await cardAction('review_submit',await reviewRequest(a.card),ctx);const p=await cardAction('publish',{card_id:a.card.card_id},ctx);assert.equal(p.card?.status,'published',JSON.stringify(p));ids.push(p.card.publication.request_id);}
 assert.notEqual(ids[0],ids[1]);assert.equal(writes,2);assert.equal((await root.list('operations')).items.length,2);
});

test('expired provider invocation cannot overwrite a recovered receipt or release the new owner resource lock',async()=>{
 const store=new D1Store(runtime().DB);let resume,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>resume=r);let writes=0;
 const provider=async(d,q,ctx)=>{if(q.reconcile)return {status:'unknown',resource:{note_id:'known'}};writes++;await ctx.onStage({resource:{note_id:'known'}});started();await gate;return {status:'succeeded',resource:{note_id:'stale'}};};
 const q={action:'create',content:'same',request_id:'provider-crash',execute:true},ctx={store,env:{},provider};const old=runOperation('notes',q,ctx);await ready;
 const before=await store.get('operations',q.request_id);await store.put('operations',q.request_id,{...before,running_until:Date.now()-1});
 const recovery=await runOperation('notes',{...q,reconcile:true},ctx);assert.equal(recovery.status,'unknown');resume();assert.equal((await old).status,'verification_pending');
 const row=await store.get('operations',q.request_id);assert.equal(row.status,'unknown');assert.equal(row.receipt.resource.note_id,'known');assert.ok(await store.get('locks',row.resource_key));assert.equal(writes,1);
});

test('legacy explicit filename binds dispatch and migrated fingerprint stays unchanged',async()=>{
 const env=runtime(),store=new D1Store(env.DB),bytes=new TextEncoder().encode('same'),hash=await sha256(bytes);await store.put('blob_metadata','uploads/same',{sha256:hash});
 const original={action:'file.upload',request_id:'migrated',kb_id:'kb',filename:'explicit.txt',file:'/source/different.txt'};
 const q={...original,blob_id:'uploads/same',_original_request:original,execute:true};
 const fingerprint=await sha256(storage.stable({...original,file_sha256:hash},true)+await sha256(env.IMA_OPENAPI_CLIENTID));
 await store.put('operations',q.request_id,{fingerprint,status:'succeeded',receipt:{status:'succeeded',resource:{filename:'explicit.txt'}}});
 const ctx={env,store,provider:async()=>{throw Error('must not dispatch');},blobs:{get:async()=>({size:bytes.length,body:new Blob([bytes]).stream()})}};
 assert.equal((await runOperation('kb',q,ctx)).replayed,true);assert.equal((await runOperation('kb',{...q,filename:'different.txt'},ctx)).status,'conflict');
 for(const file of ['C:\\source\\A.txt','/source/A.txt']){const req={...q,request_id:'path-'+file,_original_request:{action:'file.upload',request_id:'path-'+file,kb_id:'kb',file},filename:'A.txt'};const provider=async()=>({status:'succeeded'});assert.equal((await runOperation('kb',req,{...ctx,provider})).status,'succeeded');}
});

test('pre-upgrade publication keys recover and replay using their original request id',async()=>{
 const c=context(),a=await cardAction('intake',draft(),c),entry={...golden.entry,entry_id:a.card.entry_id},request_id='legacy-publication-id';
 const governance_request={action:'entry.prepare',policy_version:'1.0.0',request_id,entry};const prepared=await governance('entry.prepare',governance_request,c);assert.equal(prepared.status,'preview');
 const pub={request_id,governance_request,transport_request:prepared.transport_request,content_sha256:prepared.artifact.content_sha256};
 await c.blobs.put('legacy/publication',JSON.stringify(pub));await c.store.put('cards',a.card.card_id,{...a.card,status:'unknown',publication_key:'legacy/publication'});
 c.transport=prepared.transport_request;c.receipt={status:'succeeded',request_id,resource:{kb_id:c.transport.kb_id,folder_id:c.transport.folder_id,filename:c.transport.filename,content_sha256:pub.content_sha256,media_ids:['legacy-media']}};
 for(const action of ['reconcile','publish']){const result=await cardAction(action,{card_id:a.card.card_id},c);assert.equal(result.card?.status,'published',JSON.stringify(result));assert.equal(result.card.publication.request_id,request_id);}
 assert.equal(c.calls.filter(x=>x.q.execute&&!x.q.reconcile).length,0);
});
