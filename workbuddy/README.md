# WorkBuddy 宿主适配

这是给 **WorkBuddy** 用的 ima 知识助手，与 [`plugin/`](../plugin/) 并列存在。

想先知道它能做什么，看[对外介绍](../docs/workbuddy-introduction.md)；已经装好、想少踩坑，看[实操经验](PLAYBOOK.md)。

- `plugin/` 面向 ChatGPT / OpenAI 宿主，保留原有的网页插件与 OAuth 写法；
- `workbuddy/` 面向 WorkBuddy，通过 MCP 服务 `yushu-ima` 调用同一套云端服务。

**两者互不覆盖，也不共享配置文件。** 用哪个就装哪个；同时安装不会互相干扰。规则内容同源（插件规则 2.10.0），差异只在宿主调用方式和运维步骤。

## 和 OpenAI 版的区别

| 项 | `plugin/`（OpenAI） | `workbuddy/`（本目录） |
|---|---|---|
| 调用方式 | 云端 `/mcp` 地址 + 所有者 OAuth | `agent/ima_agent.py stdio` 连 `/bridge/v1/mcp`；本机调试时才走 `127.0.0.1:8787` 的桥 |
| 配置位置 | 插件自带的 `mcp.json` | `~/.workbuddy/mcp.json` |
| 安装形态 | 插件包导入 | 技能目录复制 + MCP 服务登记 |
| 额外规则 | — | [宿主适配](skills/ima-cloud/references/workbuddy-host.md)、[运维手册](skills/ima-cloud/references/workbuddy-operations.md) |
| 工作区 | 由账号决定 | 显式区分 `formal`（正式库）/ `isolated`（验收库） |

## 安装

一条命令，需要三个值：服务地址、网关令牌、桥令牌（向服务所有者索取；**知识库 ID 绑定在服务端，不用填**）。

```text
python scripts/install-workbuddy.py --url "https://你的站点/bridge/v1/mcp" --service-token "网关令牌" --bridge-token "桥令牌"
```

脚本会复制技能到 `~/.workbuddy/skills/ima-cloud`、把服务写进 `~/.workbuddy/mcp.json`（保留其他服务并备份原文件）、用当前 Python 的绝对路径填好启动命令。重开对话后在自定义连接器里信任 `yushu-ima` 即可。

手动配置与故障排查见根目录 [README](../README.md#在-workbuddy-里使用)。

> 本目录只有技能规则与 MCP 示例，不含本地桥实现。要在本机跑桥调试，需要完整仓库、`npm ci` 与 `npm run build`，再用 `mcp-launcher.mjs` 作为入口；普通用户不需要这一步。

## 能力边界

- **不支持同 ID 原位改写**：ima 没有提供内容更新接口（`update_knowledge` 等候选端点均为 404）。所有"改"都是先建新版本、再删旧版本，文件 ID 会变，版本号递增（1.0 → 1.1 → 1.2）。系统按 `entry_id` 追踪，内部无感；外部若硬编码 `media_id` 会失效。
- **删除是两阶段**：派发后要做全库缺席扫描，中间会看到 `verification_pending`，沿原请求号推进到 `succeeded` 并有四项校验才算完成。
- **改服务端代码要重建**：`local-server.mjs` 加载 `dist/`，改 `worker/*.js` 后必须 `npm run build`。

## 目录内容

```text
workbuddy/
├── README.md                 本文件
├── PLAYBOOK.md               实操经验：跑通之后才明白的事
├── mcp.example.json          MCP 服务登记示例
└── skills/ima-cloud/
    ├── SKILL.md              入口
    └── references/
        ├── topic-cards.md          主卡规则
        ├── knowledge-2.md          知识 2.0 共享规范
        ├── web-intake.md           入库流程
        ├── claim-paper-review.md   观点提取与论文核查
        ├── directory-routing.md    目录扫描与归档
        ├── editorial-fidelity.md   编辑保真
        ├── legacy-operations.md    历史维护与阅读展示
        ├── workbuddy-host.md       宿主适配：工具映射、工作区、门禁
        └── workbuddy-operations.md 运维手册：执行步骤、状态机、常见假故障
```

## 验证装好了

```text
python agent/ima_agent.py doctor
```

返回工具清单和政策即接通。它只读不写。在对话里验证可以问一句「查一下我的知识库里有哪些目录」。

跑通之后会遇到的正常现象、踩过的坑和安全红线，见 [实操经验](PLAYBOOK.md)。

本机开发跑桥时才用到 `node probe-one.mjs` 这类脚本，它们依赖 Node 和 `dist/` 构建产物，普通安装用不上。
