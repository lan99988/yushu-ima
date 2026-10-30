import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {D1Store} from '../../worker/storage.js';
import {runtime} from './runtime.mjs';
export const contract=JSON.parse(await readFile(new URL('./governance-contract.json',import.meta.url)));
export const golden=JSON.parse(await readFile(new URL('./python-golden.json',import.meta.url)));
export function context(){
 const objects=new Map(),calls=[];
 const copy=x=>x==null?null:structuredClone(x);
 const store=new D1Store(runtime().DB);
 const blobs={async put(k,bytes,options){objects.set(k,{bytes:typeof bytes==='string'?new TextEncoder().encode(bytes):new Uint8Array(bytes),options});},async get(k){const x=objects.get(k);return x?{size:x.bytes.length,httpMetadata:{contentType:x.options?.contentType},arrayBuffer:async()=>x.bytes.buffer.slice(x.bytes.byteOffset,x.bytes.byteOffset+x.bytes.byteLength),text:async()=>new TextDecoder().decode(x.bytes)}:null;}};
 store.put('settings','policy',copy(contract.policy));store.put('settings','bindings',copy(contract.bindings));
 const ctx={env:{},store,blobs,calls,objects,async invoke(domain,q){calls.push({domain,q:copy(q)});if(q.action==='text.create'&&!q.reconcile){ctx.transport=q;return ctx.receipt={status:'succeeded',request_id:q.request_id,resource:{kb_id:q.kb_id,folder_id:q.folder_id,filename:q.filename,content_sha256:await hash(q.content),media_ids:['media-'+calls.filter(x=>x.q.execute&&!x.q.reconcile).length]}};}if(q.action==='text.create'&&q.reconcile)return ctx.receipt||{status:'unknown'};if(q.action==='media.read')return {status:'succeeded',data:{content:ctx.remoteContent??ctx.transport?.content}};return {status:'unknown'};}};let savedReceipt;Object.defineProperty(ctx,'receipt',{get(){return savedReceipt;},set(value){savedReceipt=value;if(ctx.transport){const request=Object.fromEntries(Object.entries(ctx.transport).filter(([k])=>!['execute','reconcile'].includes(k)));const fingerprint=createHash('sha256').update(pyPacked(request)+contract.bindings.account_sha256).digest('hex');store.put('operations',request.request_id,copy({fingerprint,request,status:value.status,receipt:value}));}}});return ctx;
}
export async function hash(s){return Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('hex');}
export const draft=()=>({source_id:'source-1',source_url:'https://example.org/source',title:'证据卡',content:'原稿正文',kind:'fact',source_locator:'第三节',category:'learning'});
export async function reviewRequest(card,content='审定正文'){return {card_id:card.card_id,expected_version:card.version,input_hash:card.input_hash,mode:'web_verified',verdict:'pass',rationale:'原文支持',content,revision_hash:await hash(content),category:'learning',policy_version:'1.0.0',evidence:[{url:'https://example.org/paper',locator:'第三节',supports:'核心断言',excerpt:'原文摘录',checked_at:'2026-10-25T00:00:00Z',checker:'host',input_hash:card.input_hash,revision_hash:await hash(content),category:'learning'}]};}

function pyPacked(v){if(Array.isArray(v))return '['+v.map(pyPacked).join(', ')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+': '+pyPacked(v[k])).join(', ')+'}';return JSON.stringify(v);}
