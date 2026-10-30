import test from 'node:test';
import assert from 'node:assert/strict';
import {cardAction} from '../worker/cards.js';
import {governance} from '../worker/governance.js';
import {synchronizeMoveIndex} from '../worker/move-index.js';
import {sha256,stable,withShortLease} from '../worker/storage.js';
import {context,draft,reviewRequest,contract} from './fixtures/cloud-context.mjs';

async function reviewed(){
 const ctx=context();
 const intake=await cardAction('intake',draft(),ctx);
 assert.equal((await cardAction('review_submit',await reviewRequest(intake.card),ctx)).status,'succeeded');
 return {ctx,card_id:intake.card.card_id,kb:contract.bindings.kb_id};
}
const activeKey=kb=>contract.bindings.account_sha256+':'+kb;
const move=(kb,request_id='move-after-upload')=>({kb_id:kb,request_id,verified_at:'2026-10-27T01:00:00Z'});
const location=()=>({media_id:'media-1',folder_id:'folder-education-research',primary_category:'education_research',path:[{directory_id:'folder-education-research',name:'04_教育与学术研究'}]});

test('pending move blocks publication before any publication or dispatch intent; release allows one upload',async()=>{
 const {ctx,card_id,kb}=await reviewed();
 await ctx.store.put('native_move_active',activeKey(kb),{request_id:'unknown-move',resolved:false});
 const before=await ctx.store.get('cards',card_id);
 const blocked=await cardAction('publish',{card_id},ctx);
 assert.equal(blocked.status,'blocked');
 assert.deepEqual(await ctx.store.get('cards',card_id),before);
 assert.equal((await ctx.store.list('card_dispatches')).items.length,0);
 assert.equal((await ctx.store.list('governance_requests')).items.length,0);
 assert.equal(ctx.calls.length,0);
 await ctx.store.put('native_move_active',activeKey(kb),{request_id:'unknown-move',resolved:true});
 assert.equal((await cardAction('publish',{card_id},ctx)).status,'succeeded');
 assert.equal(ctx.calls.filter(x=>x.q.execute&&!x.q.reconcile).length,1);
});

test('publish and reconcile take the move library lease before the card lease',async()=>{
 const {ctx,card_id,kb}=await reviewed();
 await withShortLease(ctx,'governance:directory-plans:'+kb,async()=>{
  for(const action of ['publish','reconcile'])assert.equal((await cardAction(action,{card_id},ctx)).status,'conflict');
  assert.equal(await ctx.store.get('locks','card:'+card_id),null);
  assert.equal((await ctx.store.get('cards',card_id)).publication_key,undefined);
 });
 assert.equal((await cardAction('publish',{card_id},ctx)).status,'succeeded');
});

test('the library lease covers remote readback and final card commit and is released afterwards',async()=>{
 const {ctx,card_id,kb}=await reviewed(),invoke=ctx.invoke.bind(ctx);
 let entered,release;
 const arrived=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 ctx.invoke=async(domain,q)=>{if(q.action==='media.read'){entered();await gate;}return invoke(domain,q);};
 const publishing=cardAction('publish',{card_id},ctx);
 await arrived;
 try{await assert.rejects(withShortLease(ctx,'governance:directory-plans:'+kb,async()=>{}),/operation_in_progress/);}
 finally{release();}
 assert.equal((await publishing).status,'succeeded');
 await withShortLease(ctx,'governance:directory-plans:'+kb,async()=>{});
 assert.equal(await ctx.store.get('locks','card:'+card_id),null);
});

test('late publication index and card finish use durable moved location without changing historical evidence or redispatching',async()=>{
 const {ctx,card_id,kb}=await reviewed(),invoke=ctx.invoke.bind(ctx);
 ctx.invoke=async(domain,q)=>{
  if(q.action==='text.create'&&!q.reconcile){ctx.calls.push({domain,q:structuredClone(q)});ctx.transport=q;return {status:'unknown'};}
  return invoke(domain,q);
 };
 assert.equal((await cardAction('publish',{card_id},ctx)).status,'unknown');
 const row=await ctx.store.get('cards',card_id),pub=JSON.parse(await (await ctx.blobs.get(row.publication_key)).text());
 const review=await (await ctx.blobs.get(row.review_key)).text();
 const q=ctx.transport;
 ctx.receipt={status:'succeeded',request_id:q.request_id,resource:{kb_id:kb,folder_id:q.folder_id,filename:q.filename,content_sha256:await sha256(q.content),media_ids:['media-1']}};
 assert.equal((await ctx.store.list('governance_index')).items.length,0);
 const op=move(kb),where=location();
 await synchronizeMoveIndex(ctx,op,[where]);
 const authoritative=(await ctx.store.list('media_locations')).items;
 assert.equal(authoritative.length,1);
 assert.deepEqual(authoritative[0].value,{...where,kb_id:kb,request_id:op.request_id,verified_at:op.verified_at});
 const done=await cardAction('reconcile',{card_id},ctx);
 assert.equal(done.status,'succeeded',JSON.stringify(done));
 assert.deepEqual(done.card.current_location,authoritative[0].value);
 const indexed=(await governance('index.lookup',{entry_id:done.card.entry_id},ctx)).latest;
 assert.deepEqual(indexed.current_location,authoritative[0].value);
 assert.equal(indexed.folder_id,q.folder_id);
 assert.deepEqual(indexed.directory_snapshot,pub.directory_snapshot);
 assert.deepEqual(JSON.parse(await (await ctx.blobs.get(row.publication_key)).text()),pub);
 assert.equal(await (await ctx.blobs.get(row.review_key)).text(),review);
 assert.equal(ctx.calls.filter(x=>x.q.execute&&!x.q.reconcile).length,1);
 assert.equal((await cardAction('publish',{card_id},ctx)).replayed,true);
});

test('move persists authoritative locations before a failed projection scan',async()=>{
 const {ctx,kb}=await reviewed(),list=ctx.store.list.bind(ctx.store),op=move(kb),where=location();
 ctx.store.list=async(collection,options)=>{if(collection==='directories')throw Error('scan unavailable');return list(collection,options);};
 await assert.rejects(synchronizeMoveIndex(ctx,op,[where]),/scan unavailable/);
 assert.deepEqual((await list('media_locations')).items.map(x=>x.value),[{...where,kb_id:kb,request_id:op.request_id,verified_at:op.verified_at}]);
});
