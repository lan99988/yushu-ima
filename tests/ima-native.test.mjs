import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeHeaders} from '../worker/ima-session.js';

// Only synthetic sessions and in-memory HTTP streams; never call the network.
const native = await import('../worker/ima-native.js').catch(error => {
 if(error.code === 'ERR_MODULE_NOT_FOUND')return {};
 throw error;
});
const current = {account_info:{userId:'synthetic-user',token:'synthetic-access-secret',refreshToken:'synthetic-refresh-secret',idType:2,tokenType:14},device_info:{guid:'synthetic-guid'}};
const origin = 'https://ima.qq.com';
const listURL = origin + '/cgi-bin/knowledge_tab_reader/get_knowledge_list';
const moveURL = origin + '/cgi-bin/knowledge_tab_sse/move_knowledge';
const resumeURL = origin + '/cgi-bin/knowledge_tab_sse/resume_cross_kb_op';
const body = {src_knowledge_base_id:'kb',dst_knowledge_base_id:'kb',dst_folder_id:'dst',media_ids:['file'],action:0};
const path = [{folder_id:'kb',name:'知识库',parent_folder_id:''},{folder_id:'src',name:'来源',parent_folder_id:'kb'}];
const item = {media_id:'file',title:'资料中文😀',parent_folder_id:'src',media_type:7,file_size:'12',md5_sum:'abc'};
const page = (extra={}) => ({code:0,knowledge_base_info:{id:'kb'},current_path:path,knowledge_list:[item],is_end:true,...extra});
function setup(fetcher){
 assert.equal(typeof native.NativeClient,'function','NativeClient class must be exported');
 const calls=[];
 const client=new native.NativeClient({nativeFetcher:async(url,options)=>{calls.push({url,options});return fetcher(url,options,calls.length);}},current);
 return {client,calls};
}
function sse(text,{chunkSize=65536,status=200,onCancel}={}){
 const bytes=new TextEncoder().encode(text);let at=0;
 return new Response(new ReadableStream({pull(controller){if(at>=bytes.length){controller.close();return;}controller.enqueue(bytes.slice(at,at+=chunkSize));},cancel(){onCancel?.();}},{highWaterMark:0}),{status,headers:{'content-type':'text/event-stream; charset=utf-8'}});
}
const event = (name,data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
function safe(value){
 const out=typeof value==='string'?value:JSON.stringify(value);
 for(const secret of ['synthetic-access-secret','synthetic-refresh-secret','synthetic-user','synthetic-guid','upstream-private-message'])assert.ok(!out.includes(secret),`must not expose ${secret}`);
}

test('exports the native adapter class',()=>assert.equal(typeof native.NativeClient,'function'));

test('list uses the fixed official endpoint, native headers, bounded POST and a field whitelist',async()=>{
 const {client,calls}=setup(()=>Response.json(page({knowledge_list:[{...item,url:'https://untrusted.invalid',token:'synthetic-access-secret',folder_info:{private:'hidden'}},{...item,media_id:'dir',media_type:99}],current_path:path.map(p=>({...p,private:'hidden'}))})));
 const result=await client.list('kb','src');
 assert.deepEqual(result,{items:[{...item,kind:'file'},{...item,media_id:'dir',media_type:99,kind:'folder'}],path,knowledge_base_id:'kb'});
 assert.equal(calls.length,1);assert.equal(calls[0].url,listURL);
 const o=calls[0].options;assert.equal(o.method,'POST');assert.equal(o.redirect,'manual');assert.ok(o.signal instanceof AbortSignal);
 assert.deepEqual(o.headers,nativeHeaders(current));
 assert.deepEqual(JSON.parse(o.body),{knowledge_base_id:'kb',folder_id:'src',cursor:'',limit:50,need_default_cover:false});safe(result);
});

test('list accepts root and data payloads and exhausts all pages while deduplicating media IDs',async()=>{
 const pages=[page({is_end:false,next_cursor:'one'}),{code:0,data:page({knowledge_list:[item,{...item,media_id:'two'}],is_end:false,next_cursor:'two'})},{data:page({knowledge_list:[{...item,media_id:'three'}],total_size:'3'})}];
 const {client,calls}=setup(()=>Response.json(pages.shift()));
 assert.deepEqual((await client.list('kb','src')).items.map(x=>x.media_id),['file','two','three']);
 assert.deepEqual(calls.map(c=>JSON.parse(c.options.body).cursor),['','one','two']);
});

test('list defaults folder ID to empty and validates the knowledge-base root path',async()=>{
 const {client,calls}=setup(()=>Response.json(page({current_path:[path[0]],knowledge_list:[]})));
 assert.deepEqual(await client.list('kb'),{items:[],path:[path[0]],knowledge_base_id:'kb'});
 assert.equal(JSON.parse(calls[0].options.body).folder_id,'');
});

test('root total_size describes library content, not the eleven directly listed categories',async()=>{
 const roots=Array.from({length:11},(_,i)=>({...item,media_id:'folder_'+i,media_type:99,parent_folder_id:'kb'}));
 for(const total_size of ['7','46']){
  const {client}=setup(()=>Response.json(page({total_size,current_path:[path[0]],knowledge_list:roots})));
  assert.equal((await client.list('kb','')).items.length,11);
 }
 const {client}=setup(()=>Response.json(page({total_size:'7',current_path:[path[0]],knowledge_list:roots,is_end:false,next_cursor:''})));
 await assert.rejects(client.list('kb',''));
});

test('count disagreement exposes bounded structural diagnostics without a provider body or session',async()=>{
 const {client}=setup(()=>Response.json(page({total_size:'7',msg:'upstream-private-message'})));
 await assert.rejects(client.list('kb','src'),error=>{
  assert.deepEqual(error.diagnostics,{knowledge_base_id:'kb',folder_id:'src',reported_total:7,listed_count:1,folder_count:0,file_count:1,pages:1,is_end:true});
  safe(error.diagnostics);return true;
 });
});

test('list rejects HTTP failures, invalid JSON and nonzero or nonnumeric/missing JSON code without leaking bodies',async()=>{
 const replies=[()=>new Response('upstream-private-message',{status:401}),()=>new Response('not json upstream-private-message'),()=>Response.json(page({code:51,msg:'upstream-private-message'})),()=>Response.json({code:0,data:page({code:51})}),()=>Response.json(page({code:'0'})),()=>Response.json(page({code:undefined})),()=>Response.json({code:51,data:page()})];
 for(const reply of replies){const {client,calls}=setup(reply);await assert.rejects(client.list('kb','src'),e=>{safe(e.message);return true;});assert.equal(calls.length,1);}
});

test('list rejects mismatched knowledge bases, malformed paths and cross-page path changes',async()=>{
 const invalid=[{knowledge_base_info:{id:'other'}},{knowledge_base_info:{}},{current_path:[]},{current_path:[path[0]]},{current_path:[{...path[0],folder_id:'other'},path[1]]},{current_path:[path[0],{...path[1],parent_folder_id:'other'}]},{current_path:[path[0],path[1],path[1]]},{knowledge_list:[{...item,parent_folder_id:'elsewhere'}]}];
 for(const extra of invalid){const {client}=setup(()=>Response.json(page(extra)));await assert.rejects(client.list('kb','src'));}
 const {client}=setup((u,o,n)=>Response.json(page(n===1?{is_end:false,next_cursor:'next'}:{current_path:[path[0],{...path[1],name:'changed'}]})));
 await assert.rejects(client.list('kb','src'));
});

test('list rejects incomplete pagination instead of returning partial contents',async()=>{
 for(const extra of [{is_end:false},{is_end:false,next_cursor:''},{is_end:'true'},{is_end:undefined},{knowledge_list:null},{total_size:'2'}]){
  const {client}=setup(()=>Response.json(page(extra)));await assert.rejects(client.list('kb','src'));
 }
 const {client,calls}=setup((u,o,n)=>Response.json(page({is_end:false,next_cursor:n===1?'a':n===2?'b':'a',knowledge_list:[{...item,media_id:String(n)}]})));
 await assert.rejects(client.list('kb','src'));assert.equal(calls.length,3);
});

test('list aborts a pagination loop with new cursors but no new media',async()=>{
 const {client,calls}=setup((u,o,n)=>Response.json(page({is_end:false,next_cursor:String(n)})));
 await assert.rejects(client.list('kb','src'));assert.equal(calls.length,2);
});

test('all methods reject redirects without following or leaking redirect bodies',async()=>{
 for(const run of [c=>c.list('kb','src'),c=>c.move(body),c=>c.resume('task')]){
  const {client,calls}=setup(()=>new Response('upstream-private-message',{status:302,headers:{location:'https://attacker.invalid'}}));
  await assert.rejects(run(client),e=>{safe(e.message);return true;});assert.equal(calls.length,1);assert.equal(calls[0].options.redirect,'manual');
 }
 const {client}=setup(()=>{const r=Response.json(page());Object.defineProperty(r,'redirected',{value:true});return r;});
 await assert.rejects(client.list('kb','src'));
});

test('SSE incrementally decodes single-byte UTF-8 chunks, CRLF and multiline data',async()=>{
 const wire='\ufeff: keepalive\r\nevent: PROGRESS\r\ndata: {"taskId":"task-one",\r\ndata: "progress":50,"results":[{"media_id":"file","title":"资料中文😀","msg":"upstream-private-message"}]}\r\n\r\n'+event('COMPLETE',{results:[{media_id:'file',title:'资料中文😀'}]}).replaceAll('\n','\r\n');
 const {client,calls}=setup(()=>sse(wire,{chunkSize:1}));const seen=[];
 const result=await client.move(body,e=>seen.push(e));
 assert.equal(result.complete,true);assert.equal(result.conflict,false);assert.equal(result.task_id,'task-one');
 assert.deepEqual(result.events,seen);assert.deepEqual(seen,[{event:'PROGRESS',task_id:'task-one',progress:50,ret_code:0,results:[{media_id:'file',title:'资料中文😀',ret_code:0}]},{event:'COMPLETE',ret_code:0,results:[{media_id:'file',title:'资料中文😀',ret_code:0}]}]);safe(result);
 assert.equal(calls.length,1);assert.equal(calls[0].url,moveURL);assert.deepEqual(JSON.parse(calls[0].options.body),body);assert.deepEqual(calls[0].options.headers,nativeHeaders(current));
});

test('SSE callbacks run before EOF and support awaited persistence',async()=>{
 let controller,notice;const noticed=new Promise(r=>notice=r);let settled=false;
 const {client}=setup(()=>new Response(new ReadableStream({start(c){controller=c;}}),{headers:{'content-type':'text/event-stream'}}));
 const pending=client.move(body,async e=>{if(e.event==='PROGRESS'){await Promise.resolve();notice();}}).then(r=>{settled=true;return r;});
 controller.enqueue(new TextEncoder().encode(event('PROGRESS',{task_id:'live',progress:1})));
 await noticed;assert.equal(settled,false);
 controller.enqueue(new TextEncoder().encode(event('COMPLETE',{})));controller.close();assert.equal((await pending).complete,true);
});

test('task IDs are captured from any event and nested data or progress_msg; aliases normalize',async()=>{
 const wire=event('TASK_CREATED',{data:{taskId:'task-created'}})+event('PROGRESS',{data:{progress_msg:{task_id:'task-created',progress:25}}})+event('COMPLETE',{data:{taskId:'task-created',results:[{media_id:'file',retCode:0,dst_media_id:'dst-file',err_msg:'upstream-private-message'}]}});
 const {client}=setup(()=>sse(wire));const result=await client.move(body);
 assert.equal(result.task_id,'task-created');assert.equal(result.complete,true);
 assert.deepEqual(result.events.at(-1),{event:'COMPLETE',task_id:'task-created',ret_code:0,results:[{media_id:'file',ret_code:0,dst_media_id:'dst-file'}]});
 assert.equal(result.events.find(e=>e.event==='PROGRESS').progress,25);safe(result);
});

test('resume posts the original task exactly once to the resume endpoint',async()=>{
 const {client,calls}=setup(()=>sse(event('COMPLETE',{})));const result=await client.resume('original-task');
 assert.equal(result.task_id,'original-task');assert.equal(result.complete,true);assert.equal(calls.length,1);assert.equal(calls[0].url,resumeURL);
 assert.deepEqual(JSON.parse(calls[0].options.body),{task_id:'original-task'});
});

test('code 51 and per-item failures never become a successful completion',async()=>{
 for(const data of [{code:51,msg:'upstream-private-message'},{data:{code:51}},{ret_code:51},{retCode:51},{results:[{media_id:'file',retCode:51,err_msg:'upstream-private-message'}]}]){
  const {client,calls}=setup(()=>sse(event('COMPLETE',data)));const result=await client.move(body);
  assert.equal(result.complete,false);assert.equal(result.events[0].ret_code===51||result.events[0].results[0]?.ret_code===51,true);safe(result);assert.equal(calls.length,1);
 }
});

test('HTTP 200 JSON rejection is not parsed as an SSE success or retried',async()=>{
 for(const run of [c=>c.move(body),c=>c.resume('task')]){
  const {client,calls}=setup(()=>Response.json({code:51,msg:'upstream-private-message',token:'synthetic-access-secret'}));
  await assert.rejects(run(client),e=>{safe(e.message);return true;});assert.equal(calls.length,1);
 }
});

test('unknown EOF and unterminated COMPLETE frames preserve the task but remain incomplete',async()=>{
 for(const suffix of ['', 'event: COMPLETE\ndata: {}\n',event('UNKNOWN',{msg:'upstream-private-message'})]){
  const {client}=setup(()=>sse(event('PROGRESS',{task_id:'unfinished',progress:100})+suffix));
  const result=await client.move(body);assert.equal(result.complete,false);assert.equal(result.task_id,'unfinished');safe(result);
 }
});

test('SAMENAME stops as a conflict without overwrite, reply, retry or subsequent completion',async()=>{
 let canceled=false;
 const {client,calls}=setup(()=>sse(event('SAMENAME',{taskId:'conflicted',tips:'upstream-private-message',results:[{media_id:'file',support_actions:['overwrite'],msg:'upstream-private-message'}]})+event('COMPLETE',{}),{onCancel(){canceled=true;}}));
 const seen=[],result=await client.move(body,e=>seen.push(e));
 assert.equal(result.complete,false);assert.equal(result.conflict,true);assert.equal(result.task_id,'conflicted');assert.equal(calls.length,1);assert.equal(canceled,true);
 assert.deepEqual(seen.map(x=>x.event),['SAMENAME']);safe(result);
});

test('stream read and network errors are unknown, sanitized and never replay moves',async()=>{
 let n=0;
 const stream=new ReadableStream({pull(c){if(n++===0)c.enqueue(new TextEncoder().encode(event('PROGRESS',{task_id:'recoverable'})));else c.error(Error('synthetic-access-secret upstream-private-message'));}});
 const {client,calls}=setup(()=>new Response(stream,{headers:{'content-type':'text/event-stream'}}));
 const result=await client.move(body);assert.equal(result.complete,false);assert.equal(result.task_id,'recoverable');assert.equal(calls.length,1);safe(result);
 const broken=setup(()=>{throw Error('synthetic-access-secret upstream-private-message');});
 const unknown=await broken.client.move(body);assert.equal(unknown.complete,false);assert.equal(broken.calls.length,1);safe(unknown);
 await assert.rejects(broken.client.list('kb','src'),e=>{safe(e.message);return true;});
});

test('malformed JSON, UTF-8, result codes and changed task identity cannot complete',async()=>{
 for(const wire of ['event: COMPLETE\ndata: not-json\n\n',event('COMPLETE',{code:'0'}),event('COMPLETE',{results:[{media_id:'file',ret_code:'0'}]}),event('PROGRESS',{task_id:'a'})+event('COMPLETE',{taskId:'b'}),event('COMPLETE',{results:[{}]})]){
  const {client}=setup(()=>sse(wire));assert.equal((await client.move(body)).complete,false);
 }
 const {client}=setup(()=>new Response(new Uint8Array([0xff]),{headers:{'content-type':'text/event-stream'}}));assert.equal((await client.move(body)).complete,false);
});

test('SSE size limit counts cumulative bytes, cancels the reader, and does not accept a later COMPLETE',async()=>{
 let canceled=false;const wire=event('PROGRESS',{task_id:'large'})+(': '+'中'.repeat(200000)+'\n\n').repeat(4)+event('COMPLETE',{});
 const {client,calls}=setup(()=>sse(wire,{chunkSize:65536,onCancel(){canceled=true;}}));
 const result=await client.move(body);assert.equal(result.complete,false);assert.equal(result.task_id,'large');assert.equal(canceled,true);assert.equal(calls.length,1);
});

test('30-second deadline bounds a stalled SSE reader, cancels it and preserves task ID',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let canceled=false,notice;const noticed=new Promise(r=>notice=r);
 const {client,calls}=setup(()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(event('PROGRESS',{task_id:'timed-out'})));},cancel(){canceled=true;}}),{headers:{'content-type':'text/event-stream'}}));
 const pending=client.move(body,()=>notice());await noticed;t.mock.timers.tick(29999);assert.equal(calls[0].options.signal.aborted,false);
 t.mock.timers.tick(1);const result=await pending;
 assert.equal(result.complete,false);assert.equal(result.task_id,'timed-out');assert.equal(canceled,true);assert.equal(calls[0].options.signal.aborted,true);assert.equal(calls.length,1);
});

