import test from 'node:test';import assert from 'node:assert/strict';
import {context} from '../worker/app.js';import {runtime} from './fixtures/runtime.mjs';
import {loadNativeSession} from '../worker/ima-session-vault.js';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
let relay={};try{relay=await import('../worker/ima-session-relay.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}
const b64=bytes=>Buffer.from(bytes).toString('base64');
const un64=s=>new Uint8Array(Buffer.from(s,'base64'));
function fixture(){const env={...runtime(),IMA_SESSION_ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64')};return {env,ctx:context(env)};}
const account=()=>({userId:'fresh-relay-user',token:'relay-access-secret',refreshToken:'relay-refresh-secret',idType:2,tokenType:14,tokenExpiredTime:Date.now()+3600000,refreshTokenExpiredTime:Date.now()+86400000});
async function seal(key,changes={}){
 const metadata={installation_id:'relay-login-run-00000001',issued_at:new Date().toISOString(),key_id:key.key_id,...changes};
 const publicKey=await crypto.subtle.importKey('spki',un64(key.public_key_spki),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
 const aesBytes=crypto.getRandomValues(new Uint8Array(32)),aes=await crypto.subtle.importKey('raw',aesBytes,'AES-GCM',false,['encrypt']),iv=crypto.getRandomValues(new Uint8Array(12));
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(JSON.stringify(metadata))},aes,new TextEncoder().encode(JSON.stringify({account_info:account(),device_info:{qua:'fresh browser'}})));
 return {...metadata,wrapped_key:b64(await crypto.subtle.encrypt('RSA-OAEP',publicKey,aesBytes)),iv:b64(iv),ciphertext:b64(ciphertext)};
}
test('authorization relay exports its public-key and sealed-finish operations',()=>{assert.equal(typeof relay.authorizationKey,'function');assert.equal(typeof relay.finishAuthorization,'function');});
test('public authorization key is stable and raw session material does not pass through the relay',async()=>{
 const {env,ctx}=fixture();const a=await relay.authorizationKey(ctx),b=await relay.authorizationKey(ctx);
 assert.equal(a.status,'succeeded');assert.deepEqual(a.authorization_key,b.authorization_key);
 const sealed=await seal(a.authorization_key);assert.ok(!JSON.stringify(sealed).includes('relay-access-secret'));
 const result=await relay.finishAuthorization(sealed,ctx);assert.equal(result.status,'succeeded');assert.equal(result.session.move_verified,false);
 assert.equal((await loadNativeSession(ctx)).account_info.token,'relay-access-secret');
 const output=JSON.stringify(result),db=JSON.stringify((await env.DB.prepare('SELECT * FROM documents').all()).results);
 for(const secret of ['fresh-relay-user','relay-access-secret','relay-refresh-secret']){assert.ok(!output.includes(secret));assert.ok(!db.includes(secret));}
 assert.equal((await relay.finishAuthorization(sealed,ctx)).replayed,true);env.close();
});
test('tampered metadata, stale envelopes and unrecognized server keys cannot install sessions',async()=>{
 for(const change of ['aad','stale','key','cipher']){
  const {env,ctx}=fixture(),key=(await relay.authorizationKey(ctx)).authorization_key;
  const e=await seal(key,change==='stale'?{issued_at:new Date(Date.now()-3600000).toISOString()}:{});
  if(change==='aad')e.installation_id='different-login-run-00000001';
  if(change==='key')e.key_id='0'.repeat(64);
  if(change==='cipher')e.ciphertext=b64(new Uint8Array(40));
  const result=await relay.finishAuthorization(e,ctx);assert.notEqual(result.status,'succeeded');
  assert.equal((await loadNativeSession(ctx)).session.state,'missing');env.close();
 }
});
test('missing at-rest key blocks key generation and credential intake',async()=>{
 const {env,ctx}=fixture();delete env.IMA_SESSION_ENCRYPTION_KEY;
 assert.equal((await relay.authorizationKey(ctx)).status,'blocked');
 assert.notEqual((await relay.finishAuthorization({},ctx)).status,'succeeded');env.close();
});

test('the actual local Node sealer interoperates with the Worker cryptography and intake',async()=>{
 const {env,ctx}=fixture(),key=(await relay.authorizationKey(ctx)).authorization_key;
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/seal-ima-session.mjs',import.meta.url))],{
  input:JSON.stringify({key,installation_id:'e'.repeat(32),account_info:account(),device_info:{qua:'fresh browser'}}),encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0);const envelope=JSON.parse(result.stdout);
 const installed=await relay.finishAuthorization(envelope,ctx);assert.equal(installed.status,'succeeded');
 assert.equal((await loadNativeSession(ctx)).account_info.userId,'fresh-relay-user');env.close();
});
