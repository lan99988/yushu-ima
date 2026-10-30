import {DatabaseSync} from 'node:sqlite';
export function runtime(database=':memory:'){
 const db=new DatabaseSync(database);db.exec('CREATE TABLE IF NOT EXISTS documents(collection TEXT NOT NULL,document_key TEXT NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(collection,document_key))');
 const DB={prepare(sql){let args=[];return {bind(...v){args=v;return this;},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return {meta:{changes:Number(r.changes)}};}};}};
 const objects=new Map();
 const BUCKET={async put(key,body,options={}){let bytes;if(typeof body==='string')bytes=new TextEncoder().encode(body);else if(body?.getReader)bytes=new Uint8Array(await new Response(body).arrayBuffer());else bytes=new Uint8Array(body);objects.set(key,{bytes,options});},async get(key){const row=objects.get(key);if(!row)return null;const bytes=row.bytes;return {size:bytes.length,httpMetadata:row.options.httpMetadata,body:new Blob([bytes]).stream(),text:async()=>new TextDecoder().decode(bytes),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};},async delete(key){objects.delete(key);}};
 return {DB,BUCKET,objects,close:()=>db.close(),IMA_OPENAPI_CLIENTID:'client-test',IMA_OPENAPI_APIKEY:'key-test',IMA_CLOUD_BRIDGE_TOKEN:'bridge-test'};
}
