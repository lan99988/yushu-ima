import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {context,contract,golden,draft,reviewRequest} from './fixtures/cloud-context.mjs';
import * as gov from '../worker/governance.js';
import {cardAction,cardTools} from '../worker/cards.js';

const prepare=(overrides={})=>({policy_version:'1.0.0',request_id:'release-test',entry:structuredClone(golden.entry),...overrides});
async function upgrade(c){assert.equal(typeof gov.upgradePolicy,'function');const r=await gov.upgradePolicy(c);assert.equal(r.status,'succeeded',JSON.stringify(r));return r;}
async function child(c,id='child-learning',category='learning',parent='folder-learning',depth=2){await c.store.put('directories',id,{directory_id:id,folder_id:id,kb_id:'test-kb',primary_category:category,parent_folder_id:parent,depth,name:'01_主题',status:'ready'});return id;}
async function ready(c){const a=await cardAction('intake',draft(),c);assert.equal(a.status,'succeeded');const r=await cardAction('review_submit',await reviewRequest(a.card),c);assert.equal(r.status,'succeeded');return r.card;}

test('release upgrade preserves the 1.0 file hash and publishes a complete immutable 1.1 policy',async()=>{
 const c=context();assert.equal((await gov.governance('policy.get',{},c)).policy_sha256,contract.policy_sha256);
 const before=await c.store.get('settings','bindings');await upgrade(c);
 const r=await gov.governance('policy.get',{},c);assert.equal(r.policy.policy_version,'1.1.0');assert.equal(r.status,'succeeded');
 const asset=JSON.parse(await readFile(new URL('../assets/governance-1.1.0.json',import.meta.url)));
 assert.deepEqual(asset.policy,r.policy);assert.equal(asset.policy_sha256,r.policy_sha256);
 assert.ok(asset.schemas.request.$defs.entry.properties.directory_id,'request schema must accept directory_id');
 assert.equal(asset.schemas.request.$defs.entry.properties.directory_id.type,'string');
 for(const branch of asset.schemas.request.oneOf||asset.schemas.request.anyOf||[]){if(branch.properties?.policy_version)assert.equal(branch.properties.policy_version.const,'1.1.0');}
 assert.equal(await gov.sha(gov.packed(asset.policy,2)+'\n'),asset.policy_sha256);
 assert.equal(r.policy.directory_rules.max_folder_depth,undefined);assert.equal(r.policy.directory_rules.subfolder_min_items,undefined);
 assert.equal(r.policy.directory_rules.prefer_shallow,true);assert.equal(r.policy.directory_rules.confirm_each_batch,true);
 assert.equal(r.policy.directory_rules.numbering,'independent_per_parent_01_topic');
 assert.deepEqual(await c.store.get('settings','bindings'),before);
 const again=await upgrade(c);assert.equal(again.replayed,true);
});

test('failure before active switch keeps a usable 1.0 release and retry is safe',async()=>{
 const c=context(),write=c.store.fencedWrite.bind(c.store);
 c.store.fencedWrite=async(method,col,key,...args)=>{if(col==='settings'&&key==='active')throw Error('injected switch failure');return write(method,col,key,...args);};
 assert.equal(typeof gov.upgradePolicy,'function');assert.equal((await gov.upgradePolicy(c)).status,'unavailable');
 assert.equal((await gov.governance('policy.get',{},c)).policy.policy_version,'1.0.0');
 c.store.fencedWrite=write;await upgrade(c);
});

test('legacy minimal reservations keep the original signature and commit old golden bytes after upgrade',async()=>{
 const c=context(),q=prepare(),p=await gov.governance('entry.prepare',q,c);assert.equal(p.status,'preview');
 const key=contract.bindings.account_sha256+':test-kb:'+q.request_id;
 const reserved=await c.store.get('governance_requests',key);
 // Simulate the production 1.0 record which has no policy or binding snapshot.
 const minimal=Object.fromEntries(['request_id','signature','entry_id','version'].map(k=>[k,reserved[k]]));
 await c.store.put('governance_requests',key,minimal);await c.store.put('governance_reservations',contract.bindings.account_sha256+':test-kb:'+q.entry.entry_id+':1.0',minimal);
 c.receipt=await c.invoke('kb',{...p.transport_request,execute:true});await upgrade(c);await child(c);
 assert.equal((await c.store.get('governance_requests',key)).signature,minimal.signature);
 const replay=await gov.governance('entry.prepare',q,c);assert.equal(replay.status,'preview',JSON.stringify(replay));assert.equal(replay.artifact.content_sha256,golden.content_sha256);
 assert.equal((await gov.governance('index.commit',{...q,media_id:'media-1'},c)).status,'succeeded');
 assert.equal(c.calls.filter(x=>x.q.execute&&!x.q.reconcile).length,1);
 assert.equal((await gov.governance('entry.prepare',prepare({request_id:'fresh-old-policy',entry:{...golden.entry,entry_id:crypto.randomUUID()}}),c)).status,'conflict');
});

