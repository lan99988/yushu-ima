import {nativeHeaders} from './ima-session.js';

const ORIGIN='https://ima.qq.com',MAX_BYTES=2*1024*1024,TIMEOUT_MS=30000,MAX_PAGES=1000;
const ENDPOINTS=Object.freeze({list:'/cgi-bin/knowledge_tab_reader/get_knowledge_list',move:'/cgi-bin/knowledge_tab_sse/move_knowledge',resume:'/cgi-bin/knowledge_tab_sse/resume_cross_kb_op'});
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
class NativeFault extends Error {constructor(message,status='unavailable'){super(message);this.status=status;}}
const check=(ok,message='ima_native_invalid_response')=>{if(!ok)throw new NativeFault(message);};
const identifier=v=>typeof v==='string'&&v.length>0&&v.length<=2048&&!/[\x00-\x20\x7f]/.test(v);
const taskId=v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,512}$/.test(v);
const stop=stream=>{try{Promise.resolve(stream?.cancel()).catch(()=>{});}catch{/* Cancellation cannot replace the safe receipt. */}};

function deadline(){
 const controller=new AbortController();let reject;
 const expired=new Promise((resolve,r)=>{reject=r;});
 // Race fetch, each read and callbacks as well: injected fetchers may ignore abort.
 const timer=setTimeout(()=>{controller.abort();reject(new NativeFault('ima_native_timeout'));},TIMEOUT_MS);
 expired.catch(()=>{});
 return {signal:controller.signal,run:p=>Promise.race([p,expired]),close:()=>clearTimeout(timer)};
}

async function readJSON(response,clock){
 check(Number(response.headers.get('content-length')||0)<=MAX_BYTES);
 const reader=response.body?.getReader();check(reader);
 const decoder=new TextDecoder('utf-8',{fatal:true});let text='',size=0;
 try{
  for(;;){const {value,done}=await clock.run(reader.read());if(done)break;size+=value.byteLength;check(size<=MAX_BYTES);text+=decoder.decode(value,{stream:true});}
  text+=decoder.decode();return JSON.parse(text);
 }finally{stop(reader);reader.releaseLock();}
}

function payload(raw){
 check(object(raw));const nested=object(raw.data)?raw.data:null;
 const codes=[raw.code,nested?.code].filter(v=>v!==undefined);
 check(codes.length>0&&codes.every(v=>v===0),'ima_native_provider_rejected'+(codes.some(v=>Number.isSafeInteger(v)&&v!==0)?'_code_'+codes.find(v=>Number.isSafeInteger(v)&&v!==0):''));
 return {...raw,...nested};
}

function validatedPath(data,kbId,folderId){
 check(data.knowledge_base_info?.id===kbId,'ima_native_knowledge_base_mismatch');
 check(Array.isArray(data.current_path)&&data.current_path.length>0);
 const path=[],seen=new Set();
 for(const row of data.current_path){
  check(object(row)&&identifier(row.folder_id)&&typeof row.name==='string'&&typeof row.parent_folder_id==='string');
  check(!seen.has(row.folder_id));seen.add(row.folder_id);
  check(row.parent_folder_id===(path.length?path.at(-1).folder_id:''),'ima_native_path_mismatch');
  path.push({folder_id:row.folder_id,name:row.name,parent_folder_id:row.parent_folder_id});
 }
 check(path[0].folder_id===kbId&&path.at(-1).folder_id===(folderId||kbId),'ima_native_path_mismatch');
 return path;
}

function listItem(row,kbId,folderId){
 check(object(row)&&identifier(row.media_id)&&typeof row.title==='string'&&typeof row.parent_folder_id==='string'&&Number.isInteger(row.media_type));
 check(folderId?row.parent_folder_id===folderId:['',kbId].includes(row.parent_folder_id),'ima_native_parent_mismatch');
 const result={media_id:row.media_id,title:row.title,parent_folder_id:row.parent_folder_id,media_type:row.media_type};
 if(row.file_size!==undefined){check((typeof row.file_size==='string'&&/^\d+$/.test(row.file_size))||(Number.isSafeInteger(row.file_size)&&row.file_size>=0));result.file_size=row.file_size;}
 if(row.md5_sum!==undefined){check(typeof row.md5_sum==='string');result.md5_sum=row.md5_sum;}
 return {...result,kind:row.media_type===99?'folder':'file'};
}

function retCode(layers,keys){
 const codes=layers.flatMap(layer=>keys.map(k=>layer[k])).filter(v=>v!==undefined);
 check(codes.every(v=>Number.isSafeInteger(v)));
 return codes.find(v=>v!==0)??0;
}

