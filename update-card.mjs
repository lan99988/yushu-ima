// 通用卡片修订：node update-card.mjs <mediaId> <folderId> <bodyFile> <requestPrefix>
// 流程：编辑预览 → 新版本创建 → 旧卡删除预览 → 删除执行 → 读回核对。自带桥生命周期。
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = 'http://127.0.0.1:8787';
const token = fs.readFileSync(path.join(HERE, '.dev.vars'), 'utf8').match(/^IMA_CLOUD_BRIDGE_TOKEN=(.+)$/m)[1].trim();
const probe = (t = 500) => new Promise((resolve) => {
  const s = net.connect({host: '127.0.0.1', port: 8787});
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.setTimeout(t); s.once('connect', () => done(true)); s.once('timeout', () => done(false)); s.once('error', () => done(false));
});
let child = null;
if (!await probe()) {
  child = spawn(process.execPath, [path.join(HERE, 'local-server.mjs')], {cwd: HERE, stdio: 'ignore', windowsHide: true});
  for (let i = 0; i < 40; i += 1) { await new Promise((r) => setTimeout(r, 250)); if (await probe(300)) break; }
}
async function mcp(name, args) {
  const r = await fetch(`${BRIDGE}/bridge/v1/mcp`, {
    method: 'POST', headers: {'content-type': 'application/json', 'x-ima-bridge-token': token},
    body: JSON.stringify({jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: {name, arguments: args}}),
  });
  const d = await r.json();
  if (d.error) throw new Error(name + ' rpc: ' + JSON.stringify(d.error).slice(0, 300));
  const t = d.result?.content?.[0]?.text;
  try { return JSON.parse(t); } catch { return {raw: t}; }
}
const log = (k, v) => console.log(k, ':', typeof v === 'string' ? v : JSON.stringify(v)?.slice(0, 400));

const [mediaId, folderId, bodyFile, prefix] = process.argv.slice(2);
const BODY = fs.readFileSync(path.join(HERE, bodyFile), 'utf8');
const RID = `${prefix}-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;

log('修订目标', mediaId.slice(-14));
log('新正文字节', Buffer.byteLength(BODY, 'utf8'));

const ed = await mcp('ima_edit_preview', {workspace: 'isolated', request_id: RID, media_id: mediaId, folder_id: folderId, new_content: BODY});
log('1.编辑预览', `${ed.status}${ed.message ? ' / ' + ed.message : ''}`);
log('1.新文件名', ed.replacement_plan?.create_arguments?.filename);
log('1.候选版本', ed.preview?.candidate?.version);
if (ed.status !== 'preview') { if (child) child.kill(); process.exit(1); }

const created = await mcp('ima_create_text_file', ed.replacement_plan.create_arguments);
log('2.新版本创建', `${created.status}${created.message ? ' / ' + created.message : ''}`);
const newMedia = created.resource?.media_ids?.[0] || created.receipt?.media_ids?.[0] || null;
log('2.新 media_id', newMedia || '(none)');
if (!newMedia) { if (child) child.kill(); process.exit(1); }

const dp = await mcp('ima_delete_preview', {...ed.replacement_plan.delete_arguments, workspace: 'isolated'});
log('3.旧卡删除预览', `${dp.status}${dp.message ? ' / ' + dp.message : ''}`);
if (dp.status === 'preview') {
  const del = await mcp('ima_delete_execute', {workspace: 'isolated', request_id: ed.replacement_plan.delete_arguments.request_id, preview_hash: dp.preview_hash});
  log('3.旧卡删除执行', `${del.status}${del.message ? ' / ' + del.message : ''}`);
  if (del.status !== 'succeeded') log('3.待核对请求号', ed.replacement_plan.delete_arguments.request_id);
}

const payload = await mcp('ima_read_media', {media_id: newMedia});
const content = payload.data?.content ?? '';
fs.writeFileSync(path.join(HERE, bodyFile.replace(/\.md$/, '.remote.md')), content, 'utf8');
const bodyPart = content.replace(/^# [^\n]+\n\n/, '').split('## 材料性质与来源')[0];
const title = (BODY.match(/^# (.+)$/m) || [])[1] ?? '';
log('4.读回字节', Buffer.byteLength(content, 'utf8'));
log('4.含 JSON 围栏', content.includes('```json'));
log('4.含分隔线', content.includes('\n---\n'));
log('4.开头是标题', title ? content.startsWith(`# ${title}\n\n`) : content.startsWith('# '));
log('4.正文与提交一致', bodyPart.trim() === BODY.trim());
log('4.NEW_MEDIA', newMedia);
if (child) child.kill();
