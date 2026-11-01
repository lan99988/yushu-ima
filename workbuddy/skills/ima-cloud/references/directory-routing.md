# 每次入库的目录扫描与自动归档

本规范适用于 WorkBuddy 内每次新建或更新知识卡；与旧的“目录每批逐次确认”说明冲突时，以本规范的实际授权检查为准。写作规范、双检索、原稿保全及事实核查规则继续有效。

1. 先确定本次稳定request_id，读取ima_folder_policy。enabled=true表示当前账号与目标库已登记持续授权；不能仅凭版本号或本文推断已授权。只有用户真实明确授权自动扫描、分类及按需建目录时，才调用ima_folder_policy(enabled:true,confirmation:用户真实授权原文)登记；无授权不自填确认。授权可用enabled:false及真实撤销原文关闭。
2. 每次调用ima_list_directories(refresh:true,for_request_id:本次request_id)，不传primary_category，完整扫描目标库现存全部根目录和子目录。使用本次scan_id，不复用历史任务的扫描结果。扫描失败、分页不完整、目录漂移均停止，不凭旧台账继续写入。
3. 阅读当前完整文章、目录名称、层级和已有purpose，选择语义最合适的已有目录：先确定一级分类，再选择合适的具体子目录；不只按关键词，不为追求层级而放进无关的更深目录。没有适合的子目录时可选合适父目录，但不能因为接口方便静默落到一级目录。
4. 有必要创建子目录时，优先复用语义相同或相近的目录。确实缺少合适位置、主题可持续容纳相关知识时，使用ima_folder_plan生成具体路径与用途。持续授权有效时，ima_folder_apply传authorization_mode:'standing'、decision:'confirm'、plan_id/revision及ima_folder_policy返回的真实授权原文作为confirmation，无需逐次询问；仍保留具体提案、编号防重、读回和登记。有歧义、改一级分类、批量重排或删除旧内容时不能套用此授权。没有持续授权时沿用具体路径确认流程。未知结果沿原plan/revision恢复，不换号重建。
5. 新建或接管目录后，再次refresh全库目录，绑定同一本次request_id，取得新的scan_id与已登记ready目录ID；不直接使用未登记原生目录。必要时用目录plan/apply复用并登记原生已有目录，不重复创建。
6. ima_knowledge_ingest和ima_knowledge_consolidate都传entry.primary_category、entry.directory_id及顶层directory_scan_id。本次scan_id与当前request_id必须匹配。已有卡更新仍走consolidate，不能把源文件的folder_id当成目标目录；源ID/位置按实际读取，目标另由entry.directory_id指定。
7. 保存后读回真实文件位置、完整正文及当前索引。路径必须与选定目录一致，子目录不能丢失；不匹配不报告完成。对已有卡的移动使用已验收的move预览/执行/原号核对，保留原文与身份，不自动搬动其他无关旧卡。
8. 自动优化仅限本次授权内容的合理归档及必要子目录：复用优先、主题清楚、不为每张卡建一个目录，不自动改名、删除、合并或重排全库。主卡归并涉及具体删除仍遵守原规则。archive原貌及其明确指定目标不被强制改写。

目录判断、扫描过程、scan_id与授权记录留后台，文章正文不插入管理信息。断线后保留原载荷与请求号；新目录门禁、权限及验收失败时如实停止，不回退旧接口。
