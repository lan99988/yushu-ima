# Yushu ima 知识助手

把 ima 知识库接到你自己的 Agent：保存前先检索、同一事物只维护一张主卡、写完读回核对。仓库包含可移植的整理规则、通用 MCP 客户端和云端服务源码。插件规则 2.10.0，服务版本以 `package.json` 和运行时能力为准。

本项目是个人开发的集成，非腾讯官方产品。能访问哪个知识库，由服务的真实授权、账号绑定和权限决定；复制代码不会获得原作者知识库的访问权。

## 能做什么

- 保存前搜索对象登记和 ima 原生资料，读取候选全文，再决定更新还是新建。
- 同一具体事物维护一张完整主卡，例如吃法与选购都整理进《鱼油》，《蛋白粉》另建。
- 概念标题只写名称；独立且无法归入事物的问题用完整问句。
- 新材料与旧正文整合，保留来源、观点差异、方法、例子和历史变化。
- 已登记对象支持归并、备份、主卡读回、旧文件清理和索引同步；长事务按原请求分段恢复。
- 文章里的可检验主张会被提取出来对照论文，给出支持／部分支持／不支持／证据不足的判断。

语义判断由宿主 Agent 完成，服务负责对象身份、版本、持久化和归并执行。标题相似不代表可以合并；多张旧卡归并移除前必须确认具体清单。

## 三种用法

| 你的情况 | 用哪个 | 需要准备 |
| --- | --- | --- |
| 只想用别人已经部署好的服务 | 本页「在 WorkBuddy 里使用」 | 一个服务地址 + 两个令牌 |
| 习惯在 ChatGPT 网页里用 | [`plugin/`](plugin/) | 自己部署的服务 + OAuth 授权 |
| 想自己部署一套 | `worker/` + D1 + R2 | App ID、API Key、知识库 ID |

`plugin/` 与 [`workbuddy/`](workbuddy/) 并列存在、互不覆盖，同时安装也不冲突。

---

# 在 WorkBuddy 里使用

一条命令装完，你只需要向服务所有者要三个值。

## 你需要什么

| 值 | 对应变量 | 长什么样 |
| --- | --- | --- |
| 服务地址 | `IMA_MCP_URL` | `https://你的站点/bridge/v1/mcp` |
| 网关令牌 | `IMA_CLOUD_SERVICE_TOKEN` | 一长串随机字符 |
| 桥令牌 | `IMA_CLOUD_BRIDGE_TOKEN` | 另一串随机字符 |

知识库 ID 不用填，它绑定在服务端。

## 装

```text
git clone https://github.com/lan99988/yushu-ima.git
cd yushu-ima
python scripts/install-workbuddy.py --url "https://你的站点/bridge/v1/mcp" --service-token "网关令牌" --bridge-token "桥令牌"
```

脚本做三件事：

1. 把技能复制到 `~/.workbuddy/skills/ima-cloud`；
2. 把服务写进 `~/.workbuddy/mcp.json`，已有的其他服务保留，原文件备份为 `mcp.json.bak`；
3. 用当前 Python 的绝对路径填好启动命令，省掉手改路径。

不装 Node、不构建、不建数据库。只要 Python 3.11 以上。

## 验证

重开一轮对话，在自定义连接器里信任 `yushu-ima`，然后说：

> 查一下我的知识库里有哪些目录

能列出真实目录就算接通。接下来会发生什么、哪些现象是正常的、哪些红线不能碰，都写在 [实操经验](workbuddy/PLAYBOOK.md) 里。

## 连不上

| 现象 | 多半是 |
| --- | --- |
| 连接器里看不到 `yushu-ima` | `mcp.json` 不是合法 JSON，或没重开对话 |
| 报 401 / 未授权 | 两个令牌填反了 |
| 报 `fetch failed` | 服务地址写错，或服务端没起 |
| 能查不能写 | 服务端没开对应门禁，不是客户端问题 |

## 不想跑脚本

手动三步：

