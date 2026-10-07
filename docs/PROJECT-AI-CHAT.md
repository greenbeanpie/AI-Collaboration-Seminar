# 项目个人问答与恢复

主页面问答只读取项目资料。每个项目成员拥有独立历史，其他成员不能读取其问题、答案、工具操作、通用任务状态或继续任务。聊天不启用互联网搜索、资料自动解析、澄清工具或业务写入工具；尚未解析的资料明确返回不可用。

## HTTP 契约

所有接口均使用现有认证及 API envelope。

- `GET /api/v1/projects/{projectId}/ai-chat?cursor=` 返回 `{items,nextCursor,pendingJobId}`。`items` 按时间升序；默认最新最多 20 个完整问题组，每组最多两条消息，因此最多 40 条消息。`nextCursor` 用于读取更早的问题组，不拆分问答。每条消息包含 `id,questionId,role,content,createdAt,jobId,references`，问题的 `jobId` 跟随最新尝试。
- `POST /api/v1/projects/{projectId}/ai-chat` 请求 `{content}`，非空且最多 4000 字符；携带 `Idempotency-Key`，返回 `202 {questionId,jobId}`。同一个人同一个项目只允许一个运行或等待自动重试的问答。
- `DELETE /api/v1/projects/{projectId}/ai-chat` 携带 `Idempotency-Key`，返回 `{cleared:true}`。执行中或自动恢复待处理时返回 409；清空增加会话 generation 并删除个人问题、答案、操作记录。旧任务和检查点不能通过授权和执行守卫，不能恢复、读回或写回历史。系统级审计保留。加密工具上下文和完整答案检查点通过持久清理队列删除；先永久失效历史，再尝试删除对象，R2 暂时失败由每分钟维护重试。权限及 generation 守卫保证失效任务不能再使用上下文；删除对象属于尽力清理，已停止的旧执行若仍有对象写入在途，可能留下不可访问的孤立对象。
- `GET /api/v1/projects/{projectId}/ai-chat/questions/{questionId}/operations?cursor=` 返回 `{items,nextCursor}`，每页 40 条，按操作 ID 升序，游标读取后续页。返回安全的 `id,kind,label,status,at,attempt,href,detail`，不返回工具原始载荷。操作在开始时创建、完成时原地更新，实时查看应周期性重新读取已加载分页以获取状态变化。跨重试尝试沿同一个 questionId 展示。
- 任务状态和续跑复用 `GET /api/v1/jobs/{jobId}`、`POST /api/v1/jobs/{jobId}/retry`，现有接口自动跟随后继尝试并验证个人聊天归属。`activity.uncertain` 提醒可能再次计费，`activity.canResume/resumeReason` 表示能否继续。

## 恢复与写入保护

`project.chat` 使用现有 agent 调度、预算预占、活动和加密 investigation 检查点。每次模型调用、读取操作及答案保存前验证项目权限、最新模型配置、问题 generation、当前 job 指针与项目内容快照。自动重试和手动重试共用不可变旧任务及唯一 retry link。重试的事务同时迁移问题和会话指针，旧执行不能发布答案。

项目快照覆盖主目标、项目背景、任务、来源生命周期/版本、成果版本、标准、评价及用户协作事件，排除 AI 调用审计和任务活动，避免自身操作使快照失效。快照变更要求重新发起，事务写入和重试也验证快照。每轮上下文仅取最近 20 条已有成功答案的消息。

工具检查点按已完成步骤恢复；完整验证答案另存加密响应检查点，保存失败后的续跑只验证并保存，无需再次请求模型。未确认的供应商请求保持 uncertain，自动重试不能重放，用户主动继续才可允许重发。无检查点时由现有恢复机制从头执行，界面应明确告知。引用只显示模型实际选用且已读、已验证的证据。

## 验证与发布

新增迁移 `0064_project_ai_chat.sql`；应先部署 D1 迁移再启用新版 API。执行 backend 类型检查、项目问答测试及现有工具/检查点/重试回归，生成 OpenAPI 后由前端生成类型。完整本地浏览器验证由集成工作执行；当前任务不部署生产，不声称真实模型供应商或云端验收完成。

本地验证：12 个问答专属用例及 46 个工具、检查点、重试与活动回归用例通过；backend TypeScript 检查通过，OpenAPI 已导出。覆盖 D1 保存故障后的零额外模型调用、模型请求结果不明、完成工具后的中断恢复、分页完整问答组、链接定位、清理重试以及清空与续跑竞态。
