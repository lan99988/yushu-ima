import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/app.js';

test('MCP initialization teaches other agents the current ingest and consolidation routes',async()=>{
 const request=new Request('https://service.example/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26'}})});
 const response=await worker.fetch(request,{}),body=await response.json();
 assert.equal(body.result.serverInfo.version,'2.6.1');
 assert.match(body.result.instructions,/ima_knowledge_ingest/);
 assert.match(body.result.instructions,/ima_knowledge_consolidate/);
 assert.match(body.result.instructions,/reconcile/);
 assert.match(body.result.instructions,/确认/);
});
