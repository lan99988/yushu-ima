# WorkBuddy 运维手册：真实执行与核对

本文件把在 WorkBuddy 里跑通过的实操方法固定下来，供后续会话直接复用。规则本身仍以[主卡规则](topic-cards.md)、[知识2.0规范](knowledge-2.md)和[历史维护](legacy-operations.md)为准；这里只讲"怎么跑、跑到哪一步算完、出错在哪一层"。

## 一、连接方式

WorkBuddy 通过 MCP 服务 `yushu-ima` 调用云端：标准安装用 `agent/ima_agent.py` 以 stdio 连接 `/bridge/v1/mcp`，只需要一个地址和两个令牌。在本机跑源码调试时才改用 HTTP 桥（`local-server.mjs`，默认 `127.0.0.1:8787`），由 `mcp-launcher.mjs` 按需拉起。

桥不是常驻服务：**一次性脚本所在的 shell 结束时，它拉起的子进程会被回收**。所以单次脚本必须自带生命周期：先探测端口，未监听则 `spawn(local-server.mjs)`，跑完再杀。仓库根的 `probe-one.mjs`、`read-card.mjs`、`update-card.mjs`、`drain-delete.mjs` 都是这个结构。

判断是否接通，看调用结果而不是进程名：

```text
node probe-one.mjs ima_knowledge_policy '{}'
```

普通安装用 `python agent/ima_agent.py doctor` 验证；跑本机桥时用下面这条。返回策略即通，返回 `fetch failed` 说明桥没起，不是服务不可用。

## 二、写作与格式

写入的卡片只有标题和正文，`entry_id`、版本、哈希、`source_id`、审核流水全部留在治理索引与私有库，不写进文件。读取时兼容两种历史形态：标题后紧跟的 JSON 代码围栏（旧版头部），以及正文之后的 `---` 加代码围栏（旧版文末）。展示只给正文，分隔线与围栏一并隐藏；正文里作为知识内容的真实 JSON 示例不算元数据。

修订文件名统一为 `标题__v<新版本>.md`。旧版本若叫 `标题__修订_<hash>.md`，下次修订会归一到版本号形式，不会继续累积后缀。

## 三、修订：预览 → 建新版 → 删旧版 → 核对

ima 没有原位写回接口（`update_knowledge` 等六个候选端点全部 404），所以"改"只能是先新增后删除。一次完整修订：

1. `ima_edit_preview`（`workspace`、`request_id`、`media_id`、`folder_id`、`new_content`）→ 返回 `preview` 与 `replacement_plan`。
2. 按 `replacement_plan.create_arguments` **原样**调用 `ima_create_text_file`，不要自己改文件名、目录或正文。
3. `ima_delete_preview`（`replacement_plan.delete_arguments` 加 `workspace`）→ `ima_delete_execute`。
4. 用新 `media_id` 调 `ima_read_media` 读回，逐字比对正文，并确认没有 ```json 围栏、没有分隔线、开头即标题。
5. 旧版删除若停在 `verification_pending`，用 `drain-delete.mjs <request_id> isolated` 推进到 `succeeded`，看四项校验全为 true。

版本号由治理索引提供，连续修订得到 1.1、1.2、1.3；不要在 `new_content` 里自己写版本。

## 四、两个必然遇到的中间态

- **`ima_openapi_readback_incomplete`**：删除执行前的 openapi 回读遇到索引滞后。此时**没有派发**，原请求号重试同一个 execute 即可，不要换号。
- **`ima_content_index_sync_slice_pending` / `verification_pending`**：派发后的全库缺席扫描是分片的。沿原 `request_id` 继续核对（`drain-delete.mjs`，通常一轮完成），四项校验通过才算删完。

**预览过期（`ima_content_preview_stale`）不一定是你改了内容。** ima 会把 `md5_sum` 从空异步回填成实值，服务端已把"空 → 有值"列为允许的漂移；其他字段变化仍会被拒绝。

## 五、改代码必须重建

`local-server.mjs` 加载的是 `dist/server/index.js`，不是 `worker/` 源码。改完 `worker/*.js` 必须：

```text
npm run build && npm run validate
```

否则会出现"改了没生效"的假象。改完跑 `npm test`（Node）与 `npm run test:agent`（Python）。

## 六、会被误判成故障的参数问题

- `ima_browse_knowledge` 与 `ima_read_media` 不接受 `workspace`。多传会直接返回"不支持的参数"，看起来像"目录为空"或"读不到内容"。
- `ima_knowledge_search` 不接受 `limit`。
- 桥的工具参数以 `tools/list` 返回的 schema 为准，不按记忆猜。

## 七、常用脚本

| 脚本 | 用途 |
|---|---|
| `probe-one.mjs` | 单次调用并打印返回；注意它只截取前 3000 字符，长返回请改用下面的读取脚本 |
| `read-card.mjs` | 完整读取条目原文并落盘，避免截断 |
| `update-card.mjs` | 通用修订：预览 → 建新版 → 删旧版 → 读回比对 |
| `drain-delete.mjs` | 把分片核对中的删除推进到完成 |

以上脚本都在仓库根目录，自带桥生命周期，从 `.dev.vars` 读取桥令牌，不写死路径。隔离库专用的全链路自测与格式验收脚本依赖你自己的目录 ID，需先改常量再跑，未随仓库提供。

## 八、不做的事

- 不为改而改：内容没有实质变化就不发起修订，格式迁移不值得牺牲版本连续性。
- 不擅自批量动正式库：正式库是真实资料，改哪一篇、改什么，先和用户确认。
- 不用删除重建去"清洗"文件名或格式：那会重置版本并产生新对象，代价高于收益。
