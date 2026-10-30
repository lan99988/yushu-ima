import {stable,withShortLease} from './storage.js';

// Library -> card -> entry-governance is the lock order. Nested governance
// commits reuse the caller's fenced library lease instead of acquiring it again.
export async function withMovePublicationLease(ctx,kb_id,fn){
 const key='governance:directory-plans:'+kb_id;
 const physical=(ctx.baseStore&&ctx.workspace==='isolated'?'test:':'')+key;
 const held=ctx.leaseFences?.find(x=>x.key===physical);
 if(held){await (ctx.baseStore||ctx.store).touchLease(held);return fn(ctx);}
 return withShortLease(ctx,key,fn);
}
const locationKey=(kb_id,media_id)=>stable({kb_id,media_id});
export async function resolveCurrentContent(ctx,kb_id,media_id){
 const seen=new Set();let id=media_id,result=null,alias=false;
 for(let depth=0;depth<128;depth++){
  if(seen.has(id))throw Object.assign(Error('ima_replacement_projection_cycle'),{status:'verification_pending'});seen.add(id);
  const next=await ctx.store.get('media_content_states',locationKey(kb_id,id));
  if(!next){if(alias)throw Object.assign(Error('ima_replacement_projection_missing_target'),{status:'verification_pending'});return result;}
  if(next.kb_id&&next.kb_id!==kb_id||typeof next.media_id!=='string'||!next.media_id)throw Object.assign(Error('ima_replacement_projection_identity_invalid'),{status:'verification_pending'});
  result={...result,...next};
  if(next.state==='replaced'){alias=true;id=next.media_id;continue;}
  if(next.state==='current')return {...result,state:alias?'replaced':'current'};
  if(next.state==='deleted_from_knowledge_base')return result;
  throw Object.assign(Error('ima_replacement_projection_state_invalid'),{status:'verification_pending'});
 }
 throw Object.assign(Error('ima_replacement_projection_limit'),{status:'verification_pending'});
}
export async function projectCurrentLocation(ctx,row,kb_id,media_id=row.media_id){
 let content=await resolveCurrentContent(ctx,kb_id,media_id);
 if(!content&&row.current_content?.state==='replaced'){const target=await resolveCurrentContent(ctx,kb_id,row.current_content.media_id);if(target)content={...row.current_content,...target,state:target.state==='current'?'replaced':target.state};}
 const location=await ctx.store.get('media_locations',locationKey(kb_id,content?.state==='replaced'?content.media_id:media_id));
 let current=row;
 if(location&&stable(row.current_location)!==stable(location))current={...current,current_location:location};
 if(content&&stable(row.current_content)!==stable(content))current={...current,current_content:content};
 return current;
}

export async function collectionRows(ctx,collection){
 const rows=[];let cursor='';const seen=new Set();
 do{const page=await ctx.store.list(collection,{limit:100,cursor});rows.push(...page.items);if(!page.has_more)break;if(!page.next_cursor||seen.has(page.next_cursor))throw Error('move_index_pagination_incomplete');seen.add(page.next_cursor);cursor=page.next_cursor;}while(true);
 return rows;
}

// Publication folder_id/directory_snapshot, reviewed metadata and immutable R2
// snapshots describe historical evidence. Only current_location is a projection.
export async function synchronizeMoveIndex(ctx,operation,locations){
 return withMovePublicationLease(ctx,operation.kb_id,async ctx=>{
 const byId=new Map(locations.map(x=>[x.media_id,x]));
 // This projection survives missing/delayed publication rows and partial scans.
 for(const location of locations)await ctx.store.put('media_locations',locationKey(operation.kb_id,location.media_id),{...location,kb_id:operation.kb_id,request_id:operation.request_id,verified_at:operation.verified_at});
 for(const {key,value} of await collectionRows(ctx,'directories')){
  const location=byId.get(value.directory_id);if(!location)continue;
  const next={...value,parent_folder_id:location.folder_id,primary_category:location.primary_category,path:location.path,depth:location.path.length,verified_at:operation.verified_at,last_move_request_id:operation.request_id};
  if(stable(value)!==stable(next)&&!await ctx.store.compareAndSwap('directories',key,value,next))throw Error('move_directory_sync_conflict');
 }
 for(const collection of ['governance_index','cards']){
  for(const {key,value} of await collectionRows(ctx,collection)){
   const content=await resolveCurrentContent(ctx,operation.kb_id,value.media_id);
   const location=byId.get(content?.state==='replaced'?content.media_id:value.current_content?.state==='replaced'?value.current_content.media_id:value.media_id);if(!location)continue;
   const current_location={...location,kb_id:operation.kb_id,request_id:operation.request_id,verified_at:operation.verified_at};
   const next={...value,current_location};
   if(stable(value)!==stable(next)&&!await ctx.store.compareAndSwap(collection,key,value,next))throw Error('move_current_location_sync_conflict');
  }
 }
 // A route governs a future publication. Preserve an explicit cross-category
 // choice; moving a historical file never changes its reviewed classification.
 return {status:'succeeded',locations:locations.length};
 });
}
