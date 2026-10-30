import test from 'node:test';import assert from 'node:assert/strict';import {invokeIma} from '../worker/ima.js';
test('Worker native fetch keeps the platform global receiver',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=function(){assert.equal(this,globalThis);return Promise.resolve(Response.json({code:0,data:{note_folder_infos:[],is_end:true,next_cursor:'',need_update:false}}));};
 try{const r=await invokeIma('notes',{action:'list_notebooks'},{env:{IMA_OPENAPI_CLIENTID:'test',IMA_OPENAPI_APIKEY:'test'}});assert.equal(r.status,'succeeded',JSON.stringify(r));}
 finally{globalThis.fetch=original;}
});
