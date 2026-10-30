import {sha256} from './storage.js';

const need=(ok,message,status='invalid_input')=>{if(!ok)throw Object.assign(Error(message),{status});};
const required=(s,key,max=16000)=>need(typeof s==='string'&&s.trim()&&s.isWellFormed()&&s.length<=max,key+'_required');
const safe=s=>s.replace(/[\\`*_[\]<>!]/g,'\\$&').replace(/[\r\n]+/g,' ');
const prose=s=>s.replace(/[\\`*_[\]<>!]/g,'\\$&');
function mime(bytes){
 if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b))return 'image/png';
 if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(bytes.length>=12&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP')return 'image/webp';
 need(false,'image_format_requires_png_jpeg_webp');
}
function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}

// All bytes stay in the same private artifact. No public hosting or signed URL.
// Persisted bytes do not prove that ima's reader renders data URIs.
export async function prepareImages(q,ctx,old){
 need(q.images===undefined||Array.isArray(q.images),'images_must_be_array');
 const supplied=q.images||[];need(supplied.length<=20,'image_count_limit');
 if(q.mode==='archive'){need(!supplied.length,'archive_images_require_original_container','blocked');return {images:[],writes:[],body:q.entry?.body};}
 const images=new Map((old?.images||[]).map(x=>[x.image_id,x]));const writes=[];let total=0;
 for(const input of supplied){
  need(input&&typeof input==='object'&&!Array.isArray(input),'image_required');
  need(typeof input.image_id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(input.image_id),'image_id_invalid');
  need(!writes.some(x=>x.image_id===input.image_id),'duplicate_image_id');
  for(const key of ['blob_id','source_id','locator','caption','language'])required(input[key],'image_'+key,4000);
  need(input.source_id===q.material.source_id||(old?.materials||[]).some(m=>m.source_id===input.source_id),'image_source_not_registered');
  need(input.position==='{{image:'+input.image_id+'}}','image_position_requires_matching_marker');
  need(/^[a-f0-9]{64}$/.test(input.sha256||''),'image_sha256_required');
  need(['checked','needs_review'].includes(input.review_status),'image_review_status_required');
  need(typeof input.ocr_text==='string'&&input.ocr_text.isWellFormed()&&input.ocr_text.length<=50000,'image_ocr_text_required');
  need(typeof input.translation==='string'&&input.translation.isWellFormed()&&input.translation.length<=50000,'image_translation_required');
  if(!['zh','zh-CN','zh-TW','none'].includes(input.language))required(input.translation,'image_translation',50000);
  if(input.language==='none')need(input.ocr_text===''&&input.translation==='','no_text_image_has_text');
  const blob=await ctx.blobs.get(input.blob_id);need(blob,'image_blob_missing');
  need(blob.size>0&&blob.size<=4*1024*1024,'image_size_limit');
  const bytes=new Uint8Array(await blob.arrayBuffer());need(await sha256(bytes)===input.sha256,'image_hash_mismatch','conflict');
  const content_type=mime(bytes),blob_key='knowledge-images/'+input.sha256;
  const image=Object.fromEntries(['image_id','sha256','source_id','locator','caption','language','position','ocr_text','translation','review_status'].map(k=>[k,input[k]]));
  images.set(input.image_id,{...image,blob_key,content_type,size:bytes.length});writes.push({image_id:input.image_id,blob_key,bytes,content_type});
 }
 need(images.size<=20,'image_count_limit');
 let body=q.entry.body;
 need(!/!\[[^\]]*\]\s*[\[(]|<img\b/i.test(body),'unmanaged_image_reference_requires_images_contract','blocked');
 for(const image of images.values()){
  total+=image.size;need(total<=6*1024*1024,'total_image_size_limit');
  const marker=image.position;need(body.split(marker).length===2,'image_marker_must_appear_once:'+image.image_id,'blocked');
  need(body.split('\n').some(line=>line.trim()===marker),'image_marker_requires_own_paragraph','blocked');
  let fence=null;for(const line of body.slice(0,body.indexOf(marker)).split('\n')){const m=line.match(/^\s*(`{3,}|~{3,})/);if(m){if(!fence)fence=m[1][0];else if(m[1][0]===fence)fence=null;}}
  need(!fence,'image_marker_inside_code_block','blocked');
  const bytes=writes.find(x=>x.image_id===image.image_id)?.bytes||new Uint8Array(await (await ctx.blobs.get(image.blob_key))?.arrayBuffer()||[]);
  need(bytes.length===image.size&&await sha256(bytes)===image.sha256,'retained_image_original_missing','verification_pending');
  const block='\n\n!['+safe(image.caption)+'](data:'+image.content_type+';base64,'+base64(bytes)+')\n\n'+safe(image.caption)+'\n\n'+(image.translation?'**中文译文**\n\n'+prose(image.translation)+'\n\n':'')+(image.ocr_text?'**图中文字原文**\n\n'+prose(image.ocr_text)+'\n\n':'')+'来源：'+safe(image.source_id)+'；定位：'+safe(image.locator)+'；图片SHA256：'+image.sha256+'\n\n';
  body=body.replace(marker,()=>block);
 }
 need(!/\{\{image:[^}]+\}\}/.test(body),'unresolved_image_marker','blocked');
 return {images:[...images.values()],writes,body};
}

export function imageDisplayVerified(proof,object,account){return !!(proof&&proof.renderer_version==='1'&&proof.format==='markdown_data_uri'&&proof.reopened===true&&proof.image_and_translation_visible===true&&proof.media_id&&proof.content_sha256&&proof.checked_at&&proof.account_sha256&&(!account||proof.account_sha256===account)&&(!object||object.images.every(i=>i.review_status==='checked')));}
