import test from 'node:test';
import assert from 'node:assert/strict';
import {context} from '../worker/app.js';
import {runtime} from './fixtures/runtime.mjs';
import {sessionAction,nativeBkn,nativeHeaders} from '../worker/ima-session.js';
import {loadNativeSession} from '../worker/ima-session-vault.js';

function fixture(){const e={...runtime(),IMA_SESSION_ENCRYPTION_KEY:Buffer.alloc(32,4).toString('base64')};return {e,ctx:context(e)};}
const info=()=>({userId:'official-login-user',token:'old-access',refreshToken:'old-refresh',idType:2,tokenType:14,tokenExpiredTime:Date.now()+3600000,refreshTokenExpiredTime:Date.now()+86400000});
const install=ctx=>sessionAction('install',{installation_id:'synthetic-installation-0001',account_info:info()},ctx);

test('verification without a session performs no provider call and never authenticates missing state',async()=>{
 const {e,ctx}=fixture();let calls=0;ctx.sessionFetcher=async()=>{calls++;throw Error('should not fetch');};
 const d=await sessionAction('verify',{},ctx);assert.equal(d.session.state,'missing');assert.equal(d.session.authenticated,false);assert.equal(calls,0);e.close();
});

test('refresh serializes actual token exchange, persists rotations, and recalculates bkn',async()=>{
 const {e,ctx}=fixture();await install(ctx);let calls=0;
 ctx.sessionFetcher=async(url,options)=>{
  calls++;assert.equal(url,'https://ima.qq.com/cgi-bin/auth_login/refresh');assert.equal(options.redirect,'manual');
  assert.deepEqual(JSON.parse(options.body),{user_id:'official-login-user',refresh_token:'old-refresh',token_type:14});
  assert.equal(options.headers['x-ima-bkn'],nativeBkn('old-access'));
  return Response.json({code:0,token:'new-access',refresh_token:'new-refresh',token_valid_time:'7200',refresh_token_valid_time:'172800'});
 };
 const d=await sessionAction('verify',{},ctx);
 assert.equal(d.status,'succeeded');assert.equal(d.session.authenticated,true);assert.equal(d.session.account_bound,false);assert.equal(d.session.move_verified,false);assert.equal(calls,1);
 assert.equal(d.session.connection_state,'authenticated_unbound');
 const saved=await loadNativeSession(ctx);assert.equal(saved.account_info.refreshToken,'new-refresh');
 assert.equal(nativeHeaders(saved)['x-ima-bkn'],nativeBkn('new-access'));
 const output=JSON.stringify(d);for(const s of ['new-access','new-refresh','official-login-user'])assert.ok(!output.includes(s));e.close();
});

test('expired login is surfaced as reauthorization and is not retried',async()=>{
 const {e,ctx}=fixture();await install(ctx);let calls=0;
 ctx.sessionFetcher=async()=>{calls++;return Response.json({code:600001,msg:'old-refresh secret upstream message'});};
 const d=await sessionAction('verify',{},ctx);
 assert.equal(d.status,'unavailable');assert.equal(calls,1);assert.equal(d.session.authenticated,false);assert.equal(d.session.reauthorization_required,true);
 assert.ok(!JSON.stringify(d).includes('old-refresh'));e.close();
});

test('redirects and malformed expiry never mark a session authenticated or echo provider bodies',async()=>{
 for(const response of [new Response(null,{status:302,headers:{location:'https://attacker.invalid/'}}),Response.json({code:0,token:'provider-secret-without-expiry'})]){
  const {e,ctx}=fixture();await install(ctx);let calls=0;ctx.sessionFetcher=async()=>{calls++;return response;};
  const d=await sessionAction('verify',{},ctx);assert.equal(d.status,'unavailable');assert.equal(d.session.authenticated,false);assert.equal(calls,1);assert.ok(!JSON.stringify(d).includes('provider-secret'));e.close();
 }
});

test('cookie construction rejects header injection and uses the official userId, not an open-id alias',()=>{
 const current={account_info:{...info(),uid:'different-open-id'},device_info:{qua:'Browser; Windows'}};
 const headers=nativeHeaders(current);assert.ok(headers['x-ima-cookie'].includes('IMA-UID=official-login-user'));assert.ok(!headers['x-ima-cookie'].includes('different-open-id'));
 assert.throws(()=>nativeHeaders({...current,account_info:{...current.account_info,token:'bad; IMA-UID=injected'}}));
});

test('replayed installation cannot replace a refreshed token with its old captured value',async()=>{
 const {e,ctx}=fixture(),account_info=info(),q={installation_id:'same-fresh-login-run-0001',account_info};
 assert.equal((await sessionAction('install',q,ctx)).status,'succeeded');
 ctx.sessionFetcher=async()=>Response.json({code:0,token:'rotated-access',refresh_token:'rotated-refresh',token_valid_time:'7200'});
 assert.equal((await sessionAction('verify',{},ctx)).status,'succeeded');
 const replay=await sessionAction('install',q,ctx);assert.equal(replay.replayed,true);
 assert.equal((await loadNativeSession(ctx)).account_info.token,'rotated-access');
 const conflict=await sessionAction('install',{...q,account_info:{...account_info,token:'different-captured-access'}},ctx);
 assert.equal(conflict.status,'conflict');e.close();
});
