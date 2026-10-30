import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
const module = await import('../worker/ima.js');
const invoke = (...args) => { assert.equal(typeof module.invokeIma, 'function', 'invokeIma export must exist'); return module.invokeIma(...args); };
const sha = s => createHash('sha256').update(s).digest('hex');
const ok = data => Response.json({code:0,data});
const env = {IMA_OPENAPI_CLIENTID:'mock-client',IMA_OPENAPI_APIKEY:'mock-secret'};
function harness(routes={}, state={}) {
  const calls=[], patches=[]; const objects=new Map();
  const ctx={env,state, onStage:async p=>{patches.push(structuredClone(p));},
    fetcher:async (url,init)=>{
      const path=new URL(url).pathname.split('/').at(-1);
      const body=init.method==='POST'?JSON.parse(init.body):init.body;
      calls.push({url,init,body,path,stages:patches.length});
      assert.equal(init.redirect,'manual');
      if(!routes[path]) throw Error('unexpected endpoint '+path);
      return routes[path](body,init,calls);
    },blobs:{get:async id=>{const bytes=objects.get(id); return bytes?{size:bytes.length,body:new Blob([bytes]).stream(),httpMetadata:{contentType:'text/plain'},arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)}:null;},
    put:async(key,body,meta)=>{objects.set(key,new Uint8Array(await new Response(body).arrayBuffer()));return {key};}}};
  return {ctx,calls,patches,objects};
}
const noteRoutes=(title='Old',content='body')=>({list_note:()=>ok({note_book_list:[{note_id:'n1',title}],is_end:true}),get_doc_content:()=>ok({content})});
test('notes list filters tombstones without claiming a filtered empty page is complete',async()=>{
 const h=harness({list_note:()=>ok({note_book_list:[{note_id:'n',title:'【已删除】x'}],is_end:false})});
 const r=await invoke('notes',{action:'list'},h.ctx); assert.equal(r.status,'succeeded');assert.deepEqual(r.data.items,[]);assert.equal(r.data.has_more,true);assert.match(r.data.warning,/pagination_unverified/);
});
test('create preview has no remote or blob writes',async()=>{const h=harness();const r=await invoke('notes',{action:'create',content:'# Hello',request_id:'p'},h.ctx);assert.equal(r.status,'preview');assert.equal(h.calls.length,0);assert.equal(h.patches.length,0);});
test('note create records intent then ID before readback and verifies content',async()=>{
 const h=harness({import_doc:()=>ok({note_id:'n1'}),get_doc_content:()=>ok({content:'Hello'})});
 const r=await invoke('notes',{action:'create',request_id:'c',execute:true,content:'# Hello'},h.ctx);
 assert.equal(r.status,'succeeded');assert.equal(r.resource.note_id,'n1');assert.ok(h.calls[0].stages>0);assert.ok(h.patches.some(p=>p.resource?.note_id==='n1'));assert.equal(r.receipt.expected_compact_sha256,sha('Hello'));
});
test('title mutation preserves body hash and requires expected title',async()=>{
 let title='Old';const h=harness({...noteRoutes(),list_note:()=>ok({note_book_list:[{note_id:'n1',title}],is_end:true}),rename_note:b=>{title=b.title;return ok({});}});
 const r=await invoke('notes',{action:'delete',request_id:'d',execute:true,note_id:'n1',expected_title:'Old'},h.ctx);
 assert.equal(r.status,'succeeded');assert.equal(title,'【已删除】Old');assert.equal(r.receipt.before_content_sha256,sha('body'));
 const bad=await invoke('notes',{action:'rename',request_id:'r',execute:true,note_id:'n1',expected_title:'Old',title:'new'},h.ctx);assert.equal(bad.status,'conflict');
});
test('title operation body change is verification_pending',async()=>{
 let changed=false;const h=harness({list_note:()=>ok({note_book_list:[{note_id:'n1',title:changed?'New':'Old'}],is_end:true}),get_doc_content:()=>ok({content:changed?'modified':'body'}),rename_note:()=>{changed=true;return ok({});}});
 const r=await invoke('notes',{action:'rename',request_id:'r',execute:true,note_id:'n1',expected_title:'Old',title:'New'},h.ctx);assert.equal(r.status,'verification_pending');
});
test('reconcile without recorded IDs never creates even when q has an ID',async()=>{
 const h=harness();const r=await invoke('notes',{action:'append',note_id:'n1',content:'x',expected_title:'Old',execute:true,reconcile:true,request_id:'r'},h.ctx);assert.equal(r.status,'unknown');assert.equal(h.calls.length,0);
});
test('reconcile note uses recorded hashes and ID only',async()=>{
 const h=harness({get_doc_content:b=>{assert.equal(b.note_id,'saved');return ok({content:'Hello'});}}, {resource:{note_id:'saved'},receipt:{expected_compact_sha256:sha('Hello')}});
 const r=await invoke('notes',{action:'create',execute:true,reconcile:true,request_id:'r',content:'different'},h.ctx);assert.equal(r.status,'succeeded');assert.equal(h.calls.length,1);
});
test('failed stage persistence stops remote dispatch',async()=>{
 const h=harness({import_doc:()=>ok({note_id:'n1'})});h.ctx.onStage=async()=>{throw Error('storage unavailable');};
 const r=await invoke('notes',{action:'create',request_id:'s',execute:true,content:'x'},h.ctx);assert.equal(h.calls.length,0);assert.notEqual(r.status,'succeeded');
});
test('API redirects are refused without forwarding credentials',async()=>{
 const h=harness({list_note:()=>new Response(null,{status:302,headers:{location:'https://evil.example'}})});const r=await invoke('notes',{action:'list'},h.ctx);assert.equal(r.status,'unavailable');assert.equal(h.calls.length,1);assert.ok(!JSON.stringify(r).includes('mock-secret'));
});
test('KB pagination missing cursor is unavailable',async()=>{const h=harness({search_knowledge_base:()=>ok({info_list:[],is_end:false})});const r=await invoke('kb',{action:'kb.list'},h.ctx);assert.equal(r.status,'unavailable');});