1. `cp -r workbuddy/skills/ima-cloud ~/.workbuddy/skills/`
2. 把 [mcp.example.json](workbuddy/mcp.example.json) 并入 `~/.workbuddy/mcp.json`
3. 改其中的绝对路径、服务地址和两个令牌

## 服务端还要配什么

如果这套服务是你自己部署、准备分享给别人，除上面两个令牌外还要在服务端秘密里配：

| 服务端变量 | 用途 |
| --- | --- |
| `IMA_OPENAPI_CLIENTID` | ima 开放平台的应用 ID，账号指纹由它推出 |
| `IMA_OPENAPI_APIKEY` | 对应的 API Key |
| `IMA_SESSION_ENCRYPTION_KEY` | 32 字节随机数的 base64，原生会话用 AES-GCM 加密 |
| 知识库 ID / 目录 ID | 初始化 bindings 时写入，正式库与隔离库必须用不同的实际 ID |

完整步骤见 [`docs/configuration.md`](docs/configuration.md)。两层认证别混：`/bridge/v1/*` 认桥令牌，`/mcp` 认平台所有者身份，桥令牌不等于所有者身份。

---

## 在 ChatGPT / OpenAI 插件里使用

`plugin/` 提供独立的 `plugin.json`、`mcp.json` 和技能目录，不绑定原作者的个人 App ID。

把 `plugin/mcp.json` 里的示例地址换成你自己的 `/mcp` 地址，由宿主完成服务要求的所有者 OAuth 授权，再按插件的安装方式导入。这份模板不含任何账号认证状态，导入后仍需你自己登录。

原作者那套网页 ChatGPT 云端插件是独立部署的账号插件；本仓库提供的是整理规则和服务实现，不会替你创建插件或复制别人的账号权限。

## 给其他 Agent 使用

已经有可用服务时，不需要复制云端数据库：

```powershell
git clone https://github.com/lan99988/yushu-ima.git
cd yushu-ima
$env:IMA_MCP_URL = "https://YOUR_AUTHORIZED_SITE/bridge/v1/mcp"
$env:IMA_CLOUD_SERVICE_TOKEN = "REPLACE_LOCALLY"
$env:IMA_CLOUD_BRIDGE_TOKEN = "REPLACE_LOCALLY"
python agent/ima_agent.py doctor
python agent/ima_agent.py tools
```

把 [`AGENTS.md`](AGENTS.md) 和 [知识整理技能](plugin/skills/ima-cloud/SKILL.md) 交给宿主 Agent 阅读，再让它先做只读检查。

只能运行命令的 Agent：

```text
python agent/ima_agent.py call ima_knowledge_policy --args-file examples/policy.args.json
python agent/ima_agent.py call ima_knowledge_search --args-file examples/search.args.json
```

参数用完整 JSON 传递，别把正文拼进 shell 命令。预览示例都是 `execute:false`，先替换示例值再执行。

常用指令模板：

> 将下面材料整理入库：先检索已有知识并读全文，同一事物整合到完整主卡，没有相同对象才新建。概念标题只写名称；保留来源和不同观点。保存后读回核验。多张旧卡归并移除前先给我具体清单。

宿主应在当前对话继续处理 `verification_pending`，按原 `request_id`、完整载荷和真实确认执行 `reconcile`。客户端不会自动重试写入，也不会替你做语义决策。

## 自己部署云端服务

后端针对 **Sites 的可信所有者认证网关 + Cloudflare Worker / D1 / R2** 编写，生产部署必须保留可信网关；`worker/app.js` 依赖网关确认的所有者身份头，裸 Worker 的独立认证适配不在当前交付范围内。

1. 建立你自己的私有 Sites 项目及 D1、R2 绑定。
2. 配置 [后端环境模板](config/server.env.example) 中的服务端秘密。
3. 按 [后端配置说明](docs/configuration.md) 用自己的账号、库 ID 和目录 ID 初始化正式库与独立隔离库。
4. 完成真实的创建、归档、更新、删除与归并验收。门禁由服务验证证据，不复制别人的 proof，也不直接改数据库开门禁。
5. 用自己的 MCP 地址运行客户端 `doctor`，按真实能力启用对应功能。

