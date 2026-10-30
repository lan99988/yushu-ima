import {scan,MAX_BYTES} from './ima-bytes.js';

export function stable(value, spaced=false) {
  const sep=spaced?', ':','; const colon=spaced?': ':':';
  if(Array.isArray(value))return '['+value.map(v=>stable(v,spaced)).join(sep)+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+colon+stable(value[k],spaced)).join(sep)+'}';
  return JSON.stringify(value);
}
export async function sha256(value) {
  const bytes=typeof value==='string'?new TextEncoder().encode(value):value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
const now=()=>new Date().toISOString();
const leaseLost=()=>Object.assign(Error('lease_lost'),{status:'conflict'});
export class D1Store {
  constructor(db){if(!db)throw Error('持久数据库尚未就绪');this.db=db;}
  async get(collection,key){const r=await this.db.prepare('SELECT payload FROM documents WHERE collection=? AND document_key=?').bind(collection,key).first();return r?JSON.parse(r.payload):null;}
  async put(collection,key,value){await this.db.prepare('INSERT INTO documents(collection,document_key,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(collection,document_key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').bind(collection,key,stable(value),now()).run();}
  async create(collection,key,value){const r=await this.db.prepare('INSERT INTO documents(collection,document_key,payload,updated_at) VALUES(?,?,?,?) ON CONFLICT(collection,document_key) DO NOTHING').bind(collection,key,stable(value),now()).run();return r.meta.changes===1;}
  async remove(collection,key){await this.db.prepare('DELETE FROM documents WHERE collection=? AND document_key=?').bind(collection,key).run();}
  async compareAndSwap(collection,key,expected,value){const r=await this.db.prepare('UPDATE documents SET payload=?,updated_at=? WHERE collection=? AND document_key=? AND payload=?').bind(stable(value),now(),collection,key,stable(expected)).run();return r.meta.changes===1;}
  async list(collection,{limit=50,cursor='',prefix=''}={}){
    if(!Number.isInteger(limit)||limit<1||limit>200)throw Error('分页数量应为1–200');
    let after='';if(cursor){try{after=decodeURIComponent(atob(cursor));}catch{throw Error('无效分页游标');}}
    const r=await this.db.prepare('SELECT document_key,payload FROM documents WHERE collection=? AND document_key>? AND document_key>=? AND document_key<? ORDER BY document_key LIMIT ?').bind(collection,after,prefix,prefix+'\uffff',limit+1).all();
    const more=r.results.length>limit;const rows=r.results.slice(0,limit);
    return {items:rows.map(x=>({key:x.document_key,value:JSON.parse(x.payload)})),has_more:more,next_cursor:more?btoa(encodeURIComponent(rows.at(-1).document_key)):''};
  }
  async acquireLock(key,requestId){if(await this.create('locks',key,{request_id:requestId,created_at:now()}))return true;return (await this.get('locks',key))?.request_id===requestId;}
  async releaseLock(key,requestId){const old=await this.get('locks',key);if(old?.request_id===requestId)await this.db.prepare('DELETE FROM documents WHERE collection=? AND document_key=? AND payload=?').bind('locks',key,stable(old)).run();}
  // Only the random-owner card/governance locks may expire. Provider resource
  // locks deliberately keep acquireLock's permanent, same-request semantics.
  async acquireLease(key,owner,{ttlMs=300000}={}){
    if(!/^(test:)?(card:|governance:)/.test(key)||!Number.isSafeInteger(ttlMs)||ttlMs<1)throw Error('invalid_short_lease');
    const value={key,request_id:owner,lease:true,created_at:now(),expires_at:Date.now()+ttlMs};
    if(await this.create('locks',key,value))return value;
    const old=await this.get('locks',key);
    // Pre-upgrade random locks get a conservative 15 minute grace period.
    // Missing/invalid timestamps cannot prove that a holder has stopped.
    const expiry=old?.lease===true?old.expires_at:Date.parse(old?.created_at)+900000;
    if(!Number.isFinite(expiry)||expiry>Date.now())return null;
    return await this.compareAndSwap('locks',key,old,value)?value:null;
  }
  async touchLease(lease){
    const old=await this.get('locks',lease.key);
    if(!old?.lease||old.request_id!==lease.request_id||old.expires_at<=Date.now())throw leaseLost();
    const next={...old,expires_at:Date.now()+300000};
    if(!await this.compareAndSwap('locks',lease.key,old,next))throw leaseLost();
  }
  async fencedWrite(method,collection,key,value,fences,expected){
    if(!fences?.length)throw leaseLost();
    const guard=fences.map(()=>"EXISTS(SELECT 1 FROM documents AS fence WHERE fence.collection='locks' AND fence.document_key=? AND json_extract(fence.payload,'$.request_id')=? AND json_extract(fence.payload,'$.lease')=1 AND json_extract(fence.payload,'$.expires_at')>?)").join(' AND ');
    const args=fences.flatMap(f=>[f.key,f.request_id,Date.now()]);let sql,values;
    if(method==='put'||method==='create'){
      sql='INSERT INTO documents(collection,document_key,payload,updated_at) SELECT ?,?,?,? WHERE '+guard+' ON CONFLICT(collection,document_key) DO '+(method==='create'?'NOTHING':'UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at');
      values=[collection,key,stable(value),now(),...args];
    }else if(method==='compareAndSwap'){
      sql='UPDATE documents SET payload=?,updated_at=? WHERE collection=? AND document_key=? AND payload=? AND '+guard;values=[stable(value),now(),collection,key,stable(expected),...args];
    }else if(method==='remove'){
      sql='DELETE FROM documents WHERE collection=? AND document_key=? AND '+guard;values=[collection,key,...args];
    }else throw Error('unsupported_fenced_write');
    const result=await this.db.prepare(sql).bind(...values).run();
    if(!result.meta.changes){for(const fence of fences)await this.touchLease(fence);if(method==='put')throw leaseLost();}
    return result.meta.changes===1;
  }
}
export async function withShortLease(ctx,key,fn){
  const root=ctx.baseStore||ctx.store,lockKey=(ctx.baseStore&&ctx.workspace==='isolated'?'test:':'')+key,owner=crypto.randomUUID();
  const lease=await root.acquireLease(lockKey,owner);if(!lease)throw Object.assign(Error(key.startsWith('card:')?'card_operation_in_progress':'operation_in_progress'),{status:'conflict'});
  const fences=[...(ctx.leaseFences||[]),lease];
  const guard=async()=>{for(const f of fences)await root.touchLease(f);};
  const physical=c=>ctx.baseStore&&ctx.workspace==='isolated'&&!['operations','locks','blob_metadata'].includes(c)?'test_'+c:c;
  const store=new Proxy(ctx.store,{get(target,name){
    if(['put','create','remove'].includes(name))return async(c,k,v)=>root.fencedWrite(name,physical(c),k,v,fences);
    if(name==='compareAndSwap')return async(c,k,a,b)=>root.fencedWrite(name,physical(c),k,b,fences,a);
    const value=target[name];return typeof value==='function'?value.bind(target):value;
  }});
  const next={...ctx,baseStore:root,store,leaseFences:fences,
    invoke:async(...args)=>{await guard();const result=await ctx.invoke(...args);await guard();return result;},
    blobs:{...ctx.blobs,put:async(...args)=>{await guard();const result=await ctx.blobs.put(...args);await guard();return result;}}
  };
  try{await guard();const result=await fn(next);await guard();return result;}finally{await root.releaseLock(lockKey,owner);}
}
// Native dispatch and administrative gate updates share one global lease.
// Acquire it after any library lease; administrative gate updates never acquire
// a library lease, so a close/freeze cannot race the final dispatch boundary.
export async function withServiceControls(ctx,fn){
  const base=ctx.baseStore||ctx.store;
  return withShortLease({...ctx,store:base,baseStore:base,workspace:'formal'},'governance:service-controls',controls=>fn({...ctx,leaseFences:controls.leaseFences,serviceControlStore:controls.store}));
}
const reads={notes:new Set(['list','search','get','list_notebooks']),kb:new Set(['kb.list','kb.addable','kb.get','folder.list','knowledge.search','media.info','media.read'])};
const writes={notes:new Set(['create','append','rename','delete','restore']),kb:new Set(['kb.create','folder.create','text.create','file.upload','url.import','note.associate','media.export'])};
function resourceKey(domain,q,account){
  const note=domain==='notes'?q.note_id:'ima-kb:'+(q.kb_id||(q.action==='media.export'?'export:'+q.media_id:'kb-create:'+account));
  return note?stable({domain:'knowledge',note_id:note},true):'request:'+q.request_id;
}
export async function runOperation(domain,request,ctx){
  const q=structuredClone(request);const {store,provider,env}=ctx;
  if(!q||Array.isArray(q)||typeof q.action!=='string')return {status:'invalid_input',message:'action_required'};
  for(const key of ['execute','reconcile','include_deleted'])if(key in q&&typeof q[key]!=='boolean')return {status:'invalid_input',message:key+'_must_be_boolean'};
  if(reads[domain]?.has(q.action))return provider(domain,q,{...ctx,state:{},onStage:async()=>{}});
  if(!writes[domain]?.has(q.action))return {status:'unsupported',message:'没有已验收的该项接口'};
  if(typeof q.request_id!=='string'||!q.request_id.trim()||q.request_id.length>200)return {status:'invalid_input',message:'stable_request_id_required'};
  if(!q.execute)return provider(domain,q,{...ctx,state:{},onStage:async()=>{}});
  const canonical=Object.fromEntries(Object.entries(q).filter(([k])=>!['execute','reconcile'].includes(k)));
  let fingerprintRequest=canonical;
  if(domain==='kb'&&q.action==='file.upload'&&q._original_request){
    const original=q._original_request;
    if(original.action!=='file.upload'||original.request_id!==q.request_id||original.kb_id!==q.kb_id||(original.folder_id||'')!==(q.folder_id||''))return {status:'conflict',message:'original_file_request_mismatch'};
    const metadata=await store.get('blob_metadata',q.blob_id);
    if(!metadata?.sha256)return {status:'unavailable',message:'verified_blob_metadata_required'};
    const filename=Object.hasOwn(original,'filename')?original.filename:(typeof original.file==='string'?original.file.split(/[\\/]/).at(-1):null);
    if(!filename||filename!==q.filename||(q.sha256&&q.sha256!==metadata.sha256)||(original.sha256&&original.sha256!==metadata.sha256)||(original.file_sha256&&original.file_sha256!==metadata.sha256))return {status:'conflict',message:'original_file_name_or_hash_mismatch'};
    const blob=await ctx.blobs?.get(q.blob_id);if(!blob?.body)return {status:'unavailable',message:'verified_blob_required'};
    let actual;try{actual=await scan(blob.body,{expectedSize:blob.size,limit:MAX_BYTES});}catch{return {status:'conflict',message:'blob_bytes_invalid'};}
    if(actual.sha256!==metadata.sha256)return {status:'conflict',message:'blob_content_hash_mismatch'};
    fingerprintRequest={...Object.fromEntries(Object.entries(original).filter(([k])=>!['execute','reconcile'].includes(k))),file_sha256:metadata.sha256};
  }
  const account=await sha256(env.IMA_OPENAPI_CLIENTID||'test');
  const fingerprint=await sha256(stable(fingerprintRequest,true)+account);
  let old=await store.get('operations',q.request_id);
  if(old&&old.fingerprint!==fingerprint)return {status:'conflict',request_id:q.request_id,message:'request_id_reused_with_different_input'};
  if(old?.receipt?.status==='succeeded')return {...old.receipt,replayed:true};
  const resource=old?.resource_key||resourceKey(domain,q,account);
  const unknown=new Set(['unknown','verification_pending','dispatched']);
  if(old?.running_until>Date.now())return {status:'verification_pending',request_id:q.request_id,message:'原请求仍在执行，等待其收据，暂不并发核对。'};
  if(old&&unknown.has(old.status)&&!q.reconcile)return {status:'verification_pending',request_id:q.request_id,resource:old.state?.resource||old.receipt?.resource,message:'已有派发记录，只能沿原请求核对，不能重新写入。'};
  if(old&&['failed','invalid_input','unsupported','tombstoned'].includes(old.status))return {...old.receipt,replayed:true};
  if(old&&!['reserved','blocked',...unknown].includes(old.status))return {...old.receipt,status:old.status,request_id:q.request_id,replayed:true};
  if(q.reconcile&&!old)return {status:'unavailable',request_id:q.request_id,message:'未找到原请求；不会以核对名义创建资源。'};
  if(!old){
    const reservation={request_id:q.request_id,domain,fingerprint,resource_key:resource,status:'reserved',request:canonical,state:{},created_at:now()};
    if(!await store.create('operations',q.request_id,reservation))return runOperation(domain,q,ctx);
    old=reservation;
  }
  if(!await store.acquireLock(resource,q.request_id)){
    if(!old.dispatched_at)await store.put('operations',q.request_id,{...old,status:'blocked'});
    return {status:'conflict',request_id:q.request_id,message:'resource_locked_by_another_request'};
  }
  const verifying=q.reconcile&&unknown.has(old.status);
  const running={...old,invocation_id:crypto.randomUUID(),request:old.request||canonical,status:verifying?'verification_pending':'dispatched',dispatched_at:old.dispatched_at||now(),running_until:Date.now()+300000,updated_at:now()};
  if(!await store.compareAndSwap('operations',q.request_id,old,running))return {status:'verification_pending',request_id:q.request_id,message:'相同请求正在处理，请读取原收据。'};
  const descriptor=domain==='kb'?{action:q.action,...Object.fromEntries(['kb_id','folder_id','filename'].filter(k=>q[k]).map(k=>[k,q[k]])),...(q.action==='text.create'?{content_sha256:await sha256(q.content)}:{})}:{action:q.action};
  let record=running;
  const onStage=async patch=>{const next={...record,state:{...record.state,...patch,resource:{...descriptor,...record.state?.resource,...patch.resource}},running_until:Date.now()+300000,updated_at:now()};if(!await store.compareAndSwap('operations',q.request_id,record,next))throw leaseLost();record=next;};
  let result;
  try{result=await provider(domain,{...q,...(verifying?{reconcile:true}:{})},{...ctx,state:record.state||record.receipt||{},onStage});}
  catch(e){result={status:'unknown',request_id:q.request_id,resource:record.state?.resource,message:String(e.message||e)};}
  result={...result,request_id:q.request_id,resource:{...descriptor,...record.state?.resource,...result.resource}};
  const safe={...result};delete safe.data;
  const completed={...record,status:result.status,receipt:safe,running_until:null,updated_at:now()};
  if(!await store.compareAndSwap('operations',q.request_id,record,completed))return {status:'verification_pending',request_id:q.request_id,message:'operation_owner_changed_reconcile_only'};
  if(!unknown.has(result.status))await store.releaseLock(resource,q.request_id);
  return result;
}