test('knowledge search accepts observed single-page results without pagination fields',async()=>{
 for(const items of [[],[{media_id:'found',title:'检索命中'}]]){
  const h=harness({search_knowledge:b=>{assert.equal(b.cursor,'');return ok({info_list:items});}});
  const r=await invoke('kb',{action:'knowledge.search',kb_id:'k',query:'检索'},h.ctx);
  assert.equal(r.status,'succeeded',r.message);assert.deepEqual(r.data.items,items);assert.equal(r.data.has_more,false);assert.equal(h.calls.length,1);
 }
});

test('knowledge search still rejects incomplete pagination metadata and repeated cursors',async()=>{
 for(const pagination of [{next_cursor:'next'},{is_end:false},{is_end:true},{is_end:'true',next_cursor:''}]){
  const h=harness({search_knowledge:()=>ok({info_list:[],...pagination})});
  assert.equal((await invoke('kb',{action:'knowledge.search',kb_id:'k',query:'x'},h.ctx)).status,'unavailable');
 }
 const h=harness({search_knowledge:()=>ok({info_list:[],is_end:false,next_cursor:'next'})});
 assert.equal((await invoke('kb',{action:'knowledge.search',kb_id:'k',query:'x'},h.ctx)).status,'unavailable');assert.equal(h.calls.length,2);
});

test('knowledge search starts from the requested cursor and follows valid remaining pages',async()=>{
 const h=harness({search_knowledge:b=>ok({info_list:[{media_id:b.cursor}],is_end:b.cursor==='last',next_cursor:b.cursor==='last'?'':'last'})});
 const r=await invoke('kb',{action:'knowledge.search',kb_id:'k',query:'x',cursor:'resume'},h.ctx);
 assert.equal(r.status,'succeeded',r.message);assert.deepEqual(r.data.items.map(x=>x.media_id),['resume','last']);assert.equal(h.calls.length,2);
});

test('single-page search compatibility does not weaken folder or knowledge-base pagination',async()=>{
 for(const [action,endpoint,key] of [['folder.list','get_knowledge_list','knowledge_list'],['kb.list','search_knowledge_base','info_list']]){
  const h=harness({[endpoint]:()=>ok({[key]:[]})});
  assert.equal((await invoke('kb',{action,kb_id:'k'},h.ctx)).status,'unavailable');
 }
});
test('KB create uses only verified endpoint and reads back name',async()=>{
 const h=harness({search_knowledge_base:()=>ok({info_list:[],is_end:true}),create_knowledge_base:b=>{assert.deepEqual(b,{type:'KBT_MINE_KB',name:'New'});return ok({id:'k1'});},get_knowledge_base:()=>ok({infos:{k1:{id:'k1',name:'New'}}})});
 const r=await invoke('kb',{action:'kb.create',name:'New',request_id:'k',execute:true},h.ctx);assert.equal(r.status,'succeeded');assert.equal(r.resource.kb_id,'k1');assert.ok(h.patches.some(p=>p.resource?.kb_id==='k1'));
});
test('folder association is rejected before any API call',async()=>{const h=harness();const r=await invoke('kb',{action:'note.associate',kb_id:'k',folder_id:'f',note_id:'n',title:'N',request_id:'r',execute:true},h.ctx);assert.equal(r.status,'invalid_input');assert.equal(h.calls.length,0);});
test('unsafe media source and credential leakage are blocked',async()=>{
 for(const url of ['https://127.0.0.1/x','http://ima.qq.com/x','https://ima.qq.com.evil.example/x','https://localhost/x']){
 const h=harness({get_media_info:()=>ok({media_type:13,url_info:{url,headers:{authorization:'private-token'}}})});const r=await invoke('kb',{action:'media.read',media_id:'m'},h.ctx);assert.notEqual(r.status,'succeeded');assert.equal(h.calls.length,1);assert.ok(!JSON.stringify(r).includes('private-token'));}
});
test('media note returns content through notes tombstone guard',async()=>{const h=harness({get_media_info:()=>ok({media_type:11,notebook_ext_info:{notebook_id:'n1'}}),...noteRoutes()});const r=await invoke('kb',{action:'media.read',media_id:'m'},h.ctx);assert.equal(r.status,'succeeded');assert.equal(r.data.content,'body');});

