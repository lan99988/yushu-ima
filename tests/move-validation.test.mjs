import test from 'node:test';
import assert from 'node:assert/strict';
const module=await import('../worker/move-validation.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const file=(id,path,parent)=>({media_id:id,title:id,kind:'file',folder_id:parent,path,sha256:'a'.repeat(64),size:1});
const folder=(id,path,parent)=>({media_id:id,title:id,kind:'folder',folder_id:parent,path});
const path=id=>({directory_id:id,name:id});
function pair(rows){const source=[path('03')],destination=[path('04')];const snapshot={source_folder_id:'03',destination_folder_id:'04',source_path:source,destination_path:destination,media_ids:['top'],manifest:rows};const back=structuredClone(snapshot);back.source_folder_id='04';back.destination_folder_id='03';back.source_path=destination;back.destination_path=source;back.manifest=rows.map(x=>({...x,folder_id:x.media_id==='top'?'04':x.folder_id,path:[...destination,...x.path.slice(1)]}));return [{request_id:'a',created_at:'1',snapshot},{request_id:'b',created_at:'2',snapshot:back}];}
test('four sibling folders cannot stand in for a four-level ancestor chain',()=>{
 assert.equal(typeof module.computeRoundtrips,'function');const rows=[folder('top',[path('03')],'03')];
 for(const id of ['a','b','c'])rows.push(folder(id,[path('03'),path('top')],'top'));
 rows.push(file('file',[path('03'),path('top'),path('a')],'a'));
 assert.equal(module.computeRoundtrips(pair(rows)).folder_roundtrip,false);
});
test('real four-level roundtrip passes, but a changed relative parent or ancestry fails',()=>{
 assert.equal(typeof module.computeRoundtrips,'function');const rows=[];let parent='03',chain=[path('03')];
 for(const id of ['top','a','b','c']){rows.push(folder(id,chain,parent));chain=[...chain,path(id)];parent=id;}
 rows.push(file('file',chain,parent));const ops=pair(rows);
 assert.equal(module.computeRoundtrips(ops).folder_roundtrip,true);
 ops[1].snapshot.manifest.at(-1).folder_id='top';ops[1].snapshot.manifest.at(-1).path=[path('04'),path('top')];
 assert.equal(module.computeRoundtrips(ops).folder_roundtrip,false);
});
