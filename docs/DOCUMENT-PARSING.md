# PDF、DOCX 与材料内索引

文字型 PDF 保留后端 unpdf。自动模式以 10 MiB / 30 页作为建议切换点，大文件使用浏览器 PDF.js；DOCX 使用浏览器 Mammoth。应用层不限制文件总大小或 PDF 页数，单次请求、R2 对象、用户设备、供应商和模型预算仍有真实限制。

## 导入与覆盖

- 项目资料、创建向导和模板草稿支持 DOCX。大文件通过私有 R2 multipart 上传，每个会话绑定用户、项目/草稿和生命周期，支持查询已完成分片、重传、完成和取消。小文件快捷请求超过 10 MiB 必须改用分片；这不是文件总大小上限。
- 下载返回流并支持 Range。multipart 文件使用对象大小和 ETag 校验传输，没有声称生成完整文件 SHA-256。
- DOCX 校验 ZIP 目录、主文档和内容类型。加密、损坏、ZIP64 或超过元数据处理边界的包会明确拒绝，不把普通 ZIP 当作 DOCX。
- 浏览器在 Web Worker 中解析，提交一批原文并得到服务端确认后才继续。PDF 保留真实页码；DOCX 保留标题路径和段落，页码为 null。文本作为客户端提取结果保存，未被服务器独立核对。
- 取消或内存错误保留已提交内容。图片、公式、批注等未读取对象会形成覆盖警告；部分结果不能声称完整。创建草稿正文分块保存，AI 可通过分页工具读取后续原文。

## OCR 与总结

扫描页逐页渲染和上传，不预先缓存整份文档的图片。OCR 每组最多三张连续页，实际组数受模型输出预算、每张 2 MiB、请求总量 9 MiB 和供应商能力约束。

上一页尾部最多 1500 字符，且不超过模型文字输入预算 10%，仅作为辅助上下文，禁止补写当前图片中未出现的内容。输出按页校验，成功页单独保存并标记待复核。明确拒绝多图的端点按端点/模型记录单图模式；网络/超时等不明付费请求不自动重放。

校验发现缺失页时，解析作业暂停为 `waiting_input`（`execution.pauseReason='output_invalid'`），不把整册当作识别完成，也不自动重放已付费请求；失败页的 `ocr_status` 保持 `failed` 并继续出现在待渲染列表，用户补充续跑后从检查点恢复，已成功的页面不重复计费。

已有文字层的页面可补充 OCR。人工确认空白页不会调用模型。页图接口的 `analyze:false` 表示只识别正文，不重复要求提取或总结。

正文总结和要求提取按片段序号游标分批读取，不在 Worker 一次加载整份正文。总结使用相邻分块原文作有界上下文，覆盖统计不重复计数，解析警告保留在 caveats。最终结构化输出仍受平台存储和运行资源限制。

## 目录、搜索与原文定位

索引覆盖文件来源和编辑材料的固定版本。来源保留原 fragmentId，编辑材料按标题/段落分块。中文及英文三个以上字符使用 D1 FTS5 trigram；短词在指定版本内匹配。索引生成使用持久化片段序号及片段内码点游标，避免逐块扫描全文。

共享 AI 工具：`get_resource_index`、`search_resource`、`read_resource_section`。搜索只提供定位摘录，读取章节可携带前后原文，每次最多 6000 个码点。模型仅能引用实际读取的内容；总结不清晰或有冲突时应检索并核对原文。权限和生命周期在读取前后复核，已回收来源不可检索，旧引用不删除。

前端资料详情提供目录、搜索、相邻原文；PDF 可打开原文件对应页。历史资料通过每分钟的有界后台任务补建索引，不调用 embedding 或摘要模型。

## 接口与发布

- 项目上传：`/api/v1/projects/{projectId}/files/{fileId}/uploads`，以及会话状态、`parts/{partNumber}`、`complete`、`abort`。
- 本机正文：`/api/v1/projects/{projectId}/document-imports`，以及会话状态、`batches`、`complete`；`extract` 只读取云端正文，`analyze` 启动后续要求提取，`blank-pages` 确认空白。
- 草稿上传/正文：`/api/v1/creation-drafts/{draftId}/files/{fileId}/multipart` 与 `imports`。
- 索引：`/api/v1/projects/{projectId}/resource-index/{source|material}/{versionId}`，以及 `search` 和 `section`。

能力字段 `maxFileBytes`、`maxMediaBytes`、`maxPdfPages` 的 null 表示没有应用层上限，建议与分片参数单独下发。既有音视频摘要、项目创建行为、系统背景和任务资格流程保留。

生产新增迁移为 0048_document_imports、0049_ocr_batches、0050_resource_index、0051_draft_document_imports。迁移前导出 D1 备份，保留当前数据库、存储桶与绑定。

可分别将 `DOCUMENT_IMPORTS_ENABLED`、`RESOURCE_INDEX_ENABLED`、`OCR_BATCH_ENABLED` 设置为 `false` 并重新部署关闭入口或退回单图 OCR；原文件、已保存正文和引用保留。代码回滚不撤销新增表与列。

验证命令：`npm run typecheck`、`npm run lint`、`npm run test:backend`、`npm run test:frontend`、`npm run build`、`npm run preflight:deploy -- production`。相关测试覆盖实际流长度、上传竞态、生命周期、DOCX 语义、Unicode、索引查询计划、分块上下文及多图传输预算。线上模型能力和 Free CPU 不能由本地测试推定。
