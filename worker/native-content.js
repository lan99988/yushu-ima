import {nativeHeaders,sessionAction} from './ima-session.js';
import {loadNativeSession} from './ima-session-vault.js';
import {sha256,stable} from './storage.js';

export async function readTextOriginal(ctx,media_id){
 const need=(ok,msg,status='verification_pending')=>{if(!ok)throw Object.assign(Error(msg),{status});};
 const r=await ctx.invoke('kb',{action:'media.read',media_id});need(r.status==='succeeded','ima_content_original_unreadable');const d=r.data||{};let bytes;
 need(Number.isSafeInteger(d.size)&&d.size>0&&d.size<=1048576,'ima_content_requires_utf8_text_up_to_1MiB','invalid_input');
 if(typeof d.content==='string')bytes=new TextEncoder().encode(d.content);
 else if(d.blob_id){const blob=await ctx.blobs.get(d.blob_id);need(blob&&blob.size===d.size,'ima_content_original_blob_missing');bytes=new Uint8Array(await blob.arrayBuffer());}
 need(bytes&&bytes.length===d.size&&await sha256(bytes)===d.sha256,'ima_content_original_byte_hash_mismatch');let content;
 try{content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{need(false,'ima_content_requires_utf8_text','invalid_input');}
 return {content,bytes,sha256:d.sha256,size:d.size};
}

const READS={knowledge:'/cgi-bin/knowledge_tab_reader/get_knowledge',media:'/cgi-bin/file_manager/get_media',credential:'/cgi-bin/file_manager/get_upload_credential_by_media'};
export async function nativeContentRead(ctx,current,operation,body){
 if(!Object.hasOwn(READS,operation))throw Error('native_content_read_operation_required');
 return nativeJson(ctx,current,READS[operation],body);
}
export async function nativeDeleteKnowledge(ctx,current,kb_id,media_id){
 return nativeJson(ctx,current,'/cgi-bin/knowledge_tab_writer/del_knowledge',{knowledge_base_id:kb_id,media_ids:[media_id]});
}
async function nativeJson(ctx,current,path,body){
 try{
  const fetcher=ctx.nativeFetcher||globalThis.fetch.bind(globalThis);
  const r=await fetcher('https://ima.qq.com'+path,{method:'POST',headers:nativeHeaders(current),body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(20000)});
  if(!r.ok||r.redirected){await r.body?.cancel();return {status:'unavailable',http:r.status};}
  const reader=r.body?.getReader();if(!reader)return {status:'unavailable'};let size=0;const chunks=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576){await reader.cancel();return {status:'unavailable'};}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
  const d=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!d||typeof d!=='object'||Array.isArray(d)||!Number.isSafeInteger(d.code))return {status:'unavailable'};
  const layers=[d];let next=d.data;
  while(next!==undefined){if(!next||typeof next!=='object'||Array.isArray(next)||layers.length>=4)return {status:'unavailable'};if(Object.hasOwn(next,'code')&&(!Number.isSafeInteger(next.code)||next.code!==d.code))return {status:'unavailable'};layers.push(next);next=next.data;}
  const results=layers.filter(x=>Object.hasOwn(x,'results')).map(x=>stable(x.results));if(new Set(results).size>1)return {status:'unavailable'};
  if(d.code!==0)return {status:'rejected',provider_code:d.code};
  return {status:'succeeded',data:Object.assign({},...layers)};
 }catch{return {status:'unavailable'};}
}
function cosKeys(value,depth=0){if(depth>8||!value||typeof value!=='object')return [];return Object.entries(value).flatMap(([key,item])=>key==='cos_key'&&typeof item==='string'?[item]:cosKeys(item,depth+1));}
function keys(value){return value&&typeof value==='object'?Object.keys(value).slice(0,50):[];}
export async function inspectContentProtocol(ctx,current,kb_id,media_id){
 const k=await nativeContentRead(ctx,current,'knowledge',{knowledge_base_id:kb_id,media_id});
 if(k.status!=='succeeded'||k.data?.knowledge?.media_id!==media_id)return {status:'blocked',read_only:true,message:'native_content_identity_unverified',knowledge:{status:k.status,provider_code:k.provider_code,keys:keys(k.data)}};
 const m=await nativeContentRead(ctx,current,'media',{media_id}),c=await nativeContentRead(ctx,current,'credential',{media_id});
 const knowledge=k.data?.knowledge,credential=c.data?.cos_credential,objectKeys=[...cosKeys(knowledge),...cosKeys(m.data)];
 return {status:'succeeded',read_only:true,knowledge:{status:k.status,provider_code:k.provider_code,keys:keys(knowledge),media_id:knowledge?.media_id,title:knowledge?.title,parent_folder_id:knowledge?.parent_folder_id,media_type:knowledge?.media_type,file_info_keys:keys(knowledge?.file_info)},media:{status:m.status,provider_code:m.provider_code,keys:keys(m.data),media_keys:keys(m.data?.media)},credential:{status:c.status,provider_code:c.provider_code,http:c.http,keys:keys(c.data),credential_keys:keys(credential)},upload_credential_available:!!(credential?.secret_id&&credential?.secret_key&&credential?.token),same_original_object:!!(credential?.cos_key&&objectKeys.includes(credential.cos_key)),...(credential?.cos_key?{credential_object_sha256:await sha256(credential.cos_key)}:{})};
}
// Read-only protocol inspection is included in metadata for the existing,
// explicitly authorized isolation fixture. Never query or return credentials
// for an unrelated library or unbound native account.
export async function isolatedContentInspection(ctx,media_id){
 const account=await sha256(ctx.env.IMA_OPENAPI_CLIENTID||''),base=ctx.baseStore||ctx.store;
 const binding=await base.get('native_move_bindings',account+':isolated');if(!binding||!media_id.endsWith(binding.native_knowledge_base_id))return null;
 let state=await sessionAction('status',{},ctx);if(state.session?.refresh_required&&!state.session.reauthorization_required)state=await sessionAction('verify',{},ctx);
 if(!state.session?.authenticated)return {status:'blocked',message:'native_login_required'};
 const current=await loadNativeSession(ctx);if(!current?.account_info||binding.native_user_sha256!==await sha256(current.account_info.userId))return {status:'blocked',message:'native_account_mismatch'};
 const result=await inspectContentProtocol(ctx,current,binding.native_knowledge_base_id,media_id);
 return result;
}
