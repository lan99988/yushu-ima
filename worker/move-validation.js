import {stable} from './storage.js';

function relativeTree(snapshot){
 const top=new Set(snapshot.media_ids);
 return snapshot.manifest.map(row=>({...row,folder_id:top.has(row.media_id)?null:row.folder_id,path:row.path.slice(snapshot.source_path.length)})).sort((a,b)=>a.media_id.localeCompare(b.media_id));
}
export function computeRoundtrips(operations){
 let file_roundtrip=false,folder_roundtrip=false;const requests=[];
 for(const a of operations)for(const b of operations){
  if(a.request_id===b.request_id||a.created_at>b.created_at)continue;
  const x=a.snapshot,y=b.snapshot;
  if(x.source_folder_id!==y.destination_folder_id||x.destination_folder_id!==y.source_folder_id||stable(x.media_ids)!==stable(y.media_ids)||stable(x.source_path)!==stable(y.destination_path)||stable(x.destination_path)!==stable(y.source_path))continue;
  const original=relativeTree(x),returned=relativeTree(y);
  if(stable(original)!==stable(returned))continue;
  if(x.media_ids.length===1&&original.length===1&&original[0].kind==='file')file_roundtrip=true;
  const folders=new Set(original.filter(row=>row.kind==='folder').map(row=>row.media_id));
  const fourLevels=original.some(row=>row.kind==='file'&&row.path.length>=4&&row.path.every(p=>folders.has(p.directory_id)));
  if(x.media_ids.length===1&&fourLevels)folder_roundtrip=true;
  requests.push(a.request_id,b.request_id);
 }
 return {file_roundtrip,folder_roundtrip,request_ids:[...new Set(requests)]};
}
