import RELEASE from '../assets/governance-1.1.0.json' with {type:'json'};
import {settings,sha,packed,fail} from './governance.js';
import {withShortLease} from './storage.js';

// Release policy bytes are packed(policy, 2) + LF, shared with the local client.
export const policyRelease=RELEASE;

async function freezeLegacyReservations(ctx,scope,snapshot){
 for(const collection of ['governance_requests','governance_reservations']){
  let cursor='';const seen=new Set();
  do{
   const page=await ctx.store.list(collection,{prefix:scope+':',limit:100,cursor});
   for(const {key,value} of page.items){
    if(value.transaction_snapshot)continue;
    if(!await ctx.store.compareAndSwap(collection,key,value,{...value,signature_version:'1.0',transaction_snapshot:snapshot}))fail('reservation_changed_during_upgrade','conflict');
   }
   if(!page.has_more)break;
   if(!page.next_cursor||seen.has(page.next_cursor))fail('reservation_pagination_invalid','unavailable');
   cursor=page.next_cursor;seen.add(cursor);
  }while(true);
 }
}

export async function upgradePolicy(ctx){
 try{
  const initial=await settings(ctx);
  return await withShortLease(ctx,'governance:'+initial.scope,async ctx=>{
   const {p,b,policy_sha256,scope}=await settings(ctx);
   if(p.policy_version==='1.1.0')return {status:'succeeded',policy_version:p.policy_version,policy_sha256,replayed:true};
   if(p.policy_version!=='1.0.0')fail('unsupported_policy_upgrade','conflict');
   if(await sha(packed(RELEASE.policy,2)+'\n')!==RELEASE.policy_sha256)fail('release_asset_checksum_mismatch','unavailable');
   const previous={policy:p,bindings:b,policy_sha256};
   const oldId='1.0.0:'+await sha(packed(previous));
   const next={policy:RELEASE.policy,bindings:{...b,policy_version:'1.1.0'},policy_sha256:RELEASE.policy_sha256,previous_release_id:oldId};
   const releaseId='1.1.0:'+await sha(packed(next));
   for(const [key,value] of [[oldId,previous],[releaseId,next]]){
    if(!await ctx.store.create('policy_releases',key,value)&&packed(await ctx.store.get('policy_releases',key))!==packed(value))fail('immutable_policy_release_conflict','conflict');
   }
   // Must finish before the pointer is visible. A crash leaves a usable old policy.
   await freezeLegacyReservations(ctx,scope,previous);
   const oldActive=await ctx.store.get('settings','active');
   const active={policy_version:'1.1.0',policy_sha256:RELEASE.policy_sha256,release_id:releaseId};
   const switched=oldActive?await ctx.store.compareAndSwap('settings','active',oldActive,active):await ctx.store.create('settings','active',active);
   if(!switched)fail('active_policy_changed_during_upgrade','conflict');
   return {status:'succeeded',...active,previous_release_id:oldId};
  });
 }catch(e){return {status:e.status||'unavailable',message:e.status?e.message:'policy_upgrade_storage_error'};}
}
