# AI 任务规划简化与用户澄清

## 行为

- 创建预览和已有项目拆解/调整共用“最少但足够”的规划规则：按独立可验收的成果分组，短准备步骤留在任务说明中，只保留真实输入依赖。3–6 项是普通小项目的参考而非硬上限，不删减复杂需求或已有提交历史。
- 模型通过真实 `ask_user_question` 工具请求关键澄清，使用既有 Chat Completions / Responses / Anthropic Messages / Gemini 工具传输，不增加付费预检调用。
- 一次询问一个会改变目标、范围或交付物的关键问题，提供证据支持的选项，也支持自由回答和适用时的“尚未决定”。每次规划最多三轮；未决定不会被解释为已选择某条赛道。普通信息缺口仍可用明确标示的可逆假设继续。
- 等待期间只保存问题和模型恢复状态，不创建项目、任务或规划建议。回答后继续同一个任务/预览；仍遵循原有预览复核、创建确认和项目自动/人工应用设置。
- 草稿恢复页和项目任务区提供待回答入口、错误重试、取消和刷新；同一问题重复提交和并发提交不会覆盖答案或新建多个续跑实例。

## 状态与权限

`0039_ai_clarifications.sql` 是纯新增迁移：增加问题表、草稿等待指针/冻结配置列及草稿派发 outbox，保留所有旧表、原字段和值。草稿原有 `preview_state` CHECK 不重建，API 用等待指针投影 `waiting_input`。

- 问题绑定发起用户、项目或私有草稿、原始尝试、工具轮次/调用 ID 和草稿版本。选项逐项校验，答案只能由发起人提交；项目回答还要在原子写入时验证当前任务管理权限、配置、目标/依赖图和来源快照。
- 问题版本号与独立转换令牌共同保护并发写入。同内容重试返回原答案，冲突答案拒绝。
- 项目恢复使用既有独立执行分片；旧提示词版本的已保存模型响应可继续，不因升级重新支付同一步调用。等待状态保留预算；取消或撤权/上下文过期清理不调用模型，结算已产生用量并停止旧流程。
- 私有草稿用加密 R2 检查点保存冻结文件、消息和工具交换；条件 ETag 写入避免双重派发。已发出但结果未知的模型调用不会自动重放。
- 初次草稿排队和回答后的续跑意图分别在同一 D1 batch 写入 outbox；每分钟既有 cron 核对并使用同一个 Workflow ID 恢复。页面关闭或派发响应丢失不需要重新填写回答。已终止或结果未知的收费调用不会被换新实例重跑。
- 工具日志保留等待/已回答/取消等有界元数据，不把用户答案复制进公开工具日志。完整问题只返回发起用户。

## 接口

- `GET /api/v1/projects/{projectId}/ai/clarifications`
- `POST /api/v1/projects/{projectId}/ai/clarifications/{questionId}/answer`
- `POST /api/v1/projects/{projectId}/ai/clarifications/{questionId}/cancel`
- `POST /api/v1/creation-drafts/{draftId}/clarifications/{questionId}/answer`
- `POST /api/v1/creation-drafts/{draftId}/clarifications/{questionId}/cancel`

回答携带问题 `expectedRevision`，以及三选一的 `option`、`text` 或 `undecided:true`。项目 GET job 在等待时只对发起人附带完整 `result.clarification`，草稿响应包含 `clarification`。OpenAPI 和前端类型已同步生成。

## 云端验证与边界

- 新增后端项目/草稿澄清测试：22 项通过；包含恢复、幂等、并发、撤权、过期、三轮上限、旧协议调用 ID 重用、原提示词检查点迁移、未知派发和崩溃恢复
- 新增前端与相关流程重点测试：56 项通过
- 两端类型检查、前端 lint/build、Worker Service Binding 检查通过
- 增量迁移保留检查：75 个既有表的全部旧字段/行与外键关系保持不变
- 真实模型、付费 AI、生产数据库/账号配置未调用或修改
- `scripts/verify-ai-clarification-ui.cjs` 为仅限 loopback 的桌面及 390px 移动端 fixture 验收脚本，语法检查通过。云端 Chromium 在启动时遭遇 `socket() failed: Operation not permitted`，未完成真实视觉验收；保留到允许使用 Mac 时补测
- 标准 `tsx` CLI 在云端创建 IPC socket 时受限；使用 `node --import tsx scripts/export-openapi.ts` 在相同权限内运行生成脚本成功
- 已将首页待办分组、邀请入口改动与最新上游 `d3183c3` 安全整合；最终稳定代码完整后端 **86 文件 / 792 项**、前端 **95 文件 / 526 项**测试通过。上游工具 schema、参数校验与错误反馈全部保留
- 独立并发/恢复复核发现并修复取消请求输给回答请求时的日志误标问题，回归验证失败的取消不会更改已回答日志；新增接口响应强制 `Cache-Control: no-store`
- 完整后端测试退出码为0，仍有既有 workerd/RPC 收尾及 fixture 结束后的 DNS/取消请求警告，未隐藏。开发中跨版本取样和首次前端等待任意请求的测试竞态已修正并用最终稳定代码完整重跑，不作为未解决故障
- 外部真模型、生产 HTTP、独立 dev 服务端到端联调和真实浏览器视觉测试不在本次通过声明中；新接口通过 Workers 测试运行时的真实 HTTP 路由、D1/R2 和受控模型响应验证

## 发布状态

按用户最新要求，本轮只推送 GitHub；没有部署 Cloudflare Workers，没有应用远端迁移。新增功能只有未来明确批准迁移和部署后才会在生产生效。未来发布顺序仍为现有 D1 增量迁移、后端、前端；不新建 Worker。
