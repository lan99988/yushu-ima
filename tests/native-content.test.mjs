import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../worker/native-content.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});

test('native content inspection is read-only and never returns ephemeral credentials',async()=>{
 assert.equal(typeof api.inspectContentProtocol,'function');const calls=[];
 const current={account_info:{userId:'synthetic-user',token:'access-secret',refreshToken:'refresh-secret',idType:2,tokenType:14}};
 const ctx={nativeFetcher:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});if(url.endsWith('/get_knowledge'))return Response.json({code:0,knowledge:{media_id:'file-1',title:'test.md',parent_folder_id:'folder-a',file_info:{cos_key:'original-object'}}});if(url.endsWith('/get_upload_credential_by_media'))return Response.json({code:0,cos_credential:{secret_id:'cos-id',secret_key:'cos-secret',token:'cos-token',cos_key:'original-object'}});return Response.json({code:0,media:{media_id:'file-1',file_info:{cos_key:'original-object'}}});}};
 const result=await api.inspectContentProtocol(ctx,current,'12345678','file-1');
 assert.equal(result.knowledge.media_id,'file-1');assert.equal(result.upload_credential_available,true);assert.equal(result.same_original_object,true);
 assert.equal(calls.length,3);assert.ok(calls.every(c=>!/replace|del_|create|parse|put/.test(c.url)));
 const output=JSON.stringify(result);for(const secret of ['access-secret','refresh-secret','cos-id','cos-secret','cos-token','original-object'])assert.ok(!output.includes(secret));
});

test('native content inspection stops before requesting credentials when identity does not match',async()=>{
 const calls=[];const current={account_info:{userId:'synthetic-user',token:'access-secret',refreshToken:'refresh-secret',idType:2,tokenType:14}};
 const result=await api.inspectContentProtocol({nativeFetcher:async(url)=>{calls.push(url);return Response.json({code:0,knowledge:{media_id:'different-file'}});}},current,'12345678','file-1');
 assert.equal(result.status,'blocked');assert.equal(calls.length,1);
});

test('nested success codes must be numeric and consistent before trusting native response data',async()=>{
 const current={account_info:{userId:'synthetic-user',token:'access-secret',refreshToken:'refresh-secret',idType:2,tokenType:14}};
 for(const code of [9,null,'0']){const r=await api.nativeContentRead({nativeFetcher:async()=>Response.json({code:0,data:{code,knowledge:{media_id:'file-1'}}})},current,'knowledge',{media_id:'file-1'});assert.equal(r.status,'unavailable');}
});
