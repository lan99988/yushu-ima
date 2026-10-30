# Yushu ima 知识助手

将支持 MCP 或能运行 Python 的 Agent 接入 ima 知识库。包含通用 Agent 客户端、可移植插件规则和云端服务源码，基于知识助手 2.6.1 整理。

本项目是个人开发的集成，非腾讯官方产品。仓库代码可以交给其他 Agent；访问哪个知识库，由服务的真实授权、账号绑定和权限决定。

## 能做什么

- 在保存前搜索对象登记和 ima 原生资料，读取候选全文，再决定更新或新建。
- 同一具体事物维护完整主卡，例如吃法与选购均整理进《鱼油》，《蛋白粉》另建。
- 概念标题只写名称；独立且无法归入事物的问题用完整问句。
- 新材料与旧正文整合，保留来源、观点差异、方法、例子和历史变化。
- 已登记知识对象支持归并、备份、主卡读回、旧文件清理及索引同步；长事务按原请求分段恢复。
- 原样归档、笔记查询和追加、已验收范围内的目录与原生维护能力。

**相似内容的语义判断由宿主 Agent 完成。** 服务负责对象身份、版本、持久化和归并执行。标题相似不代表可以合并，多张既有卡归并移除前仍须确认具体清单。

当前归并支持 `registered_knowledge_object`，每批最多20个源、文本上限1MiB。未登记的原生历史卡暂不支持自动接管。图片显示及重开持久化有独立验收门禁；上传成功不代表图片显示验收通过。

## 目录

| 路径 | 用途 |
| --- | --- |
| `agent/ima_agent.py` | Python标准库实现的 MCP stdio / 命令行接入器 |
| `plugin/` | 可移植插件清单、MCP模板、知识整理技能及参考规范 |
| `config/` | MCP客户端、后端环境和知识库绑定配置模板 |
| `examples/` | 只读查询和不执行写入的预览参数示例 |
| `worker/` | 云端 MCP、HTTP桥接、知识服务和原生维护实现 |
| `tests/`、`tests_agent/` | 服务端和客户端离线测试 |
| `docs/` | 配置、部署和原生连接说明 |

## 方式一：让其他 Agent 使用已授权的云端服务

这是已经有可用服务时的接入方式，不需要复制云端数据库。

1. 安装Python 3.11或以上版本，克隆本仓库。
2. 从服务所有者取得**你被授权使用的** MCP 地址和认证信息，配置在本机或宿主的秘密配置中。
3. 将 [AGENTS.md](AGENTS.md) 和 [知识整理技能](plugin/skills/ima-cloud/SKILL.md) 交给宿主 Agent 阅读。
4. 先运行只读检查，确认真实工具及能力，再保存知识。

```powershell
git clone https://github.com/lan99988/yushu-ima.git
cd yushu-ima
$env:IMA_MCP_URL = "https://YOUR_AUTHORIZED_SITE/bridge/v1/mcp"
$env:IMA_CLOUD_SERVICE_TOKEN = "REPLACE_LOCALLY"
$env:IMA_CLOUD_BRIDGE_TOKEN = "REPLACE_LOCALLY"
$env:IMA_CLOUD_TIMEOUT = "120"
python agent/ima_agent.py doctor
python agent/ima_agent.py tools
```

通用接入器推荐使用受控端点 `/bridge/v1/mcp`：私有 Sites 外层使用 `OAI-Sites-Authorization: Bearer <service-token>`，内部桥接同时校验 `X-IMA-Bridge-Token`。认证信息由服务所有者通过受控方式提供；本仓库不包含私人服务地址、API Key、会话、现有知识内容或有效验收记录。复制代码本身不会授予访问原作者知识库的权限。

### MCP stdio 宿主

参考 [MCP配置模板](config/mcp.stdio.example.json)，把路径改为你的绝对路径，再放入宿主支持的 MCP 配置位置：

```json
{
  "mcpServers": {
    "yushu-ima": {
      "command": "python",
      "args": ["/ABSOLUTE/PATH/yushu-ima/agent/ima_agent.py", "stdio"],
      "env": {
        "IMA_MCP_URL": "https://YOUR_AUTHORIZED_SITE/bridge/v1/mcp",
        "IMA_CLOUD_SERVICE_TOKEN": "REPLACE_LOCALLY",
        "IMA_CLOUD_BRIDGE_TOKEN": "REPLACE_LOCALLY",
        "IMA_CLOUD_TIMEOUT": "120"
      }
    }
  }
}
```

