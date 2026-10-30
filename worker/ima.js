/* ESM adaptation of local ima_kb.py / ima_notes.py and ima-note-cli 0.1.0
 * (Author: Codex, MIT; vendor/runtime and vendor/ima-note-cli/src).
 * The upstream package declares MIT without a separate copyright notice.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * No Python, filesystem, ledger or locking. Parent persists/merges onStage.
 */
import {scan, measured, MAX_BYTES, Sha256} from './ima-bytes.js';
const enc=new TextEncoder(), PREFIX='【已删除】', MiB=1024*1024;
const compact=s=>s.replace(/\s/gu,'');
const plain=s=>compact(s.replace(/^#{1,6}\s+/gm,''));
const hex=b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');
const digest=async s=>hex(await crypto.subtle.digest('SHA-256',typeof s==='string'?enc.encode(s):s));
class Fault extends Error {constructor(code,status='unavailable'){super(code);this.status=status;}}
const need=(q,k)=>{if(typeof q[k]!=='string'||!q[k].trim()||!q[k].isWellFormed())throw new Fault(k+'_required','invalid_input');return q[k];};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const arr=(v,k)=>{if(!Array.isArray(v[k]))throw new Fault('invalid_response_'+k);return v[k];};
const check=(truth,msg,status='unavailable')=>{if(!truth)throw new Fault(msg,status);};
const id=(v,k)=>{check(typeof v[k]==='string'&&v[k].length>0,'missing_'+k);return v[k];};
const READ_NOTES=new Set(['list','search','get','list_notebooks','notebook.list']);
const WRITE_NOTES=new Set(['create','append','rename','delete','restore']);
const READ_KB=new Set(['kb.list','kb.addable','kb.get','folder.list','knowledge.search','media.info','media.read']);
const WRITE_KB=new Set(['kb.create','folder.create','text.create','file.upload','url.import','note.associate','media.export']);
// Frozen arrays avoid exporting mutable Sets into the parent's route registry.
export const IMA_ROUTES=Object.freeze({
 notes:Object.freeze({read:Object.freeze([...READ_NOTES]),write:Object.freeze([...WRITE_NOTES])}),
 kb:Object.freeze({read:Object.freeze([...READ_KB]),write:Object.freeze([...WRITE_KB])}),
});
export const IMA_READ_ACTIONS=Object.freeze({notes:IMA_ROUTES.notes.read,kb:IMA_ROUTES.kb.read});
export const IMA_WRITE_ACTIONS=Object.freeze({notes:IMA_ROUTES.notes.write,kb:IMA_ROUTES.kb.write});
// Workers require length metadata for streamed fetch/R2 bodies. Node mock tests
// use the same backpressure/cancellation path with a FixedLengthStream shim.
function lengthBody(stream,size){
 if(typeof globalThis.FixedLengthStream!=='function')return {body:stream,finished:Promise.resolve(),async abort(){await stream.cancel().catch(()=>{});}};
 const fixed=new globalThis.FixedLengthStream(size),controller=new AbortController();
 const finished=stream.pipeTo(fixed.writable,{signal:controller.signal});finished.catch(()=>{});
 return {body:fixed.readable,finished,async abort(){
  controller.abort();
  // Unblock a backpressured write when the consumer rejected before reading.
  await fixed.readable.cancel().catch(()=>{});
  await finished.catch(()=>{});
 }};
}
function sourceUrl(raw){
 let u;try{u=new URL(raw);}catch{throw new Fault('unsafe_media_url');}
 const host=u.hostname.toLowerCase();
 check(u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&!/[\x00-\x20\x7f]/.test(raw)&&
   (['ima.qq.com','res-skb.ima.qq.com','mp.weixin.qq.com'].includes(host)||/^[a-z0-9][a-z0-9.-]*\.myqcloud\.com$/.test(host))&&
   host.split('.').every(l=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)),'unsafe_media_url');
 return u;
}
function publicUrl(raw){let u;try{u=new URL(raw);}catch{throw new Fault('public_http_urls_required','invalid_input');}const h=u.hostname;
 check(['http:','https:'].includes(u.protocol)&&!u.port&&!u.username&&!u.password&&!/[\x00-\x20\x7f]/.test(raw)&&
 h.includes('.')&&!/^\d+(?:\.\d+)*$/.test(h)&&!h.includes(':')&&!/(^|\.)(localhost|local|internal|test|invalid|onion)$/.test(h)&&
 !/(^|\.)(bilibili\.com|b23\.tv|youtube\.com|youtu\.be)$/.test(h)&&h.split('.').every(l=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(l)), 'unsafe_public_url','invalid_input');return raw;
}
function sourceHeaders(raw={},env){
 check(object(raw),'unsafe_source_headers');const result={};
 for(const [k,v] of Object.entries(raw)){
  const lower=k.toLowerCase();
  check(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)&&typeof v==='string'&&!/[\x00-\x1f\x7f]/.test(v),'unsafe_source_headers');
  check(!['host','content-length','connection','transfer-encoding','cookie','set-cookie','proxy-authorization'].includes(lower)&&!lower.startsWith('ima-openapi-'),'unsafe_source_headers');
  check(![env.IMA_OPENAPI_CLIENTID,env.IMA_OPENAPI_APIKEY].filter(Boolean).some(s=>v.includes(s)),'unsafe_source_headers');result[k]=v;
 }return result;
}
const FILES={pdf:[1,'application/pdf'],doc:[3,'application/msword'],docx:[3,'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],ppt:[4,'application/vnd.ms-powerpoint'],pptx:[4,'application/vnd.openxmlformats-officedocument.presentationml.presentation'],xls:[5,'application/vnd.ms-excel'],xlsx:[5,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],csv:[5,'text/csv'],md:[7,'text/markdown'],markdown:[7,'text/markdown'],png:[9,'image/png'],jpg:[9,'image/jpeg'],jpeg:[9,'image/jpeg'],webp:[9,'image/webp'],txt:[13,'text/plain'],xmind:[14,'application/x-xmind'],mp3:[15,'audio/mpeg'],m4a:[15,'audio/x-m4a'],wav:[15,'audio/wav'],aac:[15,'audio/aac'],html:[20,'text/html'],epub:[21,'application/epub+zip']};
const LIMITS={5:10*MiB,7:10*MiB,9:30*MiB,13:10*MiB,14:10*MiB,20:10*MiB,21:50*MiB};
const TEXT_EXT=new Set(['txt','md','markdown','csv','html']);
function fileSpec(name,mime,size){
 check(typeof name==='string'&&name.isWellFormed()&&name.length<=1024&&!/[\\/:*?"<>|\x00-\x1f\x7f]/.test(name)&&!/[ .]$/.test(name)&&!/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name),'unsafe_filename','invalid_input');
 const ext=name.split('.').at(-1).toLowerCase(),mapping=FILES[ext];check(name.includes('.')&&mapping,'unsupported_file_type','invalid_input');
 const [type,contentType]=mapping,provided=(mime||'').split(';')[0].trim().toLowerCase();
 const alias={md:['text/x-markdown','application/md','application/markdown'],markdown:['text/x-markdown','application/md','application/markdown'],xmind:['application/vnd.xmind.workbook','application/zip']};
 check(!provided||provided==='application/octet-stream'||provided===contentType||alias[ext]?.includes(provided),'mime_extension_mismatch','invalid_input');
 check(Number.isSafeInteger(size)&&size>0&&size<=(LIMITS[type]||MAX_BYTES),'file_size_limit','invalid_input');
 return {name,ext,type,contentType:provided&&provided!=='application/octet-stream'?provided:contentType,size};
}
function signature(spec,head){
 const starts=(...bytes)=>bytes.every((x,i)=>head[i]===x),ascii=new TextDecoder('latin1').decode(head),ext=spec.ext;
 let valid=true;
 if(ext==='pdf')valid=ascii.startsWith('%PDF-');
 else if(['doc','ppt','xls'].includes(ext))valid=starts(0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1);
 else if(['docx','pptx','xlsx','xmind','epub'].includes(ext))valid=starts(0x50,0x4b,3,4);
 else if(ext==='png')valid=starts(137,80,78,71,13,10,26,10);
 else if(['jpg','jpeg'].includes(ext))valid=starts(255,216,255);
 else if(ext==='webp')valid=ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WEBP';
 else if(ext==='mp3')valid=ascii.startsWith('ID3')||(head[0]===255&&(head[1]&224)===224);
 else if(ext==='m4a')valid=ascii.slice(4,8)==='ftyp';
 else if(ext==='aac')valid=head[0]===255&&(head[1]&246)===240;
 else if(ext==='wav'){
  valid=ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WAVE';
  let rate=0,length=0;const v=new DataView(head.buffer,head.byteOffset,head.byteLength);
  for(let p=12;p+8<=head.length;){const n=v.getUint32(p+4,true),tag=ascii.slice(p,p+4);if(tag==='fmt '&&n>=16&&p+24<=head.length)rate=v.getUint32(p+16,true);if(tag==='data'){length=n;break;}p+=8+n+(n%2);}
  valid=valid&&rate>0&&length>0&&length/rate<=7200;
 }else if(TEXT_EXT.has(ext)){try{const s=new TextDecoder('utf-8',{fatal:true}).decode(head,{stream:true});valid=!s.includes('\u0000');}catch{valid=false;}}
 check(valid,'invalid_file_signature','invalid_input');
}

class Transport {
 constructor(domain,q,ctx){this.domain=domain;this.q=q;this.ctx=ctx;this.env=ctx.env||{};this.fetcher=ctx.fetcher||((...args)=>globalThis.fetch(...args));const s=ctx.state||{};let saved=s.receipt;if(typeof saved==='string'){try{saved=JSON.parse(saved);}catch{saved={};}}this.resource={...(saved?.resource||{}),...(s.resource||{})};this.receipt={...(saved?.receipt||saved||{})};delete this.receipt.resource;this.receipt.stages={...(this.receipt.stages||{}),...(s.stages||{})};this.dispatched=false;this.wrote=false;}
 result(status,data,message){return {status,request_id:this.q?.request_id,resource:{...this.resource},receipt:{...this.receipt,stages:{...this.receipt.stages}},...(data===undefined?{}:{data}),...(message?{message}:{})};}
 async stage(name,status,extra={}){
  check(typeof this.ctx.onStage==='function','onStage_required','invalid_input');
  this.receipt.stages[name]=status;
  await this.ctx.onStage({status:status==='verified'?'succeeded':status==='before'?'unknown':'verification_pending',stage:name,resource:{...this.resource},receipt:{...this.receipt,stages:{...this.receipt.stages}},...extra});
 }
 async request(url,options,timeout=30000){let res;try{res=await this.fetcher(url,{...options,redirect:'manual',signal:AbortSignal.timeout(timeout)});}catch{throw new Fault('network_error');}
  if(res.status<200||res.status>=300){await res.body?.cancel().catch(()=>{});throw new Fault(res.status>=300&&res.status<400?'redirect_refused':'http_error_'+res.status);}return res;
 }
 async api(ns,path,body,write=false){
  if(write){check(!this.q.reconcile,'reconcile_write_forbidden');await this.stage(path,'before');this.dispatched=true;}
  check(this.env.IMA_OPENAPI_CLIENTID&&this.env.IMA_OPENAPI_APIKEY,'missing_credentials');
  const r=await this.request('https://ima.qq.com/openapi/'+ns+'/v1/'+path,{method:'POST',headers:{'content-type':'application/json; charset=utf-8','ima-openapi-clientid':this.env.IMA_OPENAPI_CLIENTID,'ima-openapi-apikey':this.env.IMA_OPENAPI_APIKEY,'ima-openapi-ctx':'skill_version=1.1.10'},body:JSON.stringify(body)});
  let payload;try{const b=await scan(r.body,{limit:16*MiB,collect:true});payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b.bytes));}catch{throw new Fault('invalid_response');}
  check(object(payload)&&payload.code===0&&object(payload.data),'provider_error');return payload.data;
 }
 note(path,body,write=false){return this.api('note',path,body,write);}
 wiki(path,body,write=false){return this.api('wiki',path,body,write);}
 async notesPage(q){
  const limit=q.limit??20;check(Number.isInteger(limit)&&limit>=1&&limit<=20,'limit_must_be_integer_1_to_20','invalid_input');
  let d,items,next={};
  if(q.action==='search'){
   const query=need(q,'query'),start=q.start??0;check(Number.isInteger(start)&&start>=0,'invalid_start','invalid_input');
   const searchType=q.search_type??0;
   d=await this.note('search_note',{search_type:searchType,sort_type:0,query_info:searchType===1?{content:query}:{title:query},start,end:start+limit});items=arr(d,'search_note_infos').map(x=>x.note_book_info);next.next_start=d.is_end===true?null:start+limit;
  }else if(['list_notebooks','notebook.list'].includes(q.action)){
   d=await this.note('list_notebook',{cursor:q.cursor??'0',limit,...(q.version?{version:q.version}:{})});items=arr(d,'note_folder_infos');
   return {items,has_more:d.is_end!==true,next_cursor:d.is_end===true?null:d.next_cursor||null,next_version:d.next_version,...(d.is_end!==true&&!d.next_cursor?{warning:'pagination_unverified'}:{})};
  }else{
   check(q.cursor===undefined||typeof q.cursor==='string','cursor_must_be_string','invalid_input');
   d=await this.note('list_note',{folder_id:q.folder_id||'',sort_type:0,cursor:q.cursor||'',limit});items=arr(d,'note_book_list');next.next_cursor=d.is_end===true?null:d.next_cursor||null;
   if(d.is_end!==true&&!next.next_cursor)next.warning='pagination_unverified: provider has not returned a continuation cursor';
  }
  const clean=items.map(x=>{check(object(x)&&typeof x.note_id==='string'&&typeof x.title==='string','invalid_note_metadata');return Object.fromEntries(['note_id','title','summary','create_time','modify_time'].filter(k=>k in x).map(k=>[k,x[k]]));});
  return {items:clean.filter(x=>q.include_deleted||!x.title.startsWith(PREFIX)).map(x=>({...x,tombstoned:x.title.startsWith(PREFIX)})),has_more:d.is_end!==true,...next};
 }
 async lookup(noteId,hint){
  let cursor='',seen=new Set();
  for(let i=0;i<100;i++){const p=await this.notesPage({action:'list',cursor,include_deleted:true});const n=p.items.find(x=>x.note_id===noteId);if(n)return n;if(!p.has_more)break;cursor=p.next_cursor;if(!cursor||seen.has(cursor))break;seen.add(cursor);}
  if(hint)for(let start=0;start<2000;start+=20){const p=await this.notesPage({action:'search',query:hint,start,include_deleted:true});const n=p.items.find(x=>x.note_id===noteId);if(n)return n;if(!p.has_more)break;}
  throw new Fault('note_metadata_not_found_or_pagination_unverified');
 }
 async content(noteId){const d=await this.note('get_doc_content',{note_id:noteId,target_content_format:0});check(typeof d.content==='string','missing_content');return d.content;}
 async getNote(noteId,hint){const n=await this.lookup(noteId,hint);if(n.tombstoned&&!this.q.include_deleted)throw new Fault('content_hidden_tombstone','tombstoned');return {...n,content:await this.content(noteId)};}
 async pages(endpoint,body,key,initialCursor=''){
  check(typeof initialCursor==='string','cursor_must_be_string','invalid_input');
  let cursor=initialCursor,items=[],seen=new Set(cursor?[cursor]:[]);
  for(let i=0;i<100;i++){
   const d=await this.wiki(endpoint,{...body,cursor});items.push(...arr(d,key));
   if(endpoint==='search_knowledge'){
    // The provider also returns single-page searches with neither pagination field.
    const hasEnd=Object.hasOwn(d,'is_end'),hasCursor=Object.hasOwn(d,'next_cursor');
    if(!hasEnd&&!hasCursor)return items;
    check(hasEnd&&hasCursor&&typeof d.is_end==='boolean'&&(typeof d.next_cursor==='string'||d.next_cursor===null),'pagination_unverified');
   }
   if(d.is_end===true)return items;
   check(d.is_end===false&&typeof d.next_cursor==='string'&&d.next_cursor&&!seen.has(d.next_cursor),'pagination_unverified');seen.add(d.next_cursor);cursor=d.next_cursor;
  }throw new Fault('pagination_limit_reached');
 }
 async kbGet(kbId){const d=await this.wiki('get_knowledge_base',{ids:[kbId]});check(object(d.infos)&&object(d.infos[kbId]),'knowledge_base_not_found');return d.infos[kbId];}
 async browse(kbId,folderId){const items=await this.pages('get_knowledge_list',{knowledge_base_id:kbId,limit:50,...(folderId?{folder_id:folderId}:{})},'knowledge_list');return items.map(x=>{const mid=x.media_id||x.folder_id;return {...x,media_id:mid,title:x.title||x.name,kind:x.folder_id||mid?.startsWith('folder_')?'folder':'file'};});}
 async info(mediaId){const d=await this.wiki('get_media_info',{media_id:mediaId});check(Number.isInteger(d.media_type),'invalid_media_type');
  if(d.media_type===11){check(!d.url_info&&object(d.notebook_ext_info),'conflicting_media_metadata');return {media_id:mediaId,media_type:11,source_kind:'note',note_id:id(d.notebook_ext_info,'notebook_id')};}
  check(!d.notebook_ext_info,'conflicting_media_metadata');if(!d.url_info)return {media_id:mediaId,media_type:d.media_type,source_kind:'unavailable'};
  const raw=id(d.url_info,'url');sourceUrl(raw);
  check(![this.env.IMA_OPENAPI_CLIENTID,this.env.IMA_OPENAPI_APIKEY].filter(Boolean).some(s=>raw.includes(s)||raw.includes(encodeURIComponent(s))),'credential_in_source_url');
  return {media_id:mediaId,media_type:d.media_type,source_kind:'url',access:d.url_info};
 }
 async download(mediaId,forceBlob=false,hashOnly=false){
  const info=await this.info(mediaId);
  if(info.source_kind==='note'){
   const n=await this.getNote(info.note_id,this.q.title_hint);
   if(!forceBlob)return n;
   const bytes=enc.encode(n.content);
   return this.storeDownload(new Response(bytes),'text/plain',String(bytes.length));
  }
  check(info.access,'media_source_unavailable');const u=sourceUrl(info.access.url),headers=sourceHeaders(info.access.headers||{},this.env);
  const response=await this.request(u.href,{method:'GET',headers},300000);
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_BYTES)){
   await response.body?.cancel().catch(()=>{});throw new Fault('media_size_limit');
  }
  const contentType=(response.headers.get('content-type')||'application/octet-stream').split(';')[0].toLowerCase();
  if(hashOnly){const v=await scan(response.body,{limit:MAX_BYTES,...(length!==null?{expectedSize:Number(length)}:{})});return {sha256:v.sha256,size:v.size,content_type:contentType};}
  if(!forceBlob&&/^(text\/|application\/(json|xml|xhtml\+xml))/.test(contentType)&&length!==null&&Number(length)<=MiB){
   const v=await scan(response.body,{limit:MiB,collect:true,expectedSize:Number(length)});return {content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(v.bytes),sha256:v.sha256,size:v.size,content_type:contentType};
  }
  return this.storeDownload(response,contentType,length);
 }
 async storeDownload(response,contentType,length){
  check(this.ctx.blobs?.put&&this.ctx.blobs?.get,'blobs_required');check(!this.q.reconcile,'reconcile_write_forbidden');
  // Unknown-length streams cannot be passed to R2's fixed-size upload API.
  // Bound this fallback to 8 MiB; known-length originals remain streamed to 200 MiB.
  let buffered;
  if(length===null){buffered=await scan(response.body,{limit:8*MiB,collect:true});length=String(buffered.size);}
  const key='ima-original/'+await digest((this.q.request_id||crypto.randomUUID())+':'+this.q.media_id);
  this.resource.blob_id=key;await this.stage('blob_put','before');this.dispatched=true;
  // Transform performs a bounded streaming digest without tee() buffering the file.
  const reader=buffered?new Blob([buffered.bytes]).stream().getReader():response.body.getReader();let count=0;const h=new Sha256();let done=false;
  const stream=new ReadableStream({async pull(c){try{const r=await reader.read();if(r.done){if(length!==null&&count!==Number(length))throw Error('size_mismatch');done=true;c.close();return;}count+=r.value.length;if(count>MAX_BYTES)throw Error('media_size_limit');h.update(r.value);c.enqueue(r.value);}catch(e){await reader.cancel().catch(()=>{});c.error(e);}},cancel(r){return reader.cancel(r);}});
  const transfer=lengthBody(stream,Number(length));
  try{await this.ctx.blobs.put(key,transfer.body,{contentType});await transfer.finished;check(done,'blob_put_incomplete');}catch{await transfer.abort();await reader.cancel().catch(()=>{});throw new Fault('blob_put_failed');}
  this.receipt.output_sha256=h.hex();this.receipt.output_size=count;this.receipt.content_type=contentType;
  await this.stage('blob_put','recorded');
  await this.verifyBlob();
  return {blob_id:key,sha256:this.receipt.output_sha256,size:count,content_type:contentType,private:true};
 }
 async verifyBlob(){
  check(this.resource.blob_id&&this.receipt.output_sha256&&this.ctx.blobs?.get,'blob_receipt_missing');
  const obj=await this.ctx.blobs.get(this.resource.blob_id);check(obj,'blob_not_found');const v=await scan(obj.body,{expectedSize:this.receipt.output_size});check(v.sha256===this.receipt.output_sha256,'blob_readback_hash_mismatch');
 }
 async read(){const q=this.q,a=q.action;
  if(this.domain==='notes')return this.result('succeeded',a==='get'?await this.getNote(need(q,'note_id'),q.title_hint):await this.notesPage(q));
  let data;
  if(a==='kb.list'||a==='kb.addable')data={knowledge_bases:await this.pages(a==='kb.list'?'search_knowledge_base':'get_addable_knowledge_base_list',a==='kb.list'?{query:q.query||'',limit:20}:{limit:50},a==='kb.list'?'info_list':'addable_knowledge_base_list'),has_more:false};
  else if(a==='kb.get')data={knowledge_base:await this.kbGet(need(q,'kb_id'))};
  else if(a==='folder.list')data={items:await this.browse(need(q,'kb_id'),q.folder_id),has_more:false};
  else if(a==='knowledge.search')data={items:await this.pages('search_knowledge',{knowledge_base_id:need(q,'kb_id'),query:need(q,'query')},'info_list',q.cursor??''),has_more:false};
  else if(a==='media.info'){const {access,...safe}=await this.info(need(q,'media_id'));data=safe;}
  else data=await this.download(need(q,'media_id'));
  return this.result('succeeded',data);
 }
 async verify(){
  const q=this.q,r=this.resource,a=q.action;
  try{
   if(this.domain==='notes'){
    check(r.note_id,'no_recorded_note_id');
    if(['rename','delete','restore'].includes(a)){
     check(typeof r.target_title==='string'&&this.receipt.before_content_sha256,'missing_verification_receipt');
     const n=await this.lookup(r.note_id,r.target_title);check(n.title===r.target_title,'title_readback_mismatch');check(await digest(await this.content(r.note_id))===this.receipt.before_content_sha256,'content_changed_during_title_operation');
    }else{check(this.receipt.expected_compact_sha256,'missing_verification_receipt');check(await digest(compact(await this.content(r.note_id)))===this.receipt.expected_compact_sha256,'content_readback_mismatch');}
   }else if(a==='media.export'){
    await this.verifyBlob();return this.result('succeeded',{blob_id:r.blob_id,private:true,sha256:this.receipt.output_sha256,size:this.receipt.output_size,content_type:this.receipt.content_type});
   }else if(a==='kb.create'){check(r.kb_id&&r.name,'no_recorded_kb_id');check((await this.kbGet(r.kb_id)).name===r.name,'kb_name_readback_mismatch');}
   else if(a==='folder.create'){check(r.kb_id&&r.folder_id&&r.name,'no_recorded_folder_id');const items=await this.browse(r.kb_id,r.parent_folder_id);check(items.some(x=>x.media_id===r.folder_id&&x.title===r.name),'folder_membership_readback_mismatch');}
   else{
    check(r.kb_id&&r.media_ids?.length,'no_recorded_media_id');
    if(a==='url.import')check(this.receipt.expected_media_count===r.media_ids.length&&!this.receipt.import_failed,'partial_url_import');
    const items=await this.browse(r.kb_id,r.folder_id);check(r.media_ids.every(mid=>items.some(x=>x.media_id===mid)),'media_membership_pending');
    if(['text.create','file.upload'].includes(a)){
     check(this.receipt.input_sha256,'missing_input_hash');const original=await this.download(r.media_ids[0],false,true);
     check(original.sha256===this.receipt.input_sha256,'original_hash_readback_mismatch');
    }
   }
   if(typeof this.ctx.onStage==='function')await this.stage('readback','verified');
   return this.result('succeeded');
  }catch{ return this.result('verification_pending',undefined,'readback_not_confirmed'); }
 }
 async notesWrite(){
  const q=this.q,a=q.action;let note,original,target;
  if(a!=='create'){
   need(q,'note_id');check(typeof q.expected_title==='string','expected_title_required','invalid_input');
   note=await this.lookup(q.note_id,q.expected_title);check(note.title===q.expected_title,'expected_title_mismatch','conflict');
   if(note.tombstoned&&['append','rename'].includes(a))throw new Fault('content_hidden_tombstone','tombstoned');
   original=await this.content(q.note_id);this.receipt.before_content_sha256=await digest(original);
   if(q.expected_content_sha256||q.before_content_sha256)check((q.expected_content_sha256||q.before_content_sha256)===this.receipt.before_content_sha256,'expected_content_hash_mismatch','conflict');
   this.resource.note_id=q.note_id;
  }
  if(a==='delete')target=note.tombstoned?note.title:PREFIX+note.title;
  if(a==='restore')target=note.tombstoned?note.title.slice(PREFIX.length):note.title;
  if(a==='rename'){target=need(q,'title');check(!target.startsWith(PREFIX),'rename_requires_active_title','invalid_input');}
  if(target!==undefined){check(target.trim()&&target.length<=500,'invalid_target_title','invalid_input');this.resource.target_title=target;}
  if(['create','append'].includes(a))this.receipt.expected_compact_sha256=await digest((a==='append'?compact(original):'')+plain(need(q,'content')));
  if(!q.execute)return this.result('preview');
  if(a!=='create'){
   check((await this.lookup(q.note_id,q.expected_title)).title===q.expected_title,'title_changed_before_submit','conflict');
   check(await digest(await this.content(q.note_id))===this.receipt.before_content_sha256,'content_changed_before_submit','conflict');
  }
  if(a==='create'){
   const d=await this.note('import_doc',{content:q.content,content_format:1,...(q.folder_id?{folder_id:q.folder_id}:{})},true);this.resource.note_id=id(d,'note_id');await this.stage('import_doc','recorded');
  }else if(a==='append'){await this.note('append_doc',{note_id:q.note_id,content:q.content,content_format:1},true);await this.stage('append_doc','recorded');}
  else if(target!==note.title){await this.note('rename_note',{note_id:q.note_id,title:target},true);await this.stage('rename_note','recorded');}
  return this.verify();
 }
 async inspectFile(){
  const q=this.q;let get;
  if(q.action==='text.create'){
   const bytes=enc.encode(need(q,'content'));check(bytes.length<=10*MiB,'text_limit_10MiB','invalid_input');check(/\.(txt|md|markdown|html)$/i.test(need(q,'filename')),'text_filename_type_not_supported','invalid_input');
   get=async()=>({size:bytes.length,body:new Blob([bytes]).stream(),httpMetadata:{contentType:FILES[q.filename.split('.').at(-1).toLowerCase()][1]}});
  }else{need(q,'blob_id');check(this.ctx.blobs?.get,'blobs_required','invalid_input');get=()=>this.ctx.blobs.get(q.blob_id);}
  const obj=await get();check(obj,'blob_not_found','invalid_input');const spec=fileSpec(need(q,'filename'),q.content_type||obj.httpMetadata?.contentType,obj.size);
  let v;try{v=await scan(obj.body,{expectedSize:spec.size,limit:LIMITS[spec.type]||MAX_BYTES,text:TEXT_EXT.has(spec.ext)});}catch{throw new Fault('invalid_file_bytes','invalid_input');}
  signature(spec,v.head);this.receipt.input_sha256=v.sha256;this.receipt.input_size=v.size;
  if(q.sha256)check(q.sha256===v.sha256,'input_hash_mismatch','conflict');return {spec,get};
 }
 async upload(file){
  const q=this.q,{spec,get}=file;
  const repeated=await this.wiki('check_repeated_names',{knowledge_base_id:q.kb_id,params:[{name:spec.name,media_type:spec.type}],...(q.folder_id?{folder_id:q.folder_id}:{})});
  const results=arr(repeated,'results');check(results.length===1&&results[0].name===spec.name&&typeof results[0].is_repeated==='boolean','repeated_name_mismatch');check(!results[0].is_repeated,'same_name_file_exists','conflict');
  const d=await this.wiki('create_media',{knowledge_base_id:q.kb_id,file_name:spec.name,file_size:spec.size,content_type:spec.contentType,file_ext:spec.ext},true);
  const mid=id(d,'media_id');this.resource.media_ids=[mid];this.receipt.orphaned_media=true;await this.stage('create_media','recorded');
  const c=d.cos_credential;check(object(c),'invalid_cos_credential');
  const label=/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  check(typeof c.bucket_name==='string'&&typeof c.region==='string'&&label.test(c.bucket_name)&&label.test(c.region),'unsafe_cos_origin');
  const host=`${c.bucket_name}.cos.${c.region}.myqcloud.com`.toLowerCase();
  check(typeof c.cos_key==='string'&&c.cos_key&&!/[\\?#\x00-\x1f\x7f]/.test(c.cos_key)&&!c.cos_key.split('/').some(s=>['','.','..'].includes(s)),'unsafe_cos_key');
  const decimal=x=>typeof x==='number'&&Number.isSafeInteger(x)?x:typeof x==='string'&&/^\d+$/.test(x)&&Number.isSafeInteger(Number(x))?Number(x):NaN;
  const start=decimal(c.start_time),end=decimal(c.expired_time),now=Math.floor(Date.now()/1000);
  check(start<end&&start<=now+30&&end-now>=360,'invalid_cos_credential_times');
  for(const k of ['secret_id','secret_key','token'])check(typeof c[k]==='string'&&c[k]&&!/[\x00-\x20\x7f-\uffff]/.test(c[k]),'invalid_cos_credential');
  check(![this.env.IMA_OPENAPI_CLIENTID,this.env.IMA_OPENAPI_APIKEY].filter(Boolean).some(s=>['secret_id','secret_key','token','bucket_name','region','cos_key'].some(k=>c[k].includes(s))),'ima_credential_in_cos_target');
  const path='/'+c.cos_key.split('/').map(encodeURIComponent).join('/'),keyTime=`${start};${end}`;
  const hmac=async(key,s)=>{const k=await crypto.subtle.importKey('raw',enc.encode(key),{name:'HMAC',hash:'SHA-1'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',k,enc.encode(s)));};
  const http=`put\n${path}\n\ncontent-length=${encodeURIComponent(String(spec.size))}&host=${encodeURIComponent(host)}\n`;
  const signKey=await hmac(c.secret_key,keyTime),signature=await hmac(signKey,`sha1\n${keyTime}\n${hex(await crypto.subtle.digest('SHA-1',enc.encode(http)))}\n`);
  const authorization=`q-sign-algorithm=sha1&q-ak=${c.secret_id}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=content-length;host&q-url-param-list=&q-signature=${signature}`;
  const obj=await get();check(obj&&obj.size===spec.size,'blob_changed');const checked=measured(obj.body,{size:spec.size,sha256:this.receipt.input_sha256});
  await this.stage('cos_put','before');this.dispatched=true;
  const transfer=lengthBody(checked.stream,spec.size);
  try{
   const res=await this.request(`https://${host}${path}`,{method:'PUT',headers:{'content-type':spec.contentType,'content-length':String(spec.size),'authorization':authorization,'x-cos-security-token':c.token},body:transfer.body,duplex:'half'},300000);
   await res.body?.cancel().catch(()=>{});await transfer.finished;check(checked.done,'upload_stream_incomplete');
  }catch(e){await transfer.abort();throw e;}
  await this.stage('cos_put','recorded');
  const added=await this.wiki('add_knowledge',{knowledge_base_id:q.kb_id,media_type:spec.type,media_id:mid,title:spec.name,file_info:{cos_key:c.cos_key,file_size:spec.size,last_modify_time:now,file_name:spec.name},...(q.folder_id?{folder_id:q.folder_id}:{})},true);
  check(id(added,'media_id')===mid,'added_media_id_mismatch');this.receipt.orphaned_media=false;await this.stage('add_knowledge','recorded');
 }
 async kbWrite(){
  const q=this.q,a=q.action;
  let file;if(['file.upload','text.create'].includes(a))file=await this.inspectFile();
  if(a==='note.associate'){check(!q.folder_id,'note_folder_association_not_verified','invalid_input');need(q,'note_id');need(q,'title');}
  if(a==='url.import'){check(Array.isArray(q.urls)&&q.urls.length>=1&&q.urls.length<=10,'urls_must_have_1_to_10_items','invalid_input');q.urls.forEach(publicUrl);check(new Set(q.urls).size===q.urls.length,'duplicate_urls','invalid_input');}
  if(['kb.create','folder.create'].includes(a))check(need(q,'name').length<=200,'name_too_long','invalid_input');
  if(a!=='kb.create'&&a!=='media.export')this.resource.kb_id=need(q,'kb_id');
  if(q.folder_id)this.resource.folder_id=q.folder_id;
  if(['kb.create','folder.create'].includes(a))this.resource.name=q.name;
  if(!q.execute)return this.result('preview');
  if(a==='media.export'){need(q,'media_id');return this.result('succeeded',await this.download(q.media_id,true));}
  if(a==='kb.create'){
   const bases=await this.pages('search_knowledge_base',{query:q.name,limit:20},'info_list');check(!bases.some(x=>(x.name||x.kb_name)===q.name),'same_name_kb_exists','conflict');
   const d=await this.wiki('create_knowledge_base',{type:'KBT_MINE_KB',name:q.name},true);this.resource.kb_id=id(d,'id');await this.stage('create_knowledge_base','recorded');
  }else{
   await this.kbGet(q.kb_id);
   if(a==='folder.create'){
    const items=await this.browse(q.kb_id,q.folder_id);check(!items.some(x=>x.kind==='folder'&&x.title===q.name),'same_name_folder_exists','conflict');
    this.resource.parent_folder_id=q.folder_id||null;
    const d=await this.wiki('create_folder',{knowledge_base_id:q.kb_id,name:q.name,...(q.folder_id?{folder_id:q.folder_id}:{})},true);this.resource.folder_id=id(d,'media_id');await this.stage('create_folder','recorded');
   }else if(a==='note.associate'){
    await this.getNote(q.note_id,q.title);this.resource.note_id=q.note_id;
    const d=await this.wiki('add_knowledge',{knowledge_base_id:q.kb_id,media_type:11,title:q.title,note_info:{content_id:q.note_id}},true);this.resource.media_ids=[id(d,'media_id')];await this.stage('add_knowledge','recorded');
   }else if(a==='url.import'){
    this.receipt.expected_media_count=q.urls.length;
    const d=await this.wiki('import_urls',{knowledge_base_id:q.kb_id,folder_id:q.folder_id||q.kb_id,urls:q.urls},true);
    check(object(d.results),'invalid_import_results');this.resource.media_ids=[];let failed=false;
    for(const u of q.urls){const item=d.results[u];if(object(item)&&typeof item.media_id==='string'&&item.media_id)this.resource.media_ids.push(item.media_id);if(!object(item)||item.ret_code!==0||!item.media_id)failed=true;}
    this.resource.media_ids=[...new Set(this.resource.media_ids)];this.receipt.import_failed=failed;await this.stage('import_urls','recorded');
    if(failed)return this.result(this.resource.media_ids.length?'verification_pending':'failed',undefined,'partial_url_import');
   }else await this.upload(file);
  }
  return this.verify();
 }
 async run(){
  const q=this.q;check(object(q),'request_must_be_object','invalid_input');check(['notes','kb'].includes(this.domain),'unsupported_domain','unsupported');
  for(const k of ['execute','reconcile','include_deleted'])if(k in q)check(typeof q[k]==='boolean',k+'_must_be_boolean','invalid_input');
  const reads=this.domain==='notes'?READ_NOTES:READ_KB,writes=this.domain==='notes'?WRITE_NOTES:WRITE_KB;
  check(reads.has(q.action)||writes.has(q.action),'unsupported_action','unsupported');
  if(q.reconcile){
   // Never derive resource IDs from q. A failed/partial stage may have no ID.
   const r=this.resource;const hasId=this.domain==='notes'?r.note_id:q.action==='kb.create'?r.kb_id:q.action==='folder.create'?r.folder_id:q.action==='media.export'?r.blob_id:r.media_ids?.length;
   if(!hasId)return this.result('unknown',undefined,'no_recorded_resource_id');return this.verify();
  }
  this.validate();
  if(reads.has(q.action))return this.read();
  need(q,'request_id');check(q.request_id.length<=200,'request_id_too_long','invalid_input');
  if(this.domain==='notes'&&['create','append'].includes(q.action)){need(q,'content');check(enc.encode(q.content).length<=10*MiB,'content_limit_10MiB','invalid_input');}
  // A stage already persisted by a prior invocation is never dispatched again.
  if(q.execute&&Object.keys(this.receipt.stages).length)return this.result('unknown',undefined,'existing_stages_require_reconcile');
  return this.domain==='notes'?this.notesWrite():this.kbWrite();
 }
 validate(){
  const q=this.q,a=q.action;
  // q.file is opaque legacy fingerprint metadata: never resolve/open/fetch it.
  for(const k of ['file','blob_id','filename','content_type','kb_id','note_id','media_id','title','expected_title','name','folder_id','title_hint','cursor','version','query','content']){
   if(k in q)check(typeof q[k]==='string'&&q[k].isWellFormed(),k+'_must_be_valid_string','invalid_input');
  }
  for(const k of ['kb_id','note_id','media_id','blob_id'])if(k in q)need(q,k);
  for(const k of ['expected_content_sha256','before_content_sha256','sha256'])if(k in q)check(typeof q[k]==='string'&&/^[a-f0-9]{64}$/.test(q[k]),k+'_must_be_sha256','invalid_input');
  if(this.domain==='notes'){
   if(a==='search'&&'search_type' in q)check(q.search_type===0||q.search_type===1,'search_type_must_be_0_or_1','invalid_input');
   if(!['create','list','search','list_notebooks','notebook.list'].includes(a))need(q,'note_id');
   if(WRITE_NOTES.has(a)&&a!=='create')check(typeof q.expected_title==='string','expected_title_required','invalid_input');
   if(a==='rename')check(need(q,'title').length<=500&&!q.title.startsWith(PREFIX),'invalid_target_title','invalid_input');
   if(q.folder_id==='0')throw new Fault('invalid_folder_id','invalid_input');
  }else{
   if(a.startsWith('media.'))need(q,'media_id');
   if(!['kb.list','kb.addable','kb.create','media.info','media.read','media.export'].includes(a))need(q,'kb_id');
   if(['kb.create','folder.create'].includes(a))check(need(q,'name').length<=200,'name_too_long','invalid_input');
   if(a==='note.associate'){need(q,'note_id');need(q,'title');check(!q.folder_id,'note_folder_association_not_verified','invalid_input');}
   if(['file.upload','text.create'].includes(a))need(q,'filename');
   if(a==='file.upload')need(q,'blob_id');
   if(a==='text.create')need(q,'content');
   if(a==='knowledge.search')need(q,'query');
  }
 }
}

/** Parent owns stable request IDs, fingerprint checks, the ledger, and locks.
 * onStage receives {status,stage,resource,receipt:{stages,...hashes}}; persist it
 * atomically before resolving. blobs is private R2 get/put, never a local path.
 * Reconcile accepts state.resource/state.receipt (also serialized local receipt).
 */
export async function invokeIma(domain,q,ctx={}){
 let t;try{t=new Transport(domain,q,ctx);return await t.run();}
 catch(e){const status=t?.dispatched?'unknown':e instanceof Fault?e.status:'unavailable';return t?t.result(status,undefined,e instanceof Fault?e.message:'transport_or_stage_error'):{status:'invalid_input',message:'invalid_context'};}
}
