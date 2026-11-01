// 完整读取条目原文并落盘：node read-card.mjs <media_id> <outfile>
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const token = fs.readFileSync(path.join(HERE, '.dev.vars'), 'utf8').match(/^IMA_CLOUD_BRIDGE_TOKEN=(.+)$/m)[1].trim();
const probe = (t = 400) => new Promise((r) => { const s = net.connect({host: '127.0.0.1', port: 8787}); const d = (o) => { s.destroy(); r(o); }; s.setTimeout(t); s.once('connect', () => d(true)); s.once('timeout', () => d(false)); s.once('error', () => d(false)); });
let child = null;
if (!await probe()) {
  child = spawn(process.execPath, [path.join(HERE, 'local-server.mjs')], {cwd: HERE, stdio: 'ignore', windowsHide: true});
  for (let i = 0; i < 40; i += 1) { await new Promise((r) => setTimeout(r, 250)); if (await probe(300)) break; }
}

const [mediaId, outFile] = process.argv.slice(2);
const res = await fetch('http://127.0.0.1:8787/bridge/v1/mcp', {
  method: 'POST', headers: {'content-type': 'application/json', 'x-ima-bridge-token': token},
  body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'ima_read_media', arguments: {media_id: mediaId}}}),
});
const j = await res.json();
const text = j?.result?.content?.[0]?.text ?? '';
let payload;
try { payload = JSON.parse(text); } catch { console.log('BAD JSON:', text.slice(0, 300)); if (child) child.kill(); process.exit(1); }
const content = payload?.data?.content ?? '';
fs.writeFileSync(outFile, content, 'utf8');
console.log('status:', payload.status);
console.log('bytes:', Buffer.byteLength(content, 'utf8'));
console.log('has json fence:', content.includes('```json'));
console.log('has divider:', content.includes('\n---\n'));
console.log('head:', JSON.stringify(content.slice(0, 60)));
console.log('tail:', JSON.stringify(content.slice(-60)));
if (child) child.kill();
