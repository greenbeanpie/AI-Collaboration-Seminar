# AI 处理状态与断点续跑

本次实现覆盖真实工作区各功能内部的 AI 请求，不增加项目级总面板。状态组件显示真实执行状态、当前操作、最近模型返回的服务器时间（设备本地时区，精确到秒）、可展开的分页操作记录和失败续跑。旧数据没有可靠模型返回时间时显示“尚未收到回复”，不从创建时间或调度更新时间补造。

## 功能覆盖

| 功能 | 状态和恢复入口 |
| --- | --- |
| 创建项目 AI 预览与追问 | 私有草稿活动、操作历史、保留预览尝试及已完成工具结果 |
| 创建草稿的文件、音视频处理 | 文件关联任务、转录/分块阶段、已有响应缓存 |
| 任务拆分、调整、分配、自动推进 | 协作最近任务的服务端关联、统一状态和续跑 |
| 任务摘要、AI 适用性、辅助计划 | 缓存保留 jobId，完成后或刷新后仍能读取活动 |
| 成果生成与带做 | 会话关联执行任务，继续已有对话/资料调查 |
| 项目标准生成 | 当前标准读取返回最近生成任务，失败从已完成步骤继续 |
| 资料解析、OCR、要求提取、文件总结 | 固定来源版本的任务关联；成功页/文档块复用 |
| 音视频理解与总结 | 转录、质量检查、已完成窗口和总结复用 |
| 材料预审、评分、任务成果评价 | 业务记录关联任务；保留输入版本和人工确认规则 |
| 答辩提问、评价与总结 | 最近 AI 任务关联，刷新恢复，保留已完成回合 |

系统本地朗读保持播放状态，不作为模型处理或模型回复。

## 接口与存储

- 迁移 `0061_ai_activity.sql` 新增 `ai_task_activities`、`ai_activity_events`，任务创建和状态转换由数据库触发器捕获。
- `GET /api/v1/jobs/{jobId}` 返回 `activity`、`updatedAt`、`finishedAt`，自动跟随续跑任务链。`activity` 包含阶段、阶段时间、最后回复时间、分块进度、续跑能力/原因和结果不明标记。
- `GET /api/v1/jobs/{jobId}/activity-events?cursor=0&limit=20` 分页读取跨尝试操作记录。
- 草稿读取返回同样的 `activity`；`GET /api/v1/creation-drafts/{draftId}/activity-events` 只允许草稿拥有者读取。
- 协作最近活动、标准生成、资料处理、预审及答辩读取提供服务端任务关联，完成后不会丢失展示。
- `POST /api/v1/jobs/{jobId}/retry` 复用与自动/管理员重试相同的资格检查，生成独立执行尝试并保持断点根标识；幂等和唯一后继约束阻止重复创建。
- 模型响应及调查内容加密保存在私有 R2；响应对象不可覆盖，调查写入按执行尝试隔离，防止迟到旧尝试覆盖新断点。活动接口不返回提示词、工具参数、原始响应或私有存储地址。

## 恢复规则

已保存的模型响应先用于重新校验和保存，成功 OCR 页、文档块、转录、媒体窗口和工具结果不会重新处理。输入、来源生命周期、任务版本、标准、模型配置和权限变化时拒绝旧断点，展示无法续跑原因。

单次请求无法恢复模型内部生成位置。上次请求结果不明时，自动重试不会重放；用户点击“从停止处继续”直接重新请求未完成步骤，无额外确认弹窗，界面说明该步骤可能再次计费。新请求的授权只消费一次。

已完成的评价不重新生成；失败评价仅恢复同一提交轮次。预审、答辩和评分的旧执行尝试不能发布结果或把续跑业务记录改为失败。

## 验证

使用受控模型响应，无真实付费模型调用。验证结果和完整文件清单见下方执行记录。

```sh
npm run typecheck
npm run lint
npm run test:backend
npm run test:frontend
VITE_BUILD_VERSION=$(git rev-parse --short HEAD) npm run build
npm run check:migrations
npm run check:secrets
npm run verify:worker
npm run verify:integration
node scripts/verify-ai-activity-ui.mjs http://127.0.0.1:4173
```

HTTP 检查要求本地前后端服务和本地管理员已初始化；浏览器脚本使用内置本机 API fixture，默认采用本机 Chrome，可通过 `PLAYWRIGHT_MODULE`、`CHROME_EXECUTABLE` 指定运行时和浏览器。报告及截图生成在 `output/ai-activity/browser/`。

本地迁移和验证不代表生产发布。本轮未部署 Worker、未应用远端数据库迁移、未进行真实供应商调用验收。

## 本次执行记录（2026-10-07）

- 后端全量：137 个文件、1226 项测试通过；前端全量：141 个文件、858 项测试通过。后续帮助页面文档变更单独验证。
- typecheck、lint、生产构建、61 个迁移完整性检查、Secrets 检查、Worker Service Binding 检查均通过。
- 本地应用全部迁移；104 项真实 HTTP 检查通过，包含新增状态/回复时间断言；验证项目已归档。
- 1440px 桌面和 390px 手机实际浏览器通过：回复时间到秒、真实分块、操作历史、未知结果直接续跑、状态读取失败独立重读、执行动画、完成停止动画、刷新恢复、减少动画和无横向溢出。浏览器未报页面错误。
- 数据库字典补齐此前遗漏结构，并加入本次活动表；校验 121 张表、1087 列、DDL、外键、索引、触发器及视图均与迁移一致。
- 后端测试环境有 Workflow 收尾时的取消请求告警，未隐藏；所有测试断言通过。供应商请求结果未持久化且无法确认时，主动续跑可能重复计费。

