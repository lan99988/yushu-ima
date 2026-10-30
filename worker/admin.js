import {sha256,stable,withServiceControls} from './storage.js';
import {settings} from './governance.js';
export async function adminAction(q,ctx){
  if(['publication','begin','knowledge_policy','knowledge_image_acceptance'].includes(q.action)&&!ctx.serviceControlsHeld)return withServiceControls(ctx,controls=>adminAction(q,{...controls,store:controls.serviceControlStore,serviceControlsHeld:true}));
  const {store}=ctx;const action=q.action;
  if(action==='status')return {status:'succeeded',migration:await store.get('settings','migration'),service:await store.get('settings','service')};
  if(action==='knowledge_image_acceptance'){
    const isolated=scopedStore(store,'isolated'),op=await isolated.get('knowledge_operations',q.request_id),binding=await isolated.get('settings','bindings'),formal=await store.get('settings','bindings');
    if(!op?.object?.images?.length||op.receipt?.status!=='succeeded'||binding?.kb_id===formal?.kb_id||binding?.account_sha256!==formal?.account_sha256)return {status:'blocked',message:'isolated_image_receipt_required'};
    if(q.reopened!==true||q.image_and_translation_visible!==true||typeof q.checker!=='string'||!q.checker.trim()||!Array.isArray(q.observations)||q.observations.length!==2)return {status:'blocked',message:'actual_reader_and_reopen_observations_required'};
    const observations=[];
    for(const observation of q.observations){const blob=typeof observation.blob_id==='string'&&await ctx.blobs.get(observation.blob_id);if(!blob||blob.size<=0||blob.size>8*1024*1024||await sha256(new Uint8Array(await blob.arrayBuffer()))!==observation.sha256)return {status:'blocked',message:'reader_screenshot_evidence_missing'};observations.push({blob_id:observation.blob_id,sha256:observation.sha256});}
    if(observations[0].sha256===observations[1].sha256)return {status:'blocked',message:'distinct_reopen_observation_required'};
    const media_id=op.receipt.resource?.media_ids?.[0],read=await ctx.invoke('kb',{action:'media.read',media_id});
    let content=read.data?.content;if(read.status==='succeeded'&&typeof content!=='string'&&read.data?.blob_id){const blob=await ctx.blobs.get(read.data.blob_id);if(blob)content=await blob.text();}
    if(typeof content!=='string'||await sha256(content)!==await sha256(op.transport.content))return {status:'verification_pending',message:'inline_artifact_remote_readback_mismatch'};
    const proof={renderer_version:'1',format:'markdown_data_uri',request_id:q.request_id,media_id,content_sha256:await sha256(content),account_sha256:binding.account_sha256,kb_id:binding.kb_id,roots_hash:await sha256(stable(binding.categories)),reopened:true,image_and_translation_visible:true,checker:q.checker,observations,checked_at:new Date().toISOString()};
    await store.put('settings','knowledge_image_acceptance',proof);return {status:'succeeded',proof};
  }
  if(action==='knowledge_policy'){
    if(q.version!=='2.0.0'||typeof q.enabled!=='boolean')return {status:'invalid_input'};
    const proof=await scopedStore(store,'isolated').get('settings','knowledge_acceptance');
    if(q.enabled&&(!proof?.create||!proof.update||!proof.archive))return {status:'blocked',message:'knowledge_isolated_acceptance_required'};
    if(q.enabled){const isolated=await scopedStore(store,'isolated').get('settings','bindings'),formal=await store.get('settings','bindings');if(proof.kb_id!==isolated?.kb_id||proof.account_sha256!==isolated?.account_sha256||proof.roots_hash!==await sha256(stable(isolated?.categories))||isolated.kb_id===formal?.kb_id)return {status:'blocked',message:'knowledge_acceptance_binding_changed'};}
    const before=await store.get('settings','service');
    await store.put('settings','service',{...before,knowledge_v2_enabled:q.enabled,knowledge_v2_activated_at:before?.knowledge_v2_activated_at||new Date().toISOString(),knowledge_policy_version:'2.0.0'});
    return {status:'succeeded',knowledge_v2_enabled:q.enabled,knowledge_policy_version:'2.0.0'};
  }
  if(action==='policy_upgrade'){
    const target=q.workspace==='isolated'?{...ctx,workspace:'isolated',store:scopedStore(store,'isolated')}:ctx;
    const {upgradePolicy}=await import('./governance.js');return upgradePolicy(target);
  }
  if(action==='backup'){
    const collections=['settings','operations','locks','governance_index','governance_requests','governance_reservations','cards','card_tasks','card_history','card_routes','card_dispatches','directories','directory_plans','directory_plan_history','policy_releases','governance_snapshots','knowledge_objects','knowledge_history','knowledge_operations','knowledge_transports'];
    const documents=[];for(const collection of collections){let cursor='';do{const page=await store.list(collection,{limit:200,cursor});documents.push(...page.items.map(x=>({collection,...x})));cursor=page.has_more?page.next_cursor:'';}while(cursor);}
    return {status:'succeeded',exported_at:new Date().toISOString(),documents};
  }
  if(action==='begin'){
    if(typeof q.migration_id!=='string'||!q.migration_id||!q.manifest_hash)return {status:'invalid_input',message:'migration_id_and_manifest_hash_required'};
    const previous=await store.get('migrations',q.migration_id);
    if(previous&&previous.manifest_hash!==q.manifest_hash)return {status:'conflict',message:'migration_id_reused'};
    const value={migration_id:q.migration_id,manifest_hash:q.manifest_hash,status:'importing',started_at:previous?.started_at||new Date().toISOString()};
    await store.put('migrations',q.migration_id,value);await store.put('settings','migration',{...value,frozen:true});return {status:'succeeded',migration:value};
  }
  if(action==='isolated_settings'){
    const isolated={...ctx,workspace:'isolated',store:scopedStore(store,'isolated')};
    if(q.policy)await isolated.store.put('settings','policy',q.policy);
    if(q.active)await isolated.store.put('settings','active',q.active);
    if(q.bindings)await isolated.store.put('settings','bindings',q.bindings);
    try{await settings(isolated);}catch(e){return {status:e.status||'invalid_input',message:e.message};}
    await isolated.store.put('settings','service',{publication_enabled:true,isolated:true});return {status:'succeeded'};
  }
  if(action==='publication'){
    if(typeof q.enabled!=='boolean')return {status:'invalid_input'};
    if(q.enabled)await settings(ctx);
    await store.put('settings','service',{...await store.get('settings','service'),publication_enabled:q.enabled});return {status:'succeeded',publication_enabled:q.enabled};
  }
  if(action==='recover_preflight'){
    const op=await store.get('operations',q.request_id);
    if(op?.status!=='unavailable'||op.running_until>Date.now()||op.state?.stage||Object.keys(op.state?.receipt?.stages||{}).length)return {status:'conflict',message:'cannot_prove_pre_dispatch_failure'};
    const next={...op,status:'reserved',dispatched_at:null,recovery_history:[...(op.recovery_history||[]),{status:op.status,at:new Date().toISOString(),reason:'verified_no_write_intent_record'}]};
    if(!await store.compareAndSwap('operations',q.request_id,op,next))return {status:'conflict'};
    return {status:'succeeded',request_id:q.request_id,message:'仅恢复原请求，不执行外部写入'};
  }
  const migration=await store.get('settings','migration');
  if(!migration?.frozen||migration.migration_id!==q.migration_id)return {status:'conflict',message:'matching_frozen_migration_required'};
  if(action==='settings'){
    for(const name of ['policy','active','bindings'])if(!q[name])return {status:'invalid_input',message:name+'_required'};
    const before=await store.get('settings','bindings');
    if(before&&(before.account_sha256!==q.bindings.account_sha256||before.kb_id!==q.bindings.kb_id))return {status:'conflict',message:'existing_account_or_library_mismatch'};
    if(await sha256(ctx.env.IMA_OPENAPI_CLIENTID)!==q.bindings.account_sha256)return {status:'conflict',message:'credential_account_mismatch'};
    await store.put('settings','policy',q.policy);await store.put('settings','active',q.active);await store.put('settings','bindings',q.bindings);
    await settings(ctx);return {status:'succeeded'};
  }
  if(action==='operations'){
    if(!Array.isArray(q.rows)||q.rows.length>200)return {status:'invalid_input'};
    let imported=0;
    for(const row of q.rows){
      if(typeof row.request_id!=='string'||!/^[a-f0-9]{64}$/.test(row.fingerprint)||typeof row.resource_key!=='string')return {status:'invalid_input',message:'invalid_operation_row'};
      const old=await store.get('operations',row.request_id);
      if(old){if(old.fingerprint!==row.fingerprint)return {status:'conflict',request_id:row.request_id};continue;}
      let receipt=row.receipt;if(typeof receipt==='string'){try{receipt=JSON.parse(receipt);}catch{return {status:'invalid_input',message:'invalid_receipt'};}}
      const record={...row,receipt,state:{resource:receipt?.resource,receipt:receipt?.receipt||{}},migrated:true,migration_id:q.migration_id,created_at:row.updated};
      await store.create('operations',row.request_id,record);imported++;
    }
    return {status:'succeeded',imported};
  }
  if(action==='locks'){
    for(const row of q.rows||[]){if(typeof row.resource_key!=='string'||typeof row.request_id!=='string')return {status:'invalid_input'};if(!await store.acquireLock(row.resource_key,row.request_id))return {status:'conflict',message:'lock_owner_mismatch'};}
    return {status:'succeeded'};
  }
  if(action==='document'){
    const allowed=new Set(['migration_artifacts','legacy_index','legacy_tasks','legacy_cards','legacy_reviews']);
    if(!allowed.has(q.collection)||typeof q.key!=='string'||!q.value)return {status:'invalid_input'};
    const old=await store.get(q.collection,q.key);if(old&&stable(old)!==stable(q.value))return {status:'conflict',message:'legacy_record_mismatch'};
    await store.create(q.collection,q.key,q.value);return {status:'succeeded'};
  }
  if(action==='finish'){
    await settings(ctx);
    const ops=await store.db.prepare("SELECT COUNT(*) AS count FROM documents WHERE collection='operations'").first();
    if(q.expected_operations!==undefined&&ops.count!==q.expected_operations)return {status:'conflict',message:'operation_count_mismatch',actual:ops.count};
    await store.put('settings','service',{ready:true,publication_enabled:false});
    const done={...migration,status:'completed',frozen:false,finished_at:new Date().toISOString()};
    await store.put('settings','migration',done);await store.put('migrations',q.migration_id,done);return {status:'succeeded',migration:done};
  }
  return {status:'unsupported'};
}
export function scopedStore(base,workspace){
  if(workspace!=='isolated')return base;
  const name=c=>['operations','locks','blob_metadata'].includes(c)?c:'test_'+c;
  return {get:(c,k)=>base.get(name(c),k),put:(c,k,v)=>base.put(name(c),k,v),create:(c,k,v)=>base.create(name(c),k,v),remove:(c,k)=>base.remove(name(c),k),list:(c,o)=>base.list(name(c),o),compareAndSwap:(c,k,a,b)=>base.compareAndSwap(name(c),k,a,b),acquireLock:(k,r)=>base.acquireLock('test:'+k,r),releaseLock:(k,r)=>base.releaseLock('test:'+k,r)};
}
