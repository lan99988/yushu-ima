import {sha256 as incremental} from '@noble/hashes/sha256';
export function blobAccess(bucket){
  if(!bucket)throw Error('私有文件存储尚未就绪');
  const safe=key=>{if(typeof key!=='string'||!key||key.includes('..')||key.startsWith('/')||key.length>1024)throw Error('invalid_blob_id');return key;};
  return {
    async get(key){return bucket.get(safe(key));},
    async put(key,bytes,options={}){return bucket.put(safe(key),bytes,{httpMetadata:{contentType:options.contentType||'application/octet-stream'}});},
    async remove(key){return bucket.delete(safe(key));}
  };
}
export async function uploadBlob(request,ctx){
  const url=new URL(request.url);const filename=url.searchParams.get('name')||'upload.bin';
  if(filename.length>255||/[\\/\x00-\x1f:*?"<>|]/.test(filename)||filename.endsWith('.')||filename.endsWith(' ')||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename))return {status:'invalid_input',message:'单个合法文件名必填'};
  const size=Number(request.headers.get('content-length'));
  if(!Number.isSafeInteger(size)||size<=0)return {status:'invalid_input',message:'Content-Length required'};
  if(size>200*1024*1024)return {status:'invalid_input',message:'file_limit_200MiB'};
  const expected=request.headers.get('x-content-sha256');
  if(expected&&!/^[a-f0-9]{64}$/.test(expected))return {status:'invalid_input',message:'invalid_sha256'};
  const blob_id='uploads/'+crypto.randomUUID();const hash=incremental.create();let count=0;
  const stream=request.body.pipeThrough(new TransformStream({transform(chunk,controller){count+=chunk.byteLength;if(count>size)throw Error('upload_size_mismatch');hash.update(chunk);controller.enqueue(chunk);}}));
  const content_type=request.headers.get('content-type')||'application/octet-stream';
  try {
    if(typeof FixedLengthStream!=='undefined'){
      const fixed=new FixedLengthStream(size);
      await Promise.all([stream.pipeTo(fixed.writable),ctx.blobs.put(blob_id,fixed.readable,{contentType:content_type})]);
    }else await ctx.blobs.put(blob_id,stream,{contentType:content_type});
    const digest=[...hash.digest()].map(x=>x.toString(16).padStart(2,'0')).join('');
    if(count!==size||expected&&digest!==expected){await ctx.blobs.remove(blob_id);return {status:'invalid_input',message:'upload_hash_or_size_mismatch'};}
    const metadata={blob_id,sha256:digest,size,filename,content_type,created_at:new Date().toISOString()};
    await ctx.store.put('blob_metadata',blob_id,metadata);
    return {status:'succeeded',...metadata};
  }catch(error){try{await ctx.blobs.remove(blob_id);}catch{}return {status:'failed',message:String(error.message)};}
}
