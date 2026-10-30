import {sha256,stable,withShortLease} from './storage.js';
import {saveNativeSession,loadNativeSession,nativeSessionStatus,forgetNativeSession,updateNativeSession} from './ima-session-vault.js';

const root=ctx=>ctx.baseStore||ctx.store;
const accountKey=ctx=>sha256(ctx.env.IMA_OPENAPI_CLIENTID||'');
const fail=(status,message)=>Object.assign(Error(message),{status});
const ttl=(value,label)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<=0||n>366*86400)throw fail('unavailable',label);return n*1000;};

export function nativeBkn(token){let h=5381;for(let i=0;i<token.length;i++)h=(h*33+token.charCodeAt(i))>>>0;return String(h&0x7fffffff);}
export function nativeHeaders(current){
 const a=current.account_info,d=current.device_info||{};
 const fields={PLATFORM:'H5','CLIENT-TYPE':'256054','WEB-VERSION':d.version||'999.999.999',
  'IMA-GUID':d.guid||a.guid||'','IMA-Q36':d.q36||'','IMA-IUA':(d.qua||'').replaceAll(';',','),
  'IMA-UID':a.userId,'IMA-TOKEN':a.token,'IMA-REFRESH-TOKEN':a.refreshToken,'UID-TYPE':String(a.idType??2),'TOKEN-TYPE':String(a.tokenType??14)};
 if(Object.values(fields).some(v=>typeof v!=='string'||/[;\r\n\0]/.test(v)))throw fail('invalid_input','invalid_session_header');
 return {'content-type':'application/json; charset=utf-8','from_browser_ima':'1',extension_version:'999.999.999',
  'x-ima-cookie':Object.entries(fields).map(([k,v])=>k+'='+v).join('; '),'x-ima-bkn':nativeBkn(a.token)};
}

async function connectionStatus(ctx){
 const result=await nativeSessionStatus(ctx);
 if(result.status!=='succeeded'||!result.session)return result;
 const check=await root(ctx).get('private_ima_session_checks',await accountKey(ctx));
 const current=check?.revision===result.session.revision;
 const authenticated=result.session.state==='received'&&current&&check.authenticated===true;
 const proof=authenticated?await (await import('./moves.js')).moveConnectionProof(ctx,await loadNativeSession(ctx)):{account_bound:false,move_verified:false};
 const connection_state=authenticated?(proof.account_bound?(proof.move_verified?'move_ready':'authenticated_bound'):'authenticated_unbound'):result.session.state;
 return {...result,session:{...result.session,authenticated,...proof,
  ...(current&&check.reauthorization_required?{reauthorization_required:true}:{}),
  connection_state,...(authenticated?{checked_at:check.checked_at}:{})}};
}

