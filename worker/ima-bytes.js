// Bounded streaming SHA-256. WebCrypto supplies API/content hashes and COS HMAC;
// its digest API is not incremental, so large R2 objects use this FIPS 180-4 core.
const K=Uint32Array.from([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const rr=(x,n)=>(x>>>n)|(x<<(32-n));
export class Sha256 {
 constructor(){this.h=Uint32Array.from([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);this.block=new Uint8Array(64);this.w=new Uint32Array(64);this.used=0;this.size=0;}
 compress(input,offset=0){const w=this.w;for(let i=0;i<16;i++){const j=offset+i*4;w[i]=(input[j]<<24)|(input[j+1]<<16)|(input[j+2]<<8)|input[j+3];}for(let i=16;i<64;i++){const a=w[i-15],b=w[i-2];w[i]=w[i-16]+(rr(a,7)^rr(a,18)^(a>>>3))+w[i-7]+(rr(b,17)^rr(b,19)^(b>>>10));}let [a,b,c,d,e,f,g,h]=this.h;for(let i=0;i<64;i++){const t1=(h+(rr(e,6)^rr(e,11)^rr(e,25))+((e&f)^(~e&g))+K[i]+w[i])>>>0;const t2=((rr(a,2)^rr(a,13)^rr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}for(const [i,x] of [a,b,c,d,e,f,g,h].entries())this.h[i]+=x;}
 update(bytes){this.size+=bytes.length;let i=0;if(this.used){const n=Math.min(64-this.used,bytes.length);this.block.set(bytes.subarray(0,n),this.used);this.used+=n;i=n;if(this.used===64){this.compress(this.block);this.used=0;}}for(;i+64<=bytes.length;i+=64)this.compress(bytes,i);if(i<bytes.length){this.block.set(bytes.subarray(i));this.used=bytes.length-i;}return this;}
 hex(){const bits=this.size*8;this.block[this.used++]=128;if(this.used>56){this.block.fill(0,this.used);this.compress(this.block);this.used=0;}this.block.fill(0,this.used,56);const v=new DataView(this.block.buffer);v.setUint32(56,Math.floor(bits/0x100000000));v.setUint32(60,bits>>>0);this.compress(this.block);return [...this.h].map(v=>v.toString(16).padStart(8,'0')).join('');}
}
export const MAX_BYTES=200*1024*1024;
export async function scan(stream,{limit=MAX_BYTES,expectedSize,collect=false,text=false}={}){
 if(!stream?.getReader)throw Error('missing_stream');
 const reader=stream.getReader(),hash=new Sha256(),head=new Uint8Array(65536),parts=[];
 const decoder=text?new TextDecoder('utf-8',{fatal:true}):null;let size=0,headSize=0;
 try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Error('size_limit_exceeded');hash.update(value);const n=Math.min(head.length-headSize,value.length);head.set(value.subarray(0,n),headSize);headSize+=n;if(collect)parts.push(value);if(decoder){const s=decoder.decode(value,{stream:true});if(s.includes('\u0000'))throw Error('invalid_text_signature');}}if(decoder)decoder.decode();if(expectedSize!==undefined&&size!==expectedSize)throw Error('size_mismatch');}
 catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
 return {size,sha256:hash.hex(),head:head.subarray(0,headSize),...(collect?{bytes:await new Blob(parts).arrayBuffer()}: {})};
}
export function measured(stream,{size,sha256,limit=MAX_BYTES}){
 const reader=stream.getReader(),hash=new Sha256();let count=0;const result={done:false};
 result.stream=new ReadableStream({async pull(controller){try{const r=await reader.read();if(r.done){if(count!==size||hash.hex()!==sha256)throw Error('blob_changed');result.done=true;controller.close();reader.releaseLock();return;}count+=r.value.length;if(count>limit||count>size)throw Error('size_limit_exceeded');hash.update(r.value);controller.enqueue(r.value);}catch(e){await reader.cancel().catch(()=>{});controller.error(e);}},cancel(reason){return reader.cancel(reason);}});
 return result;
}