该结构是常见的 `mcpServers` 示例，各宿主的导入位置和字段格式以其自身要求为准。能够配置两层认证头的远程HTTP MCP宿主也可直接连接 `/bridge/v1/mcp`。原生 `/mcp` 路径保留平台所有者身份认证，只有真正完成对应OAuth授权的宿主才可使用；服务bypass令牌本身不等于所有者身份。

### 只能运行命令的 Agent

```text
python agent/ima_agent.py call ima_knowledge_policy --args-file examples/policy.args.json
python agent/ima_agent.py call ima_knowledge_search --args-file examples/search.args.json
```

实际新建和更新前，先读工具 schema，再完成双检索及候选正文核对。参数文件以完整JSON传递，不把正文拼进 shell 命令。预览示例保持 `execute:false`，必须先替换所有示例值；不要将其当作已授权的真实保存请求。

### 给 Agent 的常用指令

> 将下面材料整理入库：先检索已有知识并读全文，同一事物整合到完整主卡，没有相同对象才新建。概念标题只写名称；保留来源和不同观点。保存后读回核验。多张旧卡归并移除前先给我具体清单。

宿主应在当前对话继续处理 `verification_pending`；按原 `request_id`、完整载荷和真实确认执行 `reconcile`。客户端不会自动重试写入或替你做语义决策。

## 方式二：使用可移植插件规则

`plugin/` 提供独立的 `plugin.json`、`mcp.json` 及技能目录。它不绑定原作者个人App ID。

安装前将 `plugin/mcp.json` 中的示例地址替换为自己的 `/mcp` 地址，并由宿主完成服务要求的所有者OAuth授权，再按其插件安装方式导入。此模板不会复制原作者账号的认证状态。通用Agent推荐使用上面经过桥接认证的stdio配置；只有兼容服务OAuth的宿主才使用原生HTTP插件模板。

原作者已有的网页ChatGPT云端插件是独立部署的账号插件；本仓库提供其整理规则和服务实现，不会自动创建另一个人的ChatGPT插件或复制账号权限。

## 方式三：部署自己的云端服务

后端当前针对 **Sites 的可信所有者认证网关 + Cloudflare Worker / D1 / R2** 运行环境编写。生产部署必须保留可信网关；`worker/app.js` 依赖网关确认的所有者身份头。裸Worker的独立认证适配不在当前交付范围内。

1. 建立你自己的私有 Sites 项目及D1、R2绑定。
2. 配置 [后端环境模板](config/server.env.example) 中的服务端秘密。
3. 按 [后端配置说明](docs/configuration.md) 使用自己的账号、库ID和目录ID初始化正式库与独立隔离库。
4. 完成真实创建、归档、更新、删除与归并验收；相应门禁由服务验证证据，不复制别人的proof、不直接篡改数据库开门禁。
5. 使用自己的 MCP 地址运行客户端 `doctor`，按真实能力启用对应功能。

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

Node.js要求22.13或以上；服务测试使用 `node:sqlite`。示例hosting文件只支持本地构建验证，生产发布前必须填入自己项目返回的真实ID。`dist/`是构建产物，不应把含私人设置的部署包直接提交到公共仓库。

## 配置与状态

客户端只读取环境变量，不自动加载 `.env`；[.env.example](.env.example) 用于说明变量，实际由终端或宿主注入。完整配置说明见 [docs/configuration.md](docs/configuration.md)。

每次保存前查询 `ima_knowledge_policy`：统一政策版本、服务可用性、归并启用状态和图片验收是不同状态。仓库版本号或 `serverInfo.version` 不能替代实际能力查询。

本仓库没有携带任何正式或隔离验收数据，因此新部署默认不能沿用原部署已通过验收的结论。已有授权云端服务的能力则以其当次返回为准。

## 来源与授权

来源及第三方组件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本仓库尚未指定额外的开源许可证；第三方材料仍遵循其自身授权条款。
