// 反复核对一个待确认的原生删除，直到 resolved 或达到次数上限。
// 用法：node drain-delete.mjs <request_id> [workspace] [maxRounds]
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

const rid = process.argv[2];
const workspace = process.argv[3] || 'isolated';
const maxRounds = Number(process.argv[4] || 12);
if (!rid) { console.error('usage: node drain-delete.mjs <request_id> [workspace] [maxRounds]'); process.exit(2); }

async function call(name, args) {
  const r = await fetch('http://127.0.0.1:8787/bridge/v1/mcp', {
    method: 'POST', headers: {'content-type': 'application/json', 'x-ima-bridge-token': token},
    body: JSON.stringify({jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: {name, arguments: args}}),
  });
  const j = await r.json();
  const t = j.result?.content?.[0]?.text;
  try { return JSON.parse(t); } catch { return {raw: t}; }
}

for (let i = 1; i <= maxRounds; i += 1) {
  const out = await call('ima_delete_reconcile', {workspace, request_id: rid});
  const p = out.progress || {};
  console.log(`round ${i}: ${out.status} stage=${p.stage || '-'} folders=${p.scan?.folders_checked ?? '-'} pending=${p.scan?.pending_folders ?? '-'} items=${p.scan?.items_checked ?? '-'} ${out.message || ''}`);
  if (out.status !== 'verification_pending') { console.log('final:', JSON.stringify(out.verification || out.message || out.status)); break; }
}
if (child) child.kill();