## 更改文件

<details>
<summary>完整文件清单</summary>

- `backend/migrations/0061_ai_activity.sql`
- `backend/openapi/openapi.json`
- `backend/src/ai/gateway.ts`
- `backend/src/ai/gemini-media.ts`
- `backend/src/ai/mimo-media.ts`
- `backend/src/api/collaboration.ts`
- `backend/src/api/creation-drafts.ts`
- `backend/src/api/jobs.ts`
- `backend/src/api/project-simplification.ts`
- `backend/src/api/rehearsals.ts`
- `backend/src/api/reviews.ts`
- `backend/src/api/source-processing.ts`
- `backend/src/services/admin-ai-retries.ts`
- `backend/src/services/agent.ts`
- `backend/src/services/ai-activity.ts`
- `backend/src/services/ai-automatic-retries.ts`
- `backend/src/services/ai-checkpoints.ts`
- `backend/src/services/assessments.ts`
- `backend/src/services/audio-pipeline.ts`
- `backend/src/services/creation-drafts.ts`
- `backend/src/services/draft-preview-jobs.ts`
- `backend/src/services/jobs.ts`
- `backend/src/services/media-summary.ts`
- `backend/src/services/parse.ts`
- `backend/src/services/project-ai-tools.ts`
- `backend/src/services/project-investigation.ts`
- `backend/src/services/rehearsal.ts`
- `backend/src/services/review.ts`
- `backend/src/services/source-summary.ts`
- `backend/src/services/task-summary.ts`
- `backend/test/111-investigation-continuation.test.ts`
- `backend/test/114-native-search-slices.test.ts`
- `backend/test/117-legacy-ai-evidence.test.ts`
- `backend/test/127-automatic-task-evaluation.test.ts`
- `backend/test/128-media-summary.test.ts`
- `backend/test/134-task-assistance.test.ts`
- `backend/test/140-automatic-ai-retries.test.ts`
- `backend/test/168-ai-response-checkpoints.test.ts`
- `backend/test/169-ai-activity.test.ts`
- `backend/test/96-creation-drafts.test.ts`
- `docs/AI-ACTIVITY.md`
- `docs/evidence/help/handover/document-verification.json`
- `frontend/src/api/ai-activity.ts`
- `frontend/src/api/openapi.ts`
- `frontend/src/components/AiActivityStatus.test.tsx`
- `frontend/src/components/AiActivityStatus.tsx`
- `frontend/src/components/ai-activity.css`
- `frontend/src/features/collaboration/JobProgress.tsx`
- `frontend/src/features/sources/SourceRecord.tsx`
- `frontend/src/help/DATABASE-SCHEMA.md`
- `frontend/src/help/TECHNICAL-IMPLEMENTATION.md`
- `frontend/src/help/USER-GUIDE.md`
- `frontend/src/pages/AiWorkspacePage.tsx`
- `frontend/src/pages/AssessmentWorkspacePage.test.tsx`
- `frontend/src/pages/AssessmentWorkspacePage.tsx`
- `frontend/src/pages/CollaborationWorkspace.clarification.test.tsx`
- `frontend/src/pages/CollaborationWorkspace.test.tsx`
- `frontend/src/pages/CollaborationWorkspace.tsx`
- `frontend/src/pages/CreateProjectPage.tsx`
- `frontend/src/pages/JobAiActivity.test.tsx`
- `frontend/src/pages/JobAiActivity.tsx`
- `frontend/src/pages/ProjectFileLibrary.test.tsx`
- `frontend/src/pages/ProjectSourceContext.test.tsx`
- `frontend/src/pages/ProjectSourceContext.tsx`
- `frontend/src/pages/RehearsalsPage.tsx`
- `frontend/src/pages/ReviewsPage.tsx`
- `frontend/src/pages/SourceProcessingCard.test.tsx`
- `frontend/src/pages/SourceProcessingCard.tsx`
- `frontend/src/pages/StandardsEditor.test.tsx`
- `frontend/src/pages/StandardsEditor.tsx`
- `frontend/src/pages/TaskAgentEligibilityNotice.tsx`
- `frontend/src/pages/TaskAgentHandoff.tsx`
- `frontend/src/pages/TaskAiAssistance.test.tsx`
- `frontend/src/pages/TaskAiAssistance.tsx`
- `frontend/src/pages/TemplateDraftWorkspace.test.tsx`
- `frontend/src/pages/TemplateDraftWorkspace.tsx`
- `frontend/src/pages/aiWorkflowSupport.polling.test.tsx`
- `frontend/src/pages/aiWorkflowSupport.tsx`
- `frontend/src/pages/template-workspace.test.ts`
- `scripts/verify-ai-activity-ui.mjs`
- `scripts/verify-integration.mjs`

</details>
