import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
let api = {};
try { api = await import('../worker/storage.js'); } catch {}
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE documents (collection TEXT NOT NULL, document_key TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(collection,document_key))');
  return { prepare(sql) { let values=[]; return {bind(...args){values=args;return this;},async first(){return db.prepare(sql).get(...values)||null;},async all(){return {results:db.prepare(sql).all(...values)};},async run(){const r=db.prepare(sql).run(...values);return {meta:{changes:Number(r.changes)}};}}; }};
}
test('persistent storage supports atomic create, CAS, pagination, and resource ownership',async()=>{
  assert.equal(typeof api.D1Store,'function');
  const store = new api.D1Store(database());
  assert.equal(await store.create('tasks','a',{n:1}),true);
  assert.equal(await store.create('tasks','a',{n:2}),false);
  assert.deepEqual(await store.get('tasks','a'),{n:1});
  assert.equal(await store.compareAndSwap('tasks','a',{n:0},{n:2}),false);
  assert.equal(await store.compareAndSwap('tasks','a',{n:1},{n:2}),true);
  await store.put('tasks','b',{n:3});
  const one=await store.list('tasks',{limit:1});assert.equal(one.has_more,true);
  const two=await store.list('tasks',{limit:1,cursor:one.next_cursor});assert.equal(two.items[0].key,'b');
  assert.equal(await store.acquireLock('note:1','r1'),true);
  assert.equal(await store.acquireLock('note:1','r2'),false);
  await store.releaseLock('note:1','r2');assert.equal(await store.acquireLock('note:1','r2'),false);
  await store.releaseLock('note:1','r1');assert.equal(await store.acquireLock('note:1','r2'),true);
});
test('write replay and timeout reconcile never dispatch a second create',async()=>{
  assert.equal(typeof api.runOperation,'function');
  const store=new api.D1Store(database());let writes=0;let reads=0;
  const provider=async(domain,q,ctx)=>{if(q.reconcile){reads++;return {status:'succeeded',resource:{note_id:'n1'}};}writes++;await ctx.onStage({resource:{note_id:'n1'}});return {status:'unknown',resource:{note_id:'n1'}};};
  const q={action:'create',request_id:'req-1',execute:true,content:'中文'};
  assert.equal((await api.runOperation('notes',q,{store,provider,env:{}})).status,'unknown');
  assert.equal((await api.runOperation('notes',q,{store,provider,env:{}})).status,'verification_pending');
  assert.equal(writes,1);
  assert.equal((await api.runOperation('notes',{...q,reconcile:true},{store,provider,env:{}})).status,'succeeded');
  assert.equal(reads,1);assert.equal(writes,1);
  assert.equal((await api.runOperation('notes',q,{store,provider,env:{}})).replayed,true);
  assert.equal((await api.runOperation('notes',{...q,content:'changed'},{store,provider,env:{}})).status,'conflict');
});
test('concurrent different requests cannot mutate same note and the loser can resume only before dispatch',async()=>{
  assert.equal(typeof api.runOperation,'function');const store=new api.D1Store(database());
  let resume;const gate=new Promise(r=>resume=r);let writes=0;
  const provider=async()=>{writes++;await gate;return {status:'succeeded',resource:{note_id:'same'}};};
  const ctx={store,provider,env:{}};
  const a=api.runOperation('notes',{action:'rename',request_id:'a',note_id:'same',title:'A',execute:true},ctx);
  await new Promise(r=>setTimeout(r,10));
  const b=await api.runOperation('notes',{action:'rename',request_id:'b',note_id:'same',title:'B',execute:true},ctx);
  assert.equal(b.status,'conflict');assert.equal(writes,1);resume();await a;
});
