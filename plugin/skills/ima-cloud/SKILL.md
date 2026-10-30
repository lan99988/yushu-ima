---
name: ima-cloud
description: 当用户在 ChatGPT 中要求整理入库、核实后入库、保存答案或原样归档材料，以及检索和维护 ima 知识时使用。
---
# ima 统一知识入口

这是**问题驱动的个人生活答案库**：帮助用户理解生活中的困扰、形成判断和采取行动。将当前对话、文章、文字稿及经验整理入库前，先读 [网页端整理入库流程](references/web-intake.md)，按其中顺序完成阅读、问题识别、选择性核查、保存及实际正文读回。支持 MCP 的宿主直接调用已授权的云端工具；只能运行命令的宿主使用仓库 README 中的通用接入器。用户已授权的常规保存不逐卡重复询问。

每次知识录入、补充、已有卡修订或归并前，必须读取[主卡规则](references/topic-cards.md)，执行整个目标库的登记与原生双检索并读取候选正文；本次只规范涉及的旧卡，不扫描改写全库。新增知识整理、笔记保存、追加及文件归档前，读取 [知识2.0共享规范](references/knowledge-2.md)。通过实际工具读取服务状态，不以说明文件判断已切换。

普通文本录入使用知识 2.0 契约与 policy_version=2.0.0。插件版本与服务能力分别核对；版本升级不代表图片显示能力已验收。

含图录入统一遵守[图片录入规则](references/knowledge-2.md#图片录入规则)：挑相关图、保留原图、图下中文译文。云端已实现将原图 bytes 写入自包含 Markdown data:image，图片请求使用已确认的 q.images 契约；**ima 正文显示及关闭重开持久化尚未验收，不能声称已支持 ima 显示。** 新图片正式写入须有 protected admin 知识图片验收证据（隔离卡两次真实截图＋重开记录）；未验收返回 blocked，未验收的隔离卡成功上传仍为 verification_pending。附件、外链、上传成功或聊天中显示均不算验收，不得自动公开私有图；archive 原貌不改。

每次操作或恢复任务，宿主通过现有只读工具实际查询当前连接、认证、目标库绑定、能力、门禁及有效验收记录；不依据本文或历史会话判断当前运行状态。临时会话状态只写入当次交付报告，不进入可复用规则；状态不明时不绕过门禁或换号补发。

未来仅在真实 protected proof 通过后，服务才在响应顶层提供 image_display，其中 status=verified、format=markdown_data_uri、renderer_version="1"，并给出真实 acceptance_request_id 与 checked_at。宿主核对有效 proof 和对应正文成功读回后，可按共享规范报告图文完成；不能把该未来契约当成当前已验收，也不能在 q/entry 中自填成功字段。当前图片功能验收仍待完成。

## 查询

调用 ima_knowledge_policy 读取统一规则，以 ima_knowledge_search 查询对象登记，同时 ima_search_knowledge 查旧资料。对候选使用 ima_knowledge_get 或 ima_read_media 读取实际正文。登记未命中不代表库内没有，不能只凭标题决定合并。回答优先展示可读 Markdown 正文；机器元数据默认隐藏，正文里的JSON示例仍保留。引用真实出处，不编造链接。

网页端保存及分段恢复时，必须执行[网页端直接写入与连续执行](references/web-intake.md#网页端直接写入与连续执行)，在当前网页对话沿原请求完成云端写入和核验。

## 统一录入

1. 已授权的 organize 新建在完成双检索、确认未命中后使用 ima_knowledge_ingest；已有卡更新（包括普通补充、改名及多卡归并）必须走 ima_knowledge_consolidate（/knowledge action consolidate）新编排。先核对实际 schema、runtime.consolidation、有效隔离验收 proof 及对象支持范围；已确认支持 registered_knowledge_object，纯原生未登记旧卡在接管能力及验收补齐前停预览并解释。未就绪停预览，不用旧 ingest 更新或低层创建/删除拼接替代。archive 仍用已验收的统一归档入口保留原貌。凭据与内部规则不写入知识正文。
2. 每次先用拟定标题、核心词和别名在整个目标库同时查登记与原生资料，读候选正文、revision 和原始材料。同一具体事物的所有问题整合重写为一张完整主卡，如吃法与选购均归《鱼油》，《蛋白粉》另建；同物问题只设正文小节。概念标题只用词汇，独立且无法归入具体事物的问题用完整问句。目录优先复用，来源独特观点、论证、方法、分歧和历史均保留。检索失败、正文不可读或身份歧义停预览。
3. material 保存实际完整原稿及来源。entry.body 是整合后的完整正文；事实、作者观点、个人经验及AI补充清楚区分。网页核查必须实际读取并提交 review 与正文hash绑定的证据；无证据的事实保持待核查，观点及经验不虚标事实核验。
4. 普通文本入口继续传 policy_version=2.0.0、原 request_id 及当前 expected_version；图片请求按已确认的顶层 q.images 契约，不臆造子字段或另换文本政策版本。时效内容传真实 as_of，并在对应判断后标注日期；事件卡保留时间线。历史与当前答案分别保留。
5. 已授权批次的常规补充经新归并编排执行；多张既有卡归并移除必须先展示具体保留/移除清单并取得针对清单的真实确认，备份及完整主卡读回通过后才能删除。单卡更新的旧可见版本收拢也由该编排完成。核心答案大改、跨分类或旧卡接管先展示方案，confirmation 只能记录用户真实授权。已确认范围不逐卡重复询问。按实际工具契约先预览再执行；ingest 使用 execute:false/true，consolidate 的确认使用 confirmation 对象 {text,preview_hash,delete_media_ids}，分别绑定真实授权原文、服务当前预览 hash 和已确认的移除 ID 清单；其他参数按当前 schema，不臆造授权。只有 succeeded 且真实资源和读回齐全才报告文本保存完成；已有卡还须核对备份、被替代条目移除、索引同步及仅一个当前可见主卡，缺任一项保持部分完成/待核对；新图片正式写入未通过 protected admin 验收则返回 blocked，未验收的隔离卡上传成功仍为 verification_pending，不能报告图文完成。未来有效 proof、服务真实 image_display 和成功读回满足共享规范时可收口；Markdown/hash 或上传成功本身不能代替验收证据。
6. unknown、verification_pending 或超时保留原请求和完整载荷，仅加 reconcile:true 核对；不换号、不重新上传、不回退旧写入。原生笔记保存需保留 note_id 语义，使用已支持的archive笔记分支；能力尚未部署则保留预览。

## 维护与兼容

正式库新目录仍须本批具体路径确认。明确要求的移动、删除、登录授权及旧已持久化事务恢复，按[对应维护流程](references/legacy-operations.md)执行；该参考中旧的新增制卡与发布流程仅用于历史恢复，不能用于新写入。读取先查当前内容、当前审核状态和当前位置。更新助手不代表授权批量修改或删除历史库。