构建与离线验证：

```text
npm ci
python -c "from pathlib import Path; import shutil; p=Path('.openai/hosting.json'); p.parent.mkdir(exist_ok=True); p.exists() or shutil.copyfile('.openai/hosting.json.example',p)"
npm test
python -m unittest discover -s tests_agent -v
python tests/authorize-ima-session.test.py
npm run build
npm run validate
```

Node.js 要求 22.13 或以上，服务测试使用 `node:sqlite`。示例 hosting 文件只够本地构建验证，发布前必须填自己项目的真实 ID。`dist/` 是构建产物，不要把含私人设置的部署包提交到公共仓库。

## 文章观点核查：默认流程

插件 2.10.0 起默认执行：**提取核心观点 → 对照研究论文 → 明确判断 → 整合到同一主卡 → 保存后读回**。

- 科学疗效、风险与因果主张直接核对研究论文或系统综述；新闻、营销、科普和 AI 回答不能代替论文。
- 忠实保留原作者的人群、例外和论证，主动查找相反结果，区分主要结果、次要结果和亚组分析。
- 判断可以是支持、部分支持、不支持、证据不足或有分歧。开篇直接给答案，全文白话，条数由内容决定。
- 标明摘要与正文的实际读取范围。部分观点核查不自动提升整卡状态；原稿、证据和内部记录留在后台。
- 其他类型事实与原样存档使用各自流程。

完整规范见 [观点提取与论文核查](plugin/skills/ima-cloud/references/claim-paper-review.md)。目录自动化、现卡归并和图片能力分别以所连服务的实际工具、授权与验收状态为准；规则更新不会自动升级服务实现，也不提供私有服务的访问权限。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `agent/ima_agent.py` | Python 标准库实现的 MCP stdio / 命令行接入器 |
| `plugin/` | 可移植插件清单、MCP 模板、知识整理技能（ChatGPT / OpenAI 宿主） |
| `workbuddy/` | WorkBuddy 宿主适配：技能目录、MCP 示例、[实操经验](workbuddy/PLAYBOOK.md)与运维手册 |
| `config/` | MCP 客户端、后端环境与知识库绑定模板 |
| `examples/` | 只读查询和不执行写入的预览参数示例 |
| `worker/` | 云端 MCP、HTTP 桥接、知识服务和原生维护实现 |
| `tests/`、`tests_agent/` | 服务端和客户端离线测试 |
| `docs/` | 配置、部署和原生连接说明 |

## 能力与限制

当前归并支持 `registered_knowledge_object`，每批最多 20 个源、文本上限 1 MiB。未登记的原生历史卡暂不支持自动接管。

- **改等同新建加删除。** ima 没有原位改写接口，所有修订都是先建新版本再删旧版本，文件 ID 会变、版本号递增（1.0 → 1.1 → 1.2）。系统按 `entry_id` 追踪，外部若硬编码 `media_id` 会失效。
- **删除是两阶段。** 派发后要做全库缺席扫描，中途会看到 `verification_pending`，沿原请求号推进到 `succeeded` 并有四项校验才算完成。
- **图片有独立门禁。** 上传成功不代表 ima 正文显示通过，需要 protected admin 的真实截图与重开证据。
- **改服务端代码要重建。** 本地运行的桥加载 `dist/` 构建产物，改 `worker/*.js` 后必须 `npm run build`，否则跑的还是旧代码。

## 配置与状态

客户端只读环境变量，不自动加载 `.env`；[`.env.example`](.env.example) 只是说明，实际由终端或宿主注入。完整说明见 [`docs/configuration.md`](docs/configuration.md)。

每次保存前查 `ima_knowledge_policy`：政策版本、服务可用性、归并启用状态和图片验收是四件不同的事。仓库版本号或 `serverInfo.version` 都不能替代实际能力查询。

本仓库不携带任何正式或隔离验收数据，新部署不能沿用原部署的验收结论；已有授权服务的能力以当次返回为准。

## 来源与授权

来源及第三方组件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本仓库尚未指定额外的开源许可证，第三方材料仍遵循其自身授权条款。
