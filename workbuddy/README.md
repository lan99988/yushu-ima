# WorkBuddy 宿主适配

这是给 **WorkBuddy** 用的 ima 知识助手，与 [`plugin/`](../plugin/) 并列存在。

- `plugin/` 面向 ChatGPT / OpenAI 宿主，保留原有的网页插件与 OAuth 写法；
- `workbuddy/` 面向 WorkBuddy，通过本地桥调用同一套云端服务。

**两者互不覆盖，也不共享配置文件。** 用哪个就装哪个；同时安装不会互相干扰。规则内容同源（插件规则 2.10.0），差异只在宿主调用方式和运维步骤。

## 和 OpenAI 版的区别

| 项 | `plugin/`（OpenAI） | `workbuddy/`（本目录） |
|---|---|---|
| 调用方式 | 云端 `/mcp` 地址 + 所有者 OAuth | 本地桥 `mcp-launcher.mjs` → `127.0.0.1:8787` 的 MCP 服务 `yushu-ima` |
| 配置位置 | 插件自带的 `mcp.json` | `~/.workbuddy/mcp.json` |
| 安装形态 | 插件包导入 | 技能目录复制 + MCP 服务登记 |
| 额外规则 | — | [宿主适配](skills/ima-cloud/references/workbuddy-host.md)、[运维手册](skills/ima-cloud/references/workbuddy-operations.md) |
| 工作区 | 由账号决定 | 显式区分 `formal`（正式库）/ `isolated`（验收库） |

## 安装

1. **部署云端服务**（若尚未部署）：按根目录 [README](../README.md) 的方式四准备自己的 Worker、D1、R2 与令牌，并在 `.dev.vars` 中写入桥令牌。

2. **复制技能**到 WorkBuddy 的技能目录：

   ```text
   cp -r workbuddy/skills/ima-cloud ~/.workbuddy/skills/ima-cloud
   ```

   仓库里的这份就是可运行版本，含全部引用文件，不需要再改写。

3. **登记 MCP 服务**：把 [mcp.example.json](mcp.example.json) 的内容并入 `~/.workbuddy/mcp.json`，把 `command`、`args` 里的绝对路径改成你自己的，`IMA_PYTHON` 指向本机 Python。

4. **在 WorkBuddy 里信任该服务**：自定义连接器入口出现新服务后点“信任”，之后即可在对话里直接调用。

## 能力边界

- **不支持同 ID 原位改写**：ima 没有提供内容更新接口（`update_knowledge` 等候选端点均为 404）。所有"改"都是先建新版本、再删旧版本，文件 ID 会变，版本号递增（1.0 → 1.1 → 1.2）。系统按 `entry_id` 追踪，内部无感；外部若硬编码 `media_id` 会失效。
- **删除是两阶段**：派发后要做全库缺席扫描，中间会看到 `verification_pending`，沿原请求号推进到 `succeeded` 并有四项校验才算完成。
- **改服务端代码要重建**：`local-server.mjs` 加载 `dist/`，改 `worker/*.js` 后必须 `npm run build`。

## 目录内容

```text
workbuddy/
├── README.md                 本文件
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
node probe-one.mjs ima_knowledge_policy '{}'
node read-card.mjs <media_id> out.md
```

第一条返回统一政策即桥已通；第二条能完整读回条目正文即链路已通。返回 `fetch failed` 是桥没起，不是服务不可用。
