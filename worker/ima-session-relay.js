import {sha256,stable,withShortLease} from './storage.js';
import {sessionAction} from './ima-session.js';

const encoder=new TextEncoder();
const root=ctx=>ctx.baseStore||ctx.store;
const bad=()=>Object.assign(Error('sealed_session_invalid'),{status:'invalid_input'});
const enc64=bytes=>{let s='';for(const b of new Uint8Array(bytes))s+=String.fromCharCode(b);return btoa(s);};
function dec64(s,max){
 if(typeof s!=='string'||s.length>max||s.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(s))throw bad();
 let b;try{b=Uint8Array.from(atob(s),c=>c.charCodeAt(0));}catch{throw bad();}
 if(enc64(b)!==s)throw bad();return b;
}
async function configuration(ctx){
 try{
  const bytes=dec64(ctx.env.IMA_SESSION_ENCRYPTION_KEY,64);if(bytes.length!==32||!ctx.env.IMA_OPENAPI_CLIENTID)throw bad();
  return {account:await sha256(ctx.env.IMA_OPENAPI_CLIENTID),master:await crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt'])};
 }catch{throw Object.assign(Error('native_session_encryption_configuration_required'),{status:'blocked'});}
}
const keyAad=(config,keyId)=>encoder.encode('ima-native-login-key-v1:'+config.account+':'+keyId);
async function readKey(store,config){
 const row=await store.get('private_ima_relay_keys',config.account);if(!row)throw bad();
 if(row.version!==1||!/^\w{64}$/.test(row.key_id||''))throw bad();
 const spki=dec64(row.public_key_spki,1024);if(await sha256(spki)!==row.key_id)throw bad();
 const iv=dec64(row.iv,24);if(iv.length!==12)throw bad();
 const raw=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:keyAad(config,row.key_id)},config.master,dec64(row.private_key_ciphertext,8192));
 const jwk=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
 const privateKey=await crypto.subtle.importKey('jwk',jwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['decrypt']);
 return {row,privateKey};
}
async function getKey(ctx,config,create){
 if(!create)return readKey(root(ctx),config);
 return withShortLease({...ctx,baseStore:root(ctx),store:root(ctx),workspace:'global'},'governance:ima-relay-key:'+config.account,async lease=>{
  const existing=await lease.store.get('private_ima_relay_keys',config.account);
  if(!existing){
   const pair=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
   const spki=await crypto.subtle.exportKey('spki',pair.publicKey),key_id=await sha256(spki),iv=crypto.getRandomValues(new Uint8Array(12));
   const privateJwk=await crypto.subtle.exportKey('jwk',pair.privateKey);
   const sealed=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:keyAad(config,key_id)},config.master,encoder.encode(JSON.stringify(privateJwk)));
   await lease.store.put('private_ima_relay_keys',config.account,{version:1,key_id,public_key_spki:enc64(spki),iv:enc64(iv),private_key_ciphertext:enc64(sealed),created_at:new Date().toISOString()});
  }
  return readKey(lease.store,config);
 });
}
export async function authorizationKey(ctx){
 try{
  const config=await configuration(ctx),{row}=await getKey(ctx,config,true);
  return {status:'succeeded',authorization_key:{key_id:row.key_id,public_key_spki:row.public_key_spki,algorithm:'RSA-OAEP-SHA256+A256GCM'},instructions:'仅供本次独立官方扫码安装器密封新会话。不得在聊天或工具参数中提交明文token；密封包须在10分钟内完成接入。登录接入不代表移动已验收。'};
 }catch(error){return {status:error.status==='blocked'?'blocked':'unavailable',message:error.status==='blocked'?error.message:'authorization_key_unavailable'};}
}
export async function finishAuthorization(envelope,ctx){
 try{
  const allowed=['installation_id','issued_at','key_id','wrapped_key','iv','ciphertext'];
  if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||Object.keys(envelope).some(k=>!allowed.includes(k)))throw bad();
  const {installation_id,issued_at,key_id}=envelope;
  if(!/^\w[\w-]{15,99}$/.test(installation_id||'')||!/^[a-f0-9]{64}$/.test(key_id||'')||typeof issued_at!=='string')throw bad();
  const age=Date.now()-Date.parse(issued_at);if(!Number.isFinite(age)||age>600000||age< -120000)throw bad();
  const config=await configuration(ctx),{row,privateKey}=await getKey(ctx,config,false);if(row.key_id!==key_id)throw bad();
  const wrapped=dec64(envelope.wrapped_key,512),iv=dec64(envelope.iv,24),ciphertext=dec64(envelope.ciphertext,140000);
  if(wrapped.length!==256||iv.length!==12||ciphertext.length<16)throw bad();
  const rawKey=await crypto.subtle.decrypt('RSA-OAEP',privateKey,wrapped);if(rawKey.byteLength!==32)throw bad();
  const aes=await crypto.subtle.importKey('raw',rawKey,'AES-GCM',false,['decrypt']);
  const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode(stable({installation_id,issued_at,key_id}))},aes,ciphertext);
  const d=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));
  if(!d||typeof d!=='object'||Array.isArray(d)||Object.keys(d).some(k=>!['account_info','device_info'].includes(k)))throw bad();
  return sessionAction('install',{installation_id,account_info:d.account_info,device_info:d.device_info||{}},ctx);
 }catch(error){return {status:error.status==='blocked'?'blocked':'invalid_input',message:error.status==='blocked'?error.message:'sealed_session_invalid_or_expired'};}
}