test('UTF-8 BOM survives raw text reading so re-encoded bytes match the original backup hash',async()=>{
 const bytes=new TextEncoder().encode('\ufeff# 原文\n');
 const h=harness({get_media_info:()=>ok({media_type:7,url_info:{url:'https://res-skb.ima.qq.com/raw'}}),raw:()=>new Response(bytes,{headers:{'content-type':'text/markdown','content-length':String(bytes.length)}})});
 const r=await invoke('kb',{action:'media.read',media_id:'m'},h.ctx);assert.equal(r.status,'succeeded');assert.equal(sha(new TextEncoder().encode(r.data.content)),r.data.sha256);assert.equal(r.data.content.codePointAt(0),0xfeff);
});
test('media export returns private R2 ref and SHA, no raw download URL',async()=>{
 const h=harness({get_media_info:()=>ok({media_type:1,url_info:{url:'https://res-skb.ima.qq.com/raw'}}),raw:(_b,init)=>{assert.equal(init.headers['ima-openapi-apikey'],undefined);return new Response('%PDF-1.7 test',{headers:{'content-type':'application/pdf'}});}});
 const r=await invoke('kb',{action:'media.export',media_id:'m',request_id:'e',execute:true},h.ctx);assert.equal(r.status,'succeeded');assert.ok(r.data.blob_id);assert.equal(r.data.sha256,sha('%PDF-1.7 test'));assert.equal(h.objects.size,1);assert.ok(!JSON.stringify(r).includes('https://res-skb'));
});
test('MIME mismatch and signatures rejected before create_media',async()=>{
 const h=harness();h.objects.set('b',new TextEncoder().encode('not pdf'));const r=await invoke('kb',{action:'file.upload',kb_id:'k',blob_id:'b',filename:'bad.pdf',request_id:'f',execute:true},h.ctx);assert.equal(r.status,'invalid_input');assert.equal(h.calls.length,0);
});
test('url import only calls IMA API and accounts for partial failures',async()=>{
 const urls=['https://example.com/a','https://example.com/b'];const h=harness({get_knowledge_base:()=>ok({infos:{k:{id:'k',name:'K'}}}),import_urls:()=>ok({results:{[urls[0]]:{ret_code:0,media_id:'m1'},[urls[1]]:{ret_code:1}}})});
 const r=await invoke('kb',{action:'url.import',kb_id:'k',urls,request_id:'u',execute:true},h.ctx);assert.notEqual(r.status,'succeeded');assert.deepEqual(r.resource.media_ids,['m1']);assert.ok(h.patches.some(p=>p.resource?.media_ids?.includes('m1')));
});
function uploadHarness(bytes=new TextEncoder().encode('hello'),extra={}){
 const now=Math.floor(Date.now()/1000),cred={bucket_name:'bucket-123',region:'ap-shanghai',cos_key:'dir/object',secret_id:'temporary-id',secret_key:'temporary-key',token:'temporary-token',start_time:String(now-1),expired_time:String(now+1800)};
 const h=harness({get_knowledge_base:()=>ok({infos:{k:{id:'k',name:'K'}}}),check_repeated_names:b=>ok({results:b.params.map(x=>({name:x.name,is_repeated:false}))}),create_media:()=>ok({media_id:'m',cos_credential:cred}),object:async(body,init)=>{
   assert.equal(init.headers['ima-openapi-apikey'],undefined);assert.equal(init.headers['ima-openapi-clientid'],undefined);
   const data=new Uint8Array(await new Response(body).arrayBuffer());assert.deepEqual(data,bytes);
   const keyTime=cred.start_time+';'+cred.expired_time;
   const signKey=createHmac('sha1',cred.secret_key).update(keyTime).digest('hex');
   const http='put\n/dir/object\n\ncontent-length='+bytes.length+'&host=bucket-123.cos.ap-shanghai.myqcloud.com\n';
   const sig=createHmac('sha1',signKey).update('sha1\n'+keyTime+'\n'+createHash('sha1').update(http).digest('hex')+'\n').digest('hex');
   assert.ok(init.headers.authorization.endsWith('q-signature='+sig));return new Response('');
  },add_knowledge:()=>ok({media_id:'m'}),get_knowledge_list:()=>ok({knowledge_list:[{media_id:'m',title:'x.txt'}],is_end:true}),get_media_info:()=>ok({media_type:13,url_info:{url:'https://res-skb.ima.qq.com/raw'}}),raw:()=>new Response(bytes,{headers:{'content-type':'text/plain','content-length':String(bytes.length)}}),...extra});
 h.objects.set('b',bytes);return {...h,cred};
}
const uploadQ={action:'file.upload',kb_id:'k',blob_id:'b',filename:'x.txt',execute:true,request_id:'upload'};
test('upload uses decimal-string credentials, correct COS HMAC and byte-exact readback',async()=>{
 const h=uploadHarness();const r=await invoke('kb',uploadQ,h.ctx);assert.equal(r.status,'succeeded',r.message);assert.equal(r.receipt.input_sha256,sha('hello'));assert.deepEqual(r.resource.media_ids,['m']);
 for(const endpoint of ['create_media','object','add_knowledge'])assert.ok(h.calls.find(x=>x.path===endpoint).stages>0);
 assert.ok(h.patches.find(p=>p.resource?.media_ids?.[0]==='m'&&p.stage==='create_media'));
 assert.ok(!JSON.stringify(r).includes('temporary-'));assert.equal(h.calls.filter(c=>c.path==='create_media').length,1);
});
test('binary upload reconcile hashes original without writing R2 or resubmitting',async()=>{
 const bytes=new TextEncoder().encode('%PDF-1.7 binary');const h=uploadHarness(bytes,{raw:()=>new Response(bytes,{headers:{'content-type':'application/pdf'}})});
 h.ctx.state={resource:{kb_id:'k',media_ids:['m']},receipt:{input_sha256:sha(bytes)}};
 h.ctx.blobs.put=()=>{assert.fail('reconcile must never put blobs');};
 const r=await invoke('kb',{...uploadQ,filename:'x.pdf',reconcile:true},h.ctx);assert.equal(r.status,'succeeded');assert.deepEqual(h.calls.map(c=>c.path),['get_knowledge_list','get_media_info','raw']);
});
test('text original readback mismatch is verification_pending',async()=>{
 const h=uploadHarness(undefined,{raw:()=>new Response('changed',{headers:{'content-type':'text/plain','content-length':'7'}})});
 const r=await invoke('kb',{action:'text.create',kb_id:'k',filename:'x.txt',content:'hello',execute:true,request_id:'text'},h.ctx);assert.equal(r.status,'verification_pending');
});
test('unsafe or expired COS credentials never PUT and preserve orphan ID',async()=>{
 for(const mutate of [c=>{c.bucket_name='x.evil.example';},c=>{delete c.bucket_name;},c=>{c.expired_time='1';},c=>{c.cos_key='../bad';}]){
 const h=uploadHarness();mutate(h.cred);const r=await invoke('kb',uploadQ,h.ctx);assert.equal(r.status,'unknown');assert.deepEqual(r.resource.media_ids,['m']);assert.equal(r.receipt.orphaned_media,true);assert.ok(!h.calls.some(x=>x.path==='object'||x.path==='add_knowledge'));}
});
test('COS redirect never follows and never calls add_knowledge',async()=>{const h=uploadHarness(undefined,{object:()=>new Response(null,{status:307,headers:{location:'https://evil.example'}})});const r=await invoke('kb',uploadQ,h.ctx);assert.equal(r.status,'unknown');assert.ok(!h.calls.some(x=>x.path==='add_knowledge'));});
test('post-creation stage failure preserves known ID and stops subsequent writes',async()=>{
 const h=uploadHarness();h.ctx.onStage=async p=>{if(p.stage==='create_media'&&p.receipt.stages.create_media==='recorded')throw Error('save failed');};
 const r=await invoke('kb',uploadQ,h.ctx);assert.equal(r.status,'unknown');assert.deepEqual(r.resource.media_ids,['m']);assert.ok(!h.calls.some(x=>x.path==='object'));
});
test('an existing stage cannot be accidentally dispatched again',async()=>{const h=harness({}, {receipt:{stages:{import_doc:'before'}}});const r=await invoke('notes',{action:'create',content:'hi',execute:true,request_id:'repeat'},h.ctx);assert.equal(r.status,'unknown');assert.equal(h.calls.length,0);});
test('file type size limits checked before reading a large object',async()=>{const h=harness();let read=false;h.ctx.blobs.get=async()=>({size:11*1024*1024,httpMetadata:{contentType:'text/plain'},get body(){read=true;throw Error('should not read');}});const r=await invoke('kb',uploadQ,h.ctx);assert.equal(r.status,'invalid_input');assert.equal(read,false);});
test('R2 second-read mutation stops add_knowledge',async()=>{
 const h=uploadHarness();const get=h.ctx.blobs.get;let count=0;h.ctx.blobs.get=async id=>{if(++count===2)h.objects.set(id,new TextEncoder().encode('HELLO'));return get(id);};
 const r=await invoke('kb',uploadQ,h.ctx);assert.equal(r.status,'unknown');assert.ok(!h.calls.some(x=>x.path==='add_knowledge'));
});
test('reconcile export reads recorded blob only',async()=>{
 const h=harness({}, {resource:{blob_id:'saved'},receipt:{output_sha256:sha('file'),output_size:4,content_type:'application/pdf'}});h.objects.set('saved',new TextEncoder().encode('file'));h.ctx.blobs.put=()=>assert.fail('put');
 const r=await invoke('kb',{action:'media.export',request_id:'r',reconcile:true,execute:true,media_id:'ignored'},h.ctx);assert.equal(r.status,'succeeded');assert.equal(h.calls.length,0);
});
test('KB folders and searches consume every cursor and detect loops',async()=>{
 for(const loop of [false,true]){const h=harness({get_knowledge_list:b=>ok({knowledge_list:[{media_id:b.cursor?'m2':'m1',title:'x'}],is_end:!loop&&b.cursor==='next',next_cursor:'next'})});const r=await invoke('kb',{action:'folder.list',kb_id:'k'},h.ctx);assert.equal(r.status,loop?'unavailable':'succeeded');if(!loop)assert.equal(r.data.items.length,2);assert.equal(h.calls.length,2);}
});
test('folder creation records parent and verifies ID in parent listing',async()=>{
 let created=false;const h=harness({get_knowledge_base:()=>ok({infos:{k:{id:'k',name:'K'}}}),get_knowledge_list:b=>{assert.equal(b.folder_id,'parent');return ok({knowledge_list:created?[{media_id:'folder_f',title:'Child'}]:[],is_end:true});},create_folder:b=>{assert.deepEqual(b,{knowledge_base_id:'k',name:'Child',folder_id:'parent'});created=true;return ok({media_id:'folder_f'});}});
 const r=await invoke('kb',{action:'folder.create',kb_id:'k',folder_id:'parent',name:'Child',request_id:'f',execute:true},h.ctx);assert.equal(r.status,'succeeded');assert.equal(r.resource.parent_folder_id,'parent');assert.equal(r.resource.folder_id,'folder_f');
});
test('restore removes one tombstone prefix and append reads full expected content',async()=>{
 let title='【已删除】Old',content='body';const h=harness({list_note:()=>ok({note_book_list:[{note_id:'n1',title}],is_end:true}),get_doc_content:()=>ok({content}),rename_note:b=>{title=b.title;return ok({});},append_doc:b=>{content+='\n'+b.content;return ok({});}});
 let r=await invoke('notes',{action:'restore',note_id:'n1',expected_title:title,request_id:'restore',execute:true},h.ctx);assert.equal(r.status,'succeeded');assert.equal(title,'Old');
 r=await invoke('notes',{action:'append',note_id:'n1',expected_title:title,content:'more',request_id:'append',execute:true},h.ctx);assert.equal(r.status,'succeeded');assert.equal(content,'body\nmore');
});
test('invalid requests return protocol results rather than rejecting',async()=>{for(const q of [null,[],{}, {action:'create',content:'\ud800',request_id:'bad'}]){const h=harness();const r=await invoke('notes',q,h.ctx);assert.ok(['invalid_input','unsupported'].includes(r.status));}});
test('export of note media stores a private text blob and readback hash',async()=>{const h=harness({get_media_info:()=>ok({media_type:11,notebook_ext_info:{notebook_id:'n1'}}),...noteRoutes()});const r=await invoke('kb',{action:'media.export',media_id:'m',request_id:'note-export',execute:true},h.ctx);assert.equal(r.status,'succeeded');assert.ok(r.data.blob_id);assert.equal(r.data.sha256,sha('body'));});
test('reconcile missing hashes cannot report success',async()=>{const h=harness(noteRoutes(),{resource:{note_id:'n1',target_title:'Old'}});const r=await invoke('notes',{action:'rename',reconcile:true,request_id:'r'},h.ctx);assert.equal(r.status,'verification_pending');});
test('media headers and redirects cannot leak secrets',async()=>{
 for(const headers of [{'ima-openapi-apikey':'untrusted'}, {authorization:'mock-secret'}, {cookie:'session'}, {host:'evil.example'}]){const h=harness({get_media_info:()=>ok({media_type:1,url_info:{url:'https://res-skb.ima.qq.com/raw',headers}})});const r=await invoke('kb',{action:'media.read',media_id:'m'},h.ctx);assert.equal(r.status,'unavailable');assert.equal(h.calls.length,1);}
 const h=harness({get_media_info:()=>ok({media_type:1,url_info:{url:'https://res-skb.ima.qq.com/raw',headers:{authorization:'private'}}}),raw:()=>new Response(null,{status:302,headers:{location:'https://evil.example'}})});const r=await invoke('kb',{action:'media.read',media_id:'m'},h.ctx);assert.equal(r.status,'unavailable');assert.equal(h.calls.length,2);
});
test('stream SHA256 matches platform hashes at block and chunk boundaries',async()=>{
 const {scan}=await import('../worker/ima-bytes.js');
 for(const size of [0,1,55,56,63,64,65,127,128,129,65537,1048577]){const bytes=Uint8Array.from({length:size},(_,i)=>(i*37+5)%256);const stream=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=57)c.enqueue(bytes.subarray(i,i+57));c.close();}});const r=await scan(stream);assert.equal(r.sha256,sha(bytes));assert.equal(r.size,size);}
});
test('Worker FixedLengthStream supplies known-length COS request bodies',async()=>{
 const original=globalThis.FixedLengthStream;const marked=new WeakSet();
 globalThis.FixedLengthStream=class extends TransformStream{constructor(size){super();this.expected=size;marked.add(this.readable);}};
 try{const h=uploadHarness();const fetch=h.ctx.fetcher;h.ctx.fetcher=(u,i)=>{if(i.method==='PUT')assert.ok(marked.has(i.body),'COS stream needs Worker length metadata');return fetch(u,i);};const r=await invoke('kb',uploadQ,h.ctx);assert.equal(r.status,'succeeded');}finally{globalThis.FixedLengthStream=original;}
});
test('known-length export uses FixedLengthStream and unknown-length export has bounded fallback',async()=>{
 const original=globalThis.FixedLengthStream,marked=new WeakSet();globalThis.FixedLengthStream=class extends TransformStream{constructor(size){super();marked.add(this.readable);}};
 try{const h=harness({get_media_info:()=>ok({media_type:1,url_info:{url:'https://res-skb.ima.qq.com/raw'}}),raw:()=>new Response('pdf',{headers:{'content-type':'application/pdf','content-length':'3'}})});const put=h.ctx.blobs.put;h.ctx.blobs.put=(k,b,m)=>{assert.ok(marked.has(b),'R2 stream needs Worker length metadata');return put(k,b,m);};const r=await invoke('kb',{action:'media.export',media_id:'m',request_id:'fixed',execute:true},h.ctx);assert.equal(r.status,'succeeded');}finally{globalThis.FixedLengthStream=original;}
});
test('note get and media note read hide tombstoned contents',async()=>{
 const h=harness({...noteRoutes('【已删除】Old','secret'),get_media_info:()=>ok({media_type:11,notebook_ext_info:{notebook_id:'n1'}})});
 for(const [domain,q] of [['notes',{action:'get',note_id:'n1'}],['kb',{action:'media.read',media_id:'m'}]]){const r=await invoke(domain,q,h.ctx);assert.equal(r.status,'tombstoned');assert.ok(!JSON.stringify(r).includes('secret'));}
 const r=await invoke('notes',{action:'get',note_id:'n1',include_deleted:true},h.ctx);assert.equal(r.data.content,'secret');
});
test('notebooks retain version and cursor information',async()=>{const h=harness({list_notebook:()=>ok({note_folder_infos:[{folder_id:'f',name:'N'}],is_end:false,next_cursor:'c2',next_version:'v2'})});const r=await invoke('notes',{action:'list_notebooks'},h.ctx);assert.equal(r.status,'succeeded');assert.equal(r.data.next_cursor,'c2');assert.equal(r.data.next_version,'v2');assert.equal(r.data.has_more,true);});
test('successful root note association verifies membership',async()=>{const h=harness({...noteRoutes(),get_knowledge_base:()=>ok({infos:{k:{id:'k',name:'K'}}}),add_knowledge:b=>{assert.equal(b.media_type,11);assert.deepEqual(b.note_info,{content_id:'n1'});return ok({media_id:'m'});},get_knowledge_list:()=>ok({knowledge_list:[{media_id:'m',title:'Old'}],is_end:true})});const r=await invoke('kb',{action:'note.associate',kb_id:'k',note_id:'n1',title:'Old',request_id:'a',execute:true},h.ctx);assert.equal(r.status,'succeeded');assert.deepEqual(r.resource.media_ids,['m']);});
test('url import success verifies every returned ID and reconcile never imports again',async()=>{
 const urls=['https://example.com/a','https://example.com/b'];const routes={get_knowledge_base:()=>ok({infos:{k:{id:'k',name:'K'}}}),import_urls:()=>ok({results:{[urls[0]]:{ret_code:0,media_id:'a'},[urls[1]]:{ret_code:0,media_id:'b'}}}),get_knowledge_list:()=>ok({knowledge_list:[{media_id:'a',title:'A'},{media_id:'b',title:'B'}],is_end:true})};const h=harness(routes);const q={action:'url.import',kb_id:'k',urls,request_id:'urls',execute:true};const r=await invoke('kb',q,h.ctx);assert.equal(r.status,'succeeded');const recon=harness(routes,{resource:r.resource,receipt:r.receipt});const result=await invoke('kb',{...q,reconcile:true},recon.ctx);assert.equal(result.status,'succeeded');assert.deepEqual(recon.calls.map(x=>x.path),['get_knowledge_list']);
});
test('business validation precedes network mutations including malformed optional IDs',async()=>{
 const invalid=[['kb',{action:'media.export',request_id:'p'}],['kb',{...uploadQ,file:'C:\\opaque\\old.pdf',folder_id:7}],['notes',{action:'create',content:'ok',folder_id:12,request_id:'bad',execute:true}],['notes',{action:'rename',note_id:'n1',expected_title:'Old',title:'\ud800',request_id:'bad',execute:true}]];
 for(const [domain,q] of invalid){const h=uploadHarness();const r=await invoke(domain,q,h.ctx);assert.equal(r.status,'invalid_input',JSON.stringify(q));assert.equal(h.calls.length,0);}
});
test('opaque legacy file metadata is accepted while bytes come only from blob_id',async()=>{const h=uploadHarness();const r=await invoke('kb',{...uploadQ,file:'C:\\private\\must-never-be-read.txt'},h.ctx);assert.equal(r.status,'succeeded');});
test('route constants expose immutable read/write classification',()=>{assert.ok(Object.isFrozen(module.IMA_ROUTES));assert.ok(module.IMA_READ_ACTIONS.notes.includes('list_notebooks'));assert.ok(module.IMA_WRITE_ACTIONS.kb.includes('media.export'));assert.ok(!module.IMA_READ_ACTIONS.kb.includes('file.upload'));});
test('unknown-length original exceeding bounded fallback cancels before any R2 put',async()=>{
 let canceled=false,puts=0;const h=harness({get_media_info:()=>ok({media_type:1,url_info:{url:'https://res-skb.ima.qq.com/raw'}}),raw:()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(1024*1024));},cancel(){canceled=true;}}),{headers:{'content-type':'application/pdf'}})});
 h.ctx.blobs.put=()=>{puts++;};const r=await invoke('kb',{action:'media.export',media_id:'m',request_id:'limit',execute:true},h.ctx);assert.notEqual(r.status,'succeeded');assert.equal(puts,0);assert.equal(canceled,true);
});
test('PNG and PDF invalid signatures rejected with matching MIME before network',async()=>{
 for(const [filename,mime] of [['bad.png','image/png'],['bad.pdf','application/pdf']]){const h=harness();h.ctx.blobs.get=async()=>({size:6,httpMetadata:{contentType:mime},body:new Blob(['broken']).stream()});const r=await invoke('kb',{...uploadQ,filename},h.ctx);assert.equal(r.status,'invalid_input');assert.equal(r.message,'invalid_file_signature');assert.equal(h.calls.length,0);}
});
test('reconcile accepts serialized local receipt shape without replacing recorded ID',async()=>{
 const h=harness({get_knowledge_base:b=>{assert.deepEqual(b.ids,['recorded']);return ok({infos:{recorded:{id:'recorded',name:'Saved'}}});}}, {receipt:JSON.stringify({status:'unknown',resource:{kb_id:'recorded',name:'Saved'},receipt:{stages:{create_knowledge_base:'recorded'}}})});
 const r=await invoke('kb',{action:'kb.create',name:'Ignored',kb_id:'ignored',reconcile:true,request_id:'reconcile'},h.ctx);assert.equal(r.status,'succeeded');
});
test('declared oversized media cancels body before downloading or storing',async()=>{
 let canceled=false;const h=harness({get_media_info:()=>ok({media_type:1,url_info:{url:'https://res-skb.ima.qq.com/raw'}}),raw:()=>new Response(new ReadableStream({cancel(){canceled=true;}}),{headers:{'content-length':String(201*1024*1024)}})});
 const r=await invoke('kb',{action:'media.read',media_id:'m'},h.ctx);assert.equal(r.status,'unavailable');assert.equal(canceled,true);assert.equal(h.objects.size,0);
});
test('real runOperation merges staged IDs and hashes and reconcile does not create twice',async()=>{
 const {runOperation}=await import('../worker/storage.js');const data=new Map(),locks=new Map();
 const store={get:async(c,k)=>structuredClone(data.get(c+':'+k)??null),put:async(c,k,v)=>{data.set(c+':'+k,structuredClone(v));},create:async(c,k,v)=>{const key=c+':'+k;if(data.has(key))return false;data.set(key,structuredClone(v));return true;},compareAndSwap:async(c,k,old,v)=>{const key=c+':'+k;if(JSON.stringify(data.get(key))!==JSON.stringify(old))return false;data.set(key,structuredClone(v));return true;},acquireLock:async(k,r)=>{if(locks.has(k)&&locks.get(k)!==r)return false;locks.set(k,r);return true;},releaseLock:async(k,r)=>{if(locks.get(k)===r)locks.delete(k);}};
 let ready=false;const h=harness({import_doc:()=>ok({note_id:'n1'}),get_doc_content:()=>ready?ok({content:'hello'}):new Response('',{status:503})});const ctx={...h.ctx,store,provider:module.invokeIma};
 const q={action:'create',content:'hello',execute:true,request_id:'real-storage'};
 const first=await runOperation('notes',q,ctx);assert.equal(first.status,'verification_pending');const record=await store.get('operations',q.request_id);assert.equal(record.state.resource.note_id,'n1');assert.equal(record.state.receipt.expected_compact_sha256,sha('hello'));
 const replay=await runOperation('notes',q,ctx);assert.equal(replay.status,'verification_pending');ready=true;
 const recovered=await runOperation('notes',{...q,reconcile:true},ctx);assert.equal(recovered.status,'succeeded');assert.equal(h.calls.filter(x=>x.path==='import_doc').length,1);assert.equal(locks.size,0);
});
test('provider cannot echo IMA credentials into a source URL or COS token',async()=>{
 const h=harness({get_media_info:()=>ok({media_type:1,url_info:{url:'https://res-skb.ima.qq.com/raw?token=mock-secret'}})});const r=await invoke('kb',{action:'media.read',media_id:'m'},h.ctx);assert.equal(r.status,'unavailable');assert.equal(h.calls.length,1);
 const upload=uploadHarness();upload.cred.token='mock-secret';const result=await invoke('kb',uploadQ,upload.ctx);assert.equal(result.status,'unknown');assert.ok(!upload.calls.some(x=>x.path==='object'));
});
test('notes search preserves title/default and body search_type with matching query_info',async()=>{
 for(const searchType of [undefined,0,1]){
  const h=harness({search_note:b=>{assert.equal(b.search_type,searchType??0);assert.deepEqual(b.query_info,searchType===1?{content:'关键词'}:{title:'关键词'});assert.equal(b.start,5);assert.equal(b.end,15);return ok({search_note_infos:[{note_book_info:{note_id:'n1',title:'标题'}}],is_end:true});}});
  const r=await invoke('notes',{action:'search',query:'关键词',start:5,limit:10,...(searchType===undefined?{}:{search_type:searchType})},h.ctx);assert.equal(r.status,'succeeded');assert.equal(r.data.items[0].note_id,'n1');
 }
});
test('notes search rejects search_type outside numeric 0/1 before any network call',async()=>{
 for(const searchType of [-1,2,1.5,'1',null,true,NaN]){
  const h=harness({search_note:()=>ok({search_note_infos:[],is_end:true})});
  const r=await invoke('notes',{action:'search',query:'关键词',search_type:searchType},h.ctx);assert.equal(r.status,'invalid_input');assert.equal(h.calls.length,0);
 }
});
test('FixedLengthStream R2 upload awaits delayed source EOF before checking done',async()=>{
 const previous=globalThis.FixedLengthStream;globalThis.FixedLengthStream=class extends TransformStream{constructor(){super();}};
 try{
  let sent=false,eof=false;const bytes=new TextEncoder().encode('pdf');
  const h=harness({get_media_info:()=>ok({media_type:1,url_info:{url:'https://res-skb.ima.qq.com/raw'}}),raw:()=>new Response(new ReadableStream({async pull(c){if(!sent){sent=true;c.enqueue(bytes);}else{await new Promise(r=>setTimeout(r,25));eof=true;c.close();}}},{highWaterMark:0}),{headers:{'content-type':'application/pdf','content-length':'3'}})});
  h.ctx.blobs.put=async(key,body)=>{const reader=body.getReader();const first=await reader.read();h.objects.set(key,first.value);reader.releaseLock();};
  const r=await invoke('kb',{action:'media.export',media_id:'m',execute:true,request_id:'eof-race'},h.ctx);assert.equal(r.status,'succeeded');assert.equal(eof,true);
 }finally{globalThis.FixedLengthStream=previous;}
});
test('FixedLengthStream error paths await pipe abort cleanup for both R2 and COS',async()=>{
 const previous=globalThis.FixedLengthStream;
 try{
  for(const target of ['R2','COS']){
   let settled=false;
   globalThis.FixedLengthStream=class {constructor(){this.readable=new ReadableStream();this.writable=new WritableStream({write:()=>new Promise(r=>setTimeout(r,10)),async abort(){await new Promise(r=>setTimeout(r,20));settled=true;}});}};
   const h=target==='COS'?uploadHarness(undefined,{object:()=>{throw Error('mock COS error');}}):harness({get_media_info:()=>ok({media_type:1,url_info:{url:'https://res-skb.ima.qq.com/raw'}}),raw:()=>new Response('pdf',{headers:{'content-length':'3'}})});
   if(target==='R2')h.ctx.blobs.put=async()=>{throw Error('mock R2 error');};
   const r=await invoke('kb',target==='COS'?uploadQ:{action:'media.export',media_id:'m',execute:true,request_id:'cleanup'},h.ctx);assert.equal(r.status,'unknown');assert.equal(settled,true,target+' must await pipe cleanup');
  }
 }finally{globalThis.FixedLengthStream=previous;}
});