function safeEvent(name,raw,redact,recordTask){
 check(object(raw));
 const layers=[raw];if(object(raw.data))layers.push(raw.data);
 for(const layer of [...layers])if(object(layer.progress_msg))layers.push(layer.progress_msg);
 const data=Object.assign({},...layers);
 const event={event:['PROGRESS','COMPLETE','SAMENAME'].includes(name)?name:'UNKNOWN'};
 for(const layer of layers)for(const key of ['task_id','taskId'])if(layer[key]!==undefined){
  check(taskId(layer[key]));recordTask(layer[key]);event.task_id=redact(layer[key]);
 }
 if(data.progress!==undefined){check(typeof data.progress==='number'&&Number.isFinite(data.progress)&&data.progress>=0&&data.progress<=100);event.progress=data.progress;}
 event.ret_code=retCode(layers,['code','ret_code','retCode']);
 check(data.results===undefined||Array.isArray(data.results));
 event.results=(data.results||[]).map(row=>{
  check(object(row)&&identifier(row.media_id));
  const result={media_id:redact(row.media_id)};
  if(row.title!==undefined){check(typeof row.title==='string');result.title=redact(row.title);}
  result.ret_code=retCode([row],['ret_code','retCode']);
  if(row.dst_media_id!==undefined){check(identifier(row.dst_media_id));result.dst_media_id=redact(row.dst_media_id);}
  return result;
 });
 return event;
}

/** Fixed-origin native transport. Completion is only an SSE receipt; callers
 * must verify resulting locations and hashes by reading back before committing.
 * A failed/unknown move is never retried here; resume uses only its original ID.
 */
