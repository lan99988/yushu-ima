# 配置与初始化

## 客户端

| 变量 | 说明 |
| --- | --- |
| `IMA_MCP_URL` | 已授权的完整MCP地址，例如 `https://your-ima-server.example/bridge/v1/mcp` |
| `IMA_CLOUD_SERVICE_TOKEN` | 私有Sites网关令牌，客户端发送 `OAI-Sites-Authorization: Bearer ...`；按服务真实认证要求配置 |
| `IMA_CLOUD_BRIDGE_TOKEN` | 受控桥接端点必填，发送为 `X-IMA-Bridge-Token`；与服务端桥接令牌一致 |
| `IMA_CLOUD_TIMEOUT` | 单次HTTP超时秒数，默认120，允许1至3600；不代表自动重试 |
| `IMA_MCP_AUTH_HEADER` | 可选，默认 `OAI-Sites-Authorization`；仅在你的合法网关要求其他认证头时调整 |
| `IMA_MCP_AUTH_SCHEME` | 可选，默认 `Bearer`；客户端拒绝无效字符及身份伪造头 |

Python接入器不自动读取系统注册表、其他程序配置或已有浏览器会话，也不自动加载 `.env`。宿主通过环境变量提供配置。MCP stdio模式仅向stdout写协议JSON，错误需脱敏。

`doctor` 只调用初始化、工具列表和知识政策读取，不能用它开启发布或写入测试卡。实际写入前，宿主仍需读取目标库绑定和候选内容。

命令行退出码：0为成功，1为本地配置/输入/传输错误，2为远端JSON-RPC错误或工具返回 `isError:true`。服务将 `verification_pending` 也标记为工具错误，接入器仍保留完整回执；宿主应根据其中的状态和进度沿原号reconcile，不能将退出码2一律解释成可以重传。stdio模式按协议返回远端结果。

接入器的单次JSON请求/响应上限为4MiB，超限明确报错；它不会截断正文或自动拆分写入。

## 服务端

服务使用D1绑定 `DB` 和R2绑定 `BUCKET`。原始D1表结构见 `drizzle/0000_square_rafael_vega.sql`；运行文档存储由 `worker/storage.js` 实现。已有项目部署不能清空数据库或重建账号绑定。

环境模板见 `config/server.env.example`。ima OpenAPI凭据和原生会话加密密钥由你自己的服务所有者配置。`IMA_CLOUD_BRIDGE_TOKEN` 是额外的受控桥接凭据；通用Agent连接 `/bridge/v1/mcp` 时需要该桥接令牌；通过平台所有者OAuth连接原生 `/mcp` 时不使用它。

私有Sites外层网关认证和内部bridge认证是两层边界：`/bridge/v1/*`需要受控bridge token；`/mcp`的写工具依赖平台确认的所有者身份。生产网关必须清理外部伪造身份头。独立于Sites部署时，需要另行实现并验收真实认证适配。

## 自有知识库绑定

1. 用自己的已认证账号查询实际知识库和目录ID；不要从标题猜ID。
2. 基于 `assets/governance-1.1.0.json` 建立本部署的政策、active记录及bindings。bindings的账号指纹是该部署 `IMA_OPENAPI_CLIENTID` 的SHA256，分类目录映射必须来自实际查询。
3. 通过受保护的管理流程初始化；其精确校验见 `worker/admin.js` 的 `begin/settings/isolated_settings/policy_upgrade`。初始化时提交匹配的migration_id和manifest_hash，在完成真实配置及校验后结束该次迁移。
4. 正式库与隔离库使用不同的实际库ID及目录ID。原生操作还需要用户本人完成一次新扫码会话接入，并验证OpenAPI与原生资源对应关系，见 [原生授权](native-session-authorization.md)。
5. 分别验收统一创建/更新/archive，再验收原生删除及归并；图片、移动等也有独立验收。已有服务有状态时沿原事务恢复。

本仓库不提供可直接写入的私人bindings或有效proof。可以参考测试fixture理解字段，但测试假ID与模拟回执不能用于正式初始化。将 `publication_enabled` 写成true不能替代隔离验收；归并的正式能力还需要匹配当前账号和绑定的实际证明。

## 原生登录安装器

`scripts/authorize-ima-session.py` 是一次性新扫码辅助程序，依赖本机可用的gstack浏览器及它自己的受控配置。先设置 `IMA_CLOUD_URL` 为你自己的服务根地址，再按 [原生授权说明](native-session-authorization.md) 操作。日常Agent访问已配置好的服务不需要重复扫码。

此辅助程序只使用本次新建的官方登录环境，明文凭据经内存管道密封后上传；不读取用户已有客户端登录态。独立Agent普通MCP接入不依赖该安装器运行。