test('1.1 prepare freezes real directory target; directory growth does not change signature',async()=>{
 const c=context();await upgrade(c);const id=await child(c);
 const q=prepare({policy_version:'1.1.0',entry:{...golden.entry,directory_id:id}});
 const p=await gov.governance('entry.prepare',q,c);assert.equal(p.status,'preview',JSON.stringify(p));assert.equal(p.transport_request.folder_id,id);assert.equal(p.directory_snapshot.directory_id,id);
 const key=contract.bindings.account_sha256+':test-kb:'+q.request_id,sig=(await c.store.get('governance_requests',key)).signature;
 await child(c,'sibling');assert.equal((await gov.governance('entry.prepare',q,c)).status,'preview');assert.equal((await c.store.get('governance_requests',key)).signature,sig);
 assert.equal((await gov.governance('entry.prepare',{...q,entry:{...q.entry,directory_id:'sibling'}},c)).status,'conflict');
 c.receipt=await c.invoke('kb',{...p.transport_request,execute:true});
 assert.equal((await gov.governance('index.commit',{...q,media_id:'media-1'},c)).status,'succeeded');
 const row=(await gov.governance('index.lookup',{entry_id:q.entry.entry_id},c)).latest;
 assert.equal(row.folder_id,id);assert.deepEqual(row.directory_snapshot,p.directory_snapshot);
});

test('subdirectory requires policy 1.1 and same primary category; omitted directory keeps root',async()=>{
 const c=context();const id=await child(c);
 assert.notEqual((await gov.governance('entry.prepare',prepare({entry:{...golden.entry,directory_id:id}}),c)).status,'preview');
 await upgrade(c);await child(c,'health-child','health','folder-health');
 assert.equal((await gov.governance('entry.prepare',prepare({policy_version:'1.1.0',entry:{...golden.entry,directory_id:'health-child'}}),c)).status,'conflict');
 const r=await gov.governance('entry.prepare',prepare({policy_version:'1.1.0'}),c);assert.equal(r.status,'preview');assert.equal(r.transport_request.folder_id,'folder-learning');
});

test('card routing is separate from input hash and preserves a usable 1.0 review on 1.1',async()=>{
 const c=context(),card=await ready(c);await upgrade(c);const id=await child(c);
 const routed=await cardAction('route',{card_id:card.card_id,directory_id:id,expected_version:card.version},c);
 assert.equal(routed.status,'succeeded',JSON.stringify(routed));assert.equal(routed.card.input_hash,card.input_hash);assert.equal(routed.card.review_key,card.review_key);
 assert.equal((await c.store.get('card_routes',card.card_id)).directory_id,id);
 assert.equal((await cardAction('route',{card_id:card.card_id,directory_id:'folder-health'},c)).status,'conflict');
 const p=await cardAction('publish',{card_id:card.card_id},c);assert.equal(p.card?.status,'published',JSON.stringify(p));assert.equal(c.transport.folder_id,id);
 assert.equal(p.index.directory_id,id);
 const next=await cardAction('intake',{...draft(),content:'新版本',card_id:card.card_id,expected_version:p.card.version},c);assert.equal(next.status,'succeeded');
 const review={...await reviewRequest(next.card,'第二版'),policy_version:'1.1.0'};assert.equal((await cardAction('review_submit',review,c)).status,'succeeded');
 const second=await cardAction('publish',{card_id:card.card_id},c);assert.equal(second.card?.status,'published',JSON.stringify(second));assert.equal(c.transport.folder_id,id);
});