export class NativeClient {
 #fetcher;#headers;#secrets;
 constructor(ctx,current){
  try{
   this.#fetcher=ctx.nativeFetcher||globalThis.fetch.bind(globalThis);
   this.#headers=nativeHeaders(current);
   const account=current.account_info,device=current.device_info||{};
   // idType/tokenType/accountType/version are public protocol enum values.
   // Treating strings such as "2" as secrets corrupts every matching resource ID.
   this.#secrets=[...['userId','token','refreshToken','uid','openId','guid'].map(k=>account[k]),device.guid,device.q36].filter(v=>typeof v==='string'&&v.length>0).sort((a,b)=>b.length-a.length);
  }catch{throw new NativeFault('ima_native_invalid_session','invalid_input');}
 }
 #redact(value){for(const secret of this.#secrets)value=value.replaceAll(secret,'[redacted]');return value;}
 async #post(operation,body,clock){
  let response;
  try{response=await clock.run(this.#fetcher(ORIGIN+ENDPOINTS[operation],{method:'POST',headers:{...this.#headers},body:JSON.stringify(body),redirect:'manual',signal:clock.signal}));}
  catch{throw new NativeFault('ima_native_transport_unavailable');}
  if(response.redirected||(response.status>=300&&response.status<400)){stop(response.body);throw new NativeFault('ima_native_redirect_rejected');}
  if(!(response.status>=200&&response.status<300)){stop(response.body);throw new NativeFault('ima_native_http_rejected');}
  return response;
 }
 async list(kbId,folderId=''){
  if(!identifier(kbId)||typeof folderId!=='string'||(folderId&&!identifier(folderId)))throw new NativeFault('ima_native_invalid_directory','invalid_input');
  const clock=deadline(),items=new Map(),cursors=new Set(['']);let cursor='',path,expectedTotal;
  try{
   for(let page=0;page<MAX_PAGES;page++){
    const response=await this.#post('list',{knowledge_base_id:kbId,folder_id:folderId,cursor,limit:50,need_default_cover:false},clock);
    const data=payload(await readJSON(response,clock));
    const nextPath=validatedPath(data,kbId,folderId);
    if(path)check(JSON.stringify(path)===JSON.stringify(nextPath),'ima_native_path_changed');else path=nextPath;
    check(typeof data.is_end==='boolean'&&Array.isArray(data.knowledge_list));
    if(data.total_size!==undefined){
     check((typeof data.total_size==='string'&&/^\d+$/.test(data.total_size))||Number.isSafeInteger(data.total_size));
     const total=Number(data.total_size);check(Number.isSafeInteger(total)&&total>=0);
     if(expectedTotal!==undefined)check(expectedTotal===total,'ima_native_total_changed');expectedTotal=total;
    }
    const before=items.size;
    for(const row of data.knowledge_list){const entry=listItem(row,kbId,folderId);if(items.has(entry.media_id))check(JSON.stringify(items.get(entry.media_id))===JSON.stringify(entry),'ima_native_item_changed');else items.set(entry.media_id,entry);}
    if(data.is_end){
     // At the library root total_size counts library content (observed 7/46),
     // while knowledge_list contains the 11 direct category folders. Root
     // completeness uses is_end plus the independent OpenAPI/root-ID check.
     // Non-root folders retain the direct-item count invariant.
     if(folderId&&expectedTotal!==undefined&&expectedTotal!==items.size){
      const folder_count=[...items.values()].filter(row=>row.kind==='folder').length;
      throw Object.assign(new NativeFault('ima_native_incomplete_list'),{diagnostics:{knowledge_base_id:kbId,folder_id:folderId,reported_total:expectedTotal,listed_count:items.size,folder_count,file_count:items.size-folder_count,pages:page+1,is_end:true}});
     }
     const clean=row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='string'?this.#redact(v):v]));
     return {items:[...items.values()].map(clean),path:path.map(clean),knowledge_base_id:this.#redact(kbId)};
    }
    check(items.size>before&&identifier(data.next_cursor)&&!cursors.has(data.next_cursor),'ima_native_incomplete_pagination');
    cursor=data.next_cursor;cursors.add(cursor);
   }
   throw new NativeFault('ima_native_pagination_limit');
  }catch(error){throw error instanceof NativeFault?error:new NativeFault('ima_native_invalid_response');}
  finally{clock.close();}
 }
 async move(body,onEvent){
  if(!object(body))throw new NativeFault('ima_native_invalid_move','invalid_input');
  return this.#stream('move',body,onEvent);
 }
 async resume(task_id,onEvent){
  if(!taskId(task_id))throw new NativeFault('ima_native_invalid_task','invalid_input');
  return this.#stream('resume',{task_id},onEvent,task_id);
 }
 async #stream(operation,body,onEvent,initialTask){
  const receipt={complete:false,conflict:false,...(initialTask?{task_id:this.#redact(initialTask)}:{}),events:[]};
  const clock=deadline();let reader,task=initialTask,failed=false,terminal=false;
  const recordTask=value=>{check(!task||task===value,'ima_native_task_changed');task=value;receipt.task_id=this.#redact(value);};
  try{
   let response;
   try{response=await this.#post(operation,body,clock);}
   catch(error){if(error.message==='ima_native_transport_unavailable')return receipt;throw error;}
   const type=response.headers.get('content-type')||'';
   if(type.split(';')[0].trim().toLowerCase()!=='text/event-stream'){
    stop(response.body);throw new NativeFault('ima_native_sse_required');
   }
   if(Number(response.headers.get('content-length')||0)>MAX_BYTES){stop(response.body);return receipt;}
   reader=response.body?.getReader();if(!reader)return receipt;
   const decoder=new TextDecoder('utf-8',{fatal:true});let buffer='',name='',data=[],size=0;
   const dispatch=async()=>{
    if(!data.length){name='';return;}
    const event=safeEvent(name,JSON.parse(data.join('\n')),v=>this.#redact(v),recordTask);
    name='';data=[];
    receipt.events.push(event);
    if(event.ret_code!==0||event.results.some(r=>r.ret_code!==0))failed=true;
    if(event.event==='SAMENAME')receipt.conflict=true;
    // Persist the safe event before accepting any terminal receipt. Callback
    // mutation must not be able to change the adapter's own completion state.
    if(onEvent)await clock.run(Promise.resolve().then(()=>onEvent(structuredClone(event))));
    if(event.event==='COMPLETE'||receipt.conflict||failed){
     receipt.complete=event.event==='COMPLETE'&&!receipt.conflict&&!failed;terminal=true;
    }
   };
   const consume=async(final=false)=>{
    while(!terminal){
     const at=buffer.search(/[\r\n]/);if(at<0)return;
     if(buffer[at]==='\r'&&at===buffer.length-1&&!final)return;
     const line=buffer.slice(0,at),width=buffer[at]==='\r'&&buffer[at+1]==='\n'?2:1;buffer=buffer.slice(at+width);
     if(!line){await dispatch();continue;}
     if(line.startsWith(':'))continue;
     const colon=line.indexOf(':'),field=colon<0?line:line.slice(0,colon);
     let value=colon<0?'':line.slice(colon+1);if(value.startsWith(' '))value=value.slice(1);
     if(field==='event')name=value;else if(field==='data')data.push(value);
    }
   };
   try{
    while(!terminal){
     const {value,done}=await clock.run(reader.read());
     if(done){buffer+=decoder.decode();await consume(true);break;}
     size+=value.byteLength;check(size<=MAX_BYTES,'ima_native_sse_size_limit');
     buffer+=decoder.decode(value,{stream:true});await consume();
    }
   }catch{receipt.complete=false;}
   return receipt;
  }finally{
   clock.close();if(reader){stop(reader);reader.releaseLock();}
  }
 }
}
