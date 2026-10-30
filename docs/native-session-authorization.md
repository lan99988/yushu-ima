# ima 原生连接：一次性授权与验收边界

2.1.1加入原生登录会话接收、加密保存、脱敏状态、串行刷新与撤销。2.2.0加入受控真实移动，见 [真实移动](real-move.md)；连接成功、知识库归属核对、真实移动验收是三个独立步骤。

## 首次授权

在当前对话开始连接后，安装器启动独立的 ima 官方登录浏览器。用户本人微信扫码。该环境不读取其他浏览器或 ima 客户端的登录状态；捕获结果仅通过子进程管道暂存于内存，再由云端公钥密封。密文通过既有 owner-private 插件认证通道提交，只有云端可以解密。受控桥接保留为可用网络环境下的安装路径。会话不进入聊天、知识正文、源码或脚本日志。上传成功后关闭本次浏览器。首次设置后，日常服务无需电脑持续在线。

官方二维码 iframe 的回调接收域有白名单，本实现不修改或绕过该检查。因此扫码在独立官方页面完成，不在本站伪造腾讯登录面板。

安装器：`scripts/authorize-ima-session.py start` 返回新的 run_id；`status --run <id>`只返回是否登录；`capture --run <id>`只处理该新环境并安全上传；`verify`在云端校验会话；`close --run <id>`只关闭本次环境。重复 installation_id 不得覆盖已经刷新的票据。

## 云端

- `IMA_SESSION_ENCRYPTION_KEY` 是独立32字节随机密钥，通过 Sites secret 配置，未写入源码或 manifest。会话以 AES-256-GCM 加密，AAD绑定既有OpenAPI账号指纹和记录元数据。
- 接收/验证仅经既有受控桥接，网页及 MCP 不接受凭据。`ima_connection_status`与`GET /api/ima-session/status`只返回脱敏状态。
- `POST /api/ima-session/revoke`只清除此插件保存的会话，不调用腾讯全局登出。所有网页调用保留原用户鉴权和同源检查。
- access token过期但refresh仍有效时需要刷新，不立即要求扫码。刷新全程持有账号租约、更新返回的新token与期限；每次请求重新计算bkn。不无条件重放刷新请求，不声称永久免登录。
- 新会话不会触发任何知识库移动或修改，也不会自动通过知识库归属绑定。真实移动必须在新的登录态中独立验证资源对应关系与隔离库结果。

## 验证

自动检查覆盖缺少密钥、篡改密文、账号隔离、并发与租约、撤销、重放、响应脱敏、跳转拒绝、会话过期和本机捕获边界。真实扫码和腾讯登录后的接口行为需要用户完成一次登录才能验收。

原始协议来源：官方安装客户端150.0.7871.5438及当前官方网页登录程序；HTTP认证参考 https://github.com/lesterppo/hermes-ima-cli/blob/master/ima.py 。没有复制其凭据日志或自动重放移动的策略。

密封接入顺序：ima_begin_connection取得公开SPKI；本机 relay-capture密封新扫码会话；ima_finish_connection只接收RSA-OAEP+AES-GCM密文；ima_verify_connection校验新会话。公钥、密文和安装号可通过工具处理，明文凭据不得进入对话。relay私钥同样由Sitessecret加密，密封包10分钟内有效。