test('optional intake directory never changes snapshot content hash; stale or in-flight routing blocked',async()=>{
 const c=context();await upgrade(c);const id=await child(c);
 const a=await cardAction('intake',{...draft(),directory_id:id},c);assert.equal(a.status,'succeeded',JSON.stringify(a));
 const c2=context();await upgrade(c2);const b=await cardAction('intake',draft(),c2);assert.equal(a.card.input_hash,b.card.input_hash);
 assert.equal((await cardAction('route',{card_id:a.card.card_id,directory_id:'folder-learning',expected_version:0},c)).status,'conflict');
 const reviewed=await cardAction('review_submit',{...await reviewRequest(a.card),policy_version:'1.1.0'},c);assert.equal(reviewed.status,'succeeded');
 const invoke=c.invoke.bind(c);c.invoke=async(d,q)=>q.execute&&!q.reconcile?{status:'unknown'}:invoke(d,q);
 assert.equal((await cardAction('publish',{card_id:a.card.card_id},c)).status,'unknown');
 assert.equal((await cardAction('route',{card_id:a.card.card_id,directory_id:'folder-learning'},c)).status,'conflict');
});

test('old unknown publication reconciles with original request and bytes after release switch',async()=>{
 const c=context(),card=await ready(c),invoke=c.invoke.bind(c);let original,writes=0;
 c.invoke=async(d,q)=>{if(q.execute&&!q.reconcile){writes++;original=q;c.transport=q;return {status:'unknown'};}return invoke(d,q);};
 assert.equal((await cardAction('publish',{card_id:card.card_id},c)).status,'unknown');await upgrade(c);await child(c);
 c.receipt={status:'succeeded',request_id:original.request_id,resource:{kb_id:original.kb_id,folder_id:original.folder_id,filename:original.filename,content_sha256:await gov.sha(original.content),media_ids:['old-media']}};
 const r=await cardAction('reconcile',{card_id:card.card_id},c);assert.equal(r.card?.status,'published',JSON.stringify(r));assert.equal(r.card.publication.request_id,original.request_id);assert.equal(writes,1);
});

test('route is discoverable and 1.1 review accepted in MCP tool schemas',()=>{
 const t=cardTools.find(t=>t.name==='ima_card_route');assert.ok(t);assert.deepEqual(t.inputSchema.required,['card_id','directory_id']);assert.equal(t.annotations.readOnlyHint,false);
 assert.deepEqual(cardTools.find(t=>t.name==='ima_card_review_submit').inputSchema.properties.policy_version.enum,['1.0.0','1.1.0']);
});

test('a first publication saves the default route so a new version cannot silently change roots',async()=>{
 const c=context();await upgrade(c);const a=await cardAction('intake',draft(),c);
 await cardAction('review_submit',{...await reviewRequest(a.card),policy_version:'1.1.0'},c);
 const p=await cardAction('publish',{card_id:a.card.card_id},c);assert.equal(p.card?.status,'published');
 assert.equal((await c.store.get('card_routes',a.card.card_id))?.directory_id,'folder-learning');
 const bindings=await c.store.get('settings','bindings');bindings.categories.learning.folder_id='replacement-root';await c.store.put('settings','bindings',bindings);
 const next=await cardAction('intake',{...draft(),content:'新稿',card_id:a.card.card_id,expected_version:p.card.version},c);
 assert.equal(next.status,'conflict');assert.equal(c.calls.filter(x=>x.q.execute&&!x.q.reconcile).length,1);
});

test('frozen transactions survive root rebinding and directory records disappearing',async()=>{
 const c=context(),q=prepare(),p=await gov.governance('entry.prepare',q,c);c.receipt=await c.invoke('kb',{...p.transport_request,execute:true});
 await upgrade(c);let b=await c.store.get('settings','bindings');b.categories.learning.folder_id='replacement';await c.store.put('settings','bindings',b);
 const replay=await gov.governance('entry.prepare',q,c);assert.equal(replay.transport_request.folder_id,'folder-learning');
 assert.equal((await gov.governance('index.commit',{...q,media_id:'media-1'},c)).status,'succeeded');
 const c2=context();await upgrade(c2);const id=await child(c2),q2=prepare({policy_version:'1.1.0',entry:{...golden.entry,directory_id:id}});
 const p2=await gov.governance('entry.prepare',q2,c2);await c2.store.remove('directories',id);
 assert.deepEqual((await gov.governance('entry.prepare',q2,c2)).directory_snapshot,p2.directory_snapshot);
});

