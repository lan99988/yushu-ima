import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{dispatch,TOOLS} from '../worker/index.js';
import app from '../worker/app.js';
test('conventional entry is the actual production implementation',()=>assert.equal(worker,app));
test('production tools preserve card workflow, protected writes and deterministic hashing',async()=>{
 assert.ok(TOOLS.find(t=>t.name==='ima_card_publish'));
 assert.ok(TOOLS.find(t=>t.name==='ima_upload_file').inputSchema.required.includes('request_id'));
 const r=await dispatch('ima_hash_text',{content:'中文'},{});
 assert.equal(r.sha256,'72726d8818f693066ceb69afa364218b692e62ea92b385782363780f47529c21');
});
test('unauthenticated production MCP calls cannot dispatch writes',async()=>{
 const r=await worker.fetch(new Request('https://site.test/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ima_create_note',arguments:{content:'x',request_id:'r'}}})}),{});
 assert.equal(r.status,401);
});