test('30-second deadline also bounds a fetcher that never resolves or honors abort',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const {client,calls}=setup(()=>new Promise(()=>{}));const pending=client.move(body);
 t.mock.timers.tick(30000);assert.equal((await pending).complete,false);assert.equal(calls.length,1);assert.equal(calls[0].options.signal.aborted,true);
});

test('resume rejects invalid task IDs before dispatch and never creates a fresh move',async()=>{
 for(const id of ['',null,{},'https://attacker.invalid/','task\r\ninjection']){
  const {client,calls}=setup(()=>{throw Error('unexpected dispatch');});await assert.rejects(client.resume(id));assert.equal(calls.length,0);
 }
});

test('credentials in allowlisted event fields are redacted too',async()=>{
 const {client}=setup(()=>sse(event('COMPLETE',{results:[{media_id:'file',title:'synthetic-access-secret synthetic-refresh-secret synthetic-user synthetic-guid'}],msg:'upstream-private-message'})));
 safe(await client.move(body));
});

test('numeric account type strings are protocol enums, not secrets to redact from native resource IDs',async()=>{
 const enums={...current,account_info:{...current.account_info,idType:'2',tokenType:'14',accountType:'1'}};
 const kb='7000000000000001',folder='folder_7000000000000003';
 const client=new native.NativeClient({nativeFetcher:async()=>Response.json({code:0,knowledge_base_info:{id:kb},current_path:[{folder_id:kb,name:'人类3.0知识库',parent_folder_id:''}],knowledge_list:[{...item,media_id:folder,parent_folder_id:kb,title:'03_学习与认知',media_type:99}],is_end:true})},enums);
 const result=await client.list(kb,'');assert.equal(result.knowledge_base_id,kb);assert.equal(result.items[0].media_id,folder);assert.equal(result.items[0].title,'03_学习与认知');
});

test('callback failure cannot cause a move retry or expose callback messages',async()=>{
 const {client,calls}=setup(()=>sse(event('PROGRESS',{task_id:'saved-task'})+event('COMPLETE',{})));
 const result=await client.move(body,()=>{throw Error('upstream-private-message');});assert.equal(result.complete,false);assert.equal(result.task_id,'saved-task');assert.equal(calls.length,1);safe(result);
});

test('uses global fetch only as the injected-fetcher fallback, still with fixed origin',async()=>{
 assert.equal(typeof native.NativeClient,'function');const original=globalThis.fetch;const calls=[];
 try{globalThis.fetch=async function(url,options){assert.equal(this,globalThis,'platform fetch requires its global receiver');calls.push({url,options});return sse(event('COMPLETE',{}));};
  const client=new native.NativeClient({origin:'https://attacker.invalid/'},current);assert.equal((await client.resume('task')).complete,true);assert.equal(calls[0].url,resumeURL);
 }finally{globalThis.fetch=original;}
});