test('isolated upgrade changes only isolated policy state and keeps formal golden release',async()=>{
 const {scopedStore}=await import('../worker/admin.js');const c=context(),isolated={...c,workspace:'isolated',baseStore:c.store,store:scopedStore(c.store,'isolated')};
 await isolated.store.put('settings','policy',contract.policy);await isolated.store.put('settings','bindings',{...contract.bindings,kb_name:'隔离验收库'});
 await upgrade(isolated);assert.equal((await gov.governance('policy.get',{},isolated)).policy.policy_version,'1.1.0');
 assert.equal((await gov.governance('policy.get',{},c)).policy_sha256,contract.policy_sha256);
 assert.equal((await c.store.list('policy_releases')).items.length,0);assert.equal((await isolated.store.list('policy_releases')).items.length,2);
});

test('partial reservation migration is retryable and concurrent upgrades share the governance lease',async()=>{
 const c=context();await gov.governance('entry.prepare',prepare(),c);
 for(const collection of ['governance_requests','governance_reservations'])for(const {key,value} of (await c.store.list(collection)).items){delete value.transaction_snapshot;delete value.directory_snapshot;await c.store.put(collection,key,value);}
 const write=c.store.fencedWrite.bind(c.store);let injected=false;
 c.store.fencedWrite=async(method,col,...args)=>{if(col==='governance_reservations'&&!injected){injected=true;throw Error('stop while freezing');}return write(method,col,...args);};
 assert.equal(typeof gov.upgradePolicy,'function');assert.equal((await gov.upgradePolicy(c)).status,'unavailable');
 assert.equal((await gov.governance('policy.get',{},c)).policy.policy_version,'1.0.0');c.store.fencedWrite=write;
 const results=await Promise.all([gov.upgradePolicy(c),gov.upgradePolicy(c)]);assert.equal(results.filter(x=>x.status==='succeeded').length,1);assert.ok(results.some(x=>x.status==='conflict'));
 assert.equal((await gov.governance('entry.prepare',prepare(),c)).artifact.content_sha256,golden.content_sha256);
});

test('unavailable and cross-category intake targets leave the existing card unchanged',async()=>{
 const c=context();await upgrade(c);const a=await cardAction('intake',draft(),c);await child(c,'health-only','health','folder-health');
 for(const directory_id of ['missing','health-only'])assert.equal((await cardAction('intake',{...draft(),card_id:a.card.card_id,content:'改稿',expected_version:a.card.version,directory_id},c)).status,'conflict');
 const row=await cardAction('status',{card_id:a.card.card_id,include_content:true},c);assert.equal(row.card.content,draft().content);assert.equal(row.card.input_hash,a.card.input_hash);
});

test('a 1.0 review that already corrected the primary category remains valid in 1.1',async()=>{
 const c=context(),a=await cardAction('intake',draft(),c),q=await reviewRequest(a.card);
 q.category='health';q.evidence=q.evidence.map(e=>({...e,category:'health'}));
 assert.equal((await cardAction('review_submit',q,c)).status,'succeeded');await upgrade(c);
 const p=await cardAction('publish',{card_id:a.card.card_id},c);assert.equal(p.card?.status,'published',JSON.stringify(p));
 assert.equal(c.transport.folder_id,'folder-health');
});

test('deep targets resolve by real folder id, with the same frozen request after more siblings',async()=>{
 const c=context();await upgrade(c);await child(c,'level2');await child(c,'level3','learning','level2',3);await child(c,'level4','learning','level3',4);
 const q=prepare({policy_version:'1.1.0',directory_id:'level4'}),p=await gov.governance('entry.prepare',q,c);
 assert.equal(p.status,'preview');assert.equal(p.transport_request.folder_id,'level4');assert.equal(p.directory_snapshot.depth,4);
 assert.equal(p.directory_snapshot.path.length,4);await child(c,'unrelated');
 assert.deepEqual((await gov.governance('entry.prepare',q,c)).transport_request,p.transport_request);
});