export async function sessionAction(action,q,ctx){
 try{
  if(action==='status')return connectionStatus(ctx);
  if(action==='install'){
   if(!q||Object.keys(q).some(k=>!['account_info','device_info','installation_id'].includes(k))||!/^\w[\w-]{15,99}$/.test(q.installation_id||''))return {status:'invalid_input',message:'fresh_session_and_stable_installation_id_required'};
   const key=await accountKey(ctx),fingerprint=await sha256(stable({account_info:q.account_info,device_info:q.device_info||{}}));
   return withShortLease({...ctx,store:root(ctx),baseStore:root(ctx),workspace:'global'},'governance:ima-session-install:'+key,async lease=>{
    const previous=await lease.store.get('private_ima_session_installs',q.installation_id);
    if(previous?.fingerprint!==undefined&&previous.fingerprint!==fingerprint)return {status:'conflict',message:'installation_id_reused'};
    if(previous?.state==='completed')return {...await connectionStatus(ctx),replayed:true};
    if(previous?.state==='pending')return {...await connectionStatus(ctx),status:'verification_pending',message:'session_installation_requires_original_receipt_check'};
    const reservation={fingerprint,state:'pending',created_at:new Date().toISOString()};
    await lease.store.put('private_ima_session_installs',q.installation_id,reservation);
    const result=await saveNativeSession(ctx,q.account_info,q.device_info||{});
    if(result.status==='succeeded')await lease.store.put('private_ima_session_installs',q.installation_id,{...reservation,state:'completed'});
    else if(['invalid_input','blocked','conflict'].includes(result.status))await lease.store.put('private_ima_session_installs',q.installation_id,{...reservation,state:'not_written'});
    if(result.status!=='succeeded')return result;
    return connectionStatus(ctx);
   });
  }
  if(action==='revoke'){
   const result=await forgetNativeSession(ctx);
   if(result.status==='succeeded')await root(ctx).remove('private_ima_session_checks',await accountKey(ctx));
   return result;
  }
  if(action==='verify'){
   const before=await loadNativeSession(ctx);
   if(!before?.account_info)return before?.session?connectionStatus(ctx):before;
   let authenticationRejected=false;
   try{
    const updated=await updateNativeSession(ctx,async current=>{
     const a=current.account_info,headers=nativeHeaders(current);
     const fetcher=ctx.sessionFetcher||globalThis.fetch;
     // A refresh validates the new login without reading or mutating knowledge.
     // Never retry it automatically: some providers rotate refresh tokens.
     let response;
     try{response=await fetcher('https://ima.qq.com/cgi-bin/auth_login/refresh',{method:'POST',headers,
      body:JSON.stringify({user_id:a.userId,refresh_token:a.refreshToken,token_type:a.tokenType??14}),redirect:'manual',signal:AbortSignal.timeout(20000)});}
     catch{throw fail('unavailable','ima_session_network_unavailable');}
     if(response.status===401||response.status===403){authenticationRejected=true;await response.body?.cancel();throw fail('unavailable','ima_reauthorization_required');}
     if(!response.ok){await response.body?.cancel();throw fail('unavailable','ima_session_provider_unavailable');}
     if(Number(response.headers.get('content-length')||0)>65536){await response.body?.cancel();throw fail('unavailable','ima_session_invalid_response');}
     const reader=response.body?.getReader();if(!reader)throw fail('unavailable','ima_session_invalid_response');
     const chunks=[];let size=0;
     try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536){await reader.cancel();throw fail('unavailable','ima_session_invalid_response');}chunks.push(value);}}
     finally{reader.releaseLock();}
     const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
     let d;try{d=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('unavailable','ima_session_invalid_response');}
     if(!d||d.code!==0){authenticationRejected=[600001,600002,600003,41,110031].includes(d?.code);throw fail('unavailable',authenticationRejected?'ima_reauthorization_required':'ima_session_provider_rejected');}
     const data=d.data&&typeof d.data==='object'?d.data:d;
     if(typeof data.token!=='string'||!data.token||data.token.length>32768)throw fail('unavailable','ima_session_invalid_response');
     const next={...a,token:data.token,tokenExpiredTime:Date.now()+ttl(data.token_valid_time,'ima_session_missing_expiry')};
     if(data.refresh_token!==undefined){
      if(typeof data.refresh_token!=='string'||!data.refresh_token)throw fail('unavailable','ima_session_invalid_response');
      next.refreshToken=data.refresh_token;
     }
     if(data.refresh_token_valid_time!==undefined)next.refreshTokenExpiredTime=Date.now()+ttl(data.refresh_token_valid_time,'ima_session_invalid_refresh_expiry');
     return {account_info:next,device_info:current.device_info};
    });
    if(updated.status!=='succeeded'){
     if(authenticationRejected)await root(ctx).put('private_ima_session_checks',await accountKey(ctx),{revision:before.revision,authenticated:false,reauthorization_required:true,checked_at:new Date().toISOString()});
     return {...await connectionStatus(ctx),status:updated.status,message:authenticationRejected?'ima_reauthorization_required':updated.message||'ima_session_unavailable'};
    }
    await root(ctx).put('private_ima_session_checks',await accountKey(ctx),{revision:updated.session.revision,authenticated:true,checked_at:new Date().toISOString()});
    return connectionStatus(ctx);
   }catch(error){
    if(authenticationRejected)await root(ctx).put('private_ima_session_checks',await accountKey(ctx),{revision:before.revision,authenticated:false,reauthorization_required:true,checked_at:new Date().toISOString()});
    return {...await connectionStatus(ctx),status:error.status||'unavailable',message:error.message?.startsWith('ima_')?error.message:'ima_session_unavailable'};
   }
  }
  return {status:'unsupported'};
 }catch(error){return {status:error.status||'unavailable',message:['invalid_input','blocked','conflict'].includes(error.status)?error.message:'ima_session_unavailable'};}
}
