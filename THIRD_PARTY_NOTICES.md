# 来源与第三方组件

- 项目中的ima接口适配最初参考腾讯发布的ima官方技能包1.1.10，后续加入私人云端服务、知识对象治理、归并与恢复流程。本项目非腾讯官方产品。
- 原包地址： https://app-dl.ima.qq.com/skills/ima-skills-1.1.10.zip
- 原包记录SHA256：`7e0d07cae0f98145dc5147e84b77bcc557e2fc4b256b08907922637952c20a7b`。
- npm依赖及其版本由 `package-lock.json` 锁定；各依赖保留自身许可证。构建使用esbuild，数据模型使用drizzle，密码学辅助使用@noble/hashes。
- 原生会话协议的实现与测试见 `docs/native-session-authorization.md` 及相关源码。未经验证的能力继续受运行时门禁约束。

这里记录来源，不代表对第三方材料授予新的许可证。仓库未包含个人知识库数据、私人验收state或真实授权凭据。
