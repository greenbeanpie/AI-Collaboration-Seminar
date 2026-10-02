# 团队协作修复与改进验收

日期：2026-10-03（Asia/Singapore）。

## 交付

- 项目文件和成果附件贡献人快照，多选、全选、半选，派生图片继承归属。
- 团队信息只读访问；四项操作授权与普通成员/协作管理员模板。负责人及项目内平台管理员可授予权限，团队管理者不可转授权。
- 全组共享答辩；发起人独占回答、结束、重试，服务器处理锁防止并发，保留回答作者。
- 已领取任务最后一个前置完成时定向通知，事务去重、重开再提醒、转派后权限复核。
- 任意已完成上游任务的双方私人质询，固定参与者、实际完成者或代答身份，双向通知。
- 根路由/工作区错误边界及局部错误详情，可展开、复制、手选，隐藏敏感诊断字段。

## 验证

- 后端全量：82 个测试文件、753 项测试通过。
- 前端全量：87 个测试文件、455 项测试通过。最后的答辩评分修正权限调整另跑后端 29 项、前端 6 项通过。
- 两端 typecheck、前端 lint、生产构建、Service Binding 转发检查通过。
- scripts/verify-collaboration.mjs：43 项真实本地 HTTP 检查通过。
- scripts/verify-integration.mjs：105 项真实本地 HTTP 检查通过。
- agent-browser 两个独立真实登录会话验证普通成员团队页、权限模板保存与撤销、质询双向发送、答辩旁观只读、贡献默认本人及全选上传、资料页返回团队页缓存一致性；没有浏览器页面错误。
- 本地 Wrangler 已成功执行 0034–0038，包含就绪通知触发器。

## 发布与数据保留

- 复用既有 Cloudflare Workers、D1 和 R2；发布前完整 D1 导出保存在 Git 忽略的 .local-secrets/production-before-collaboration.sql。
- 本次只执行 0034–0038。既有 0033_remove_manual_ledger.sql 尚未在生产执行且会删表；为了保留数据，本次明确不执行。未来不要未经核对直接运行全目录迁移。
- 0037 回填仅建立就绪基线，不发送旧任务通知。历史文件显示未标记；历史回答作者使用答辩创建者回填。
- 回退应用代码可以使用发布前 Worker 版本；新增表和列应保留，不运行破坏性数据库回退。

## 证据边界

截图引用的是旧 TeamWorkspacePage 构建；当前线上脚本没有该 join 调用，因此没有宣称复现或确定该历史报错的具体字段。当前普通成员访问已通过真实浏览器与 API 回归。真实设备的系统 Web Push 弹窗尚未实测；站内通知和推送 outbox 的事务及发送权限由 Worker 测试验证。

## 修改文件

- backend/migrations/0034_member_permissions.sql
- backend/migrations/0035_file_contributors.sql
- backend/migrations/0036_rehearsal_ownership.sql
- backend/migrations/0037_task_readiness.sql
- backend/migrations/0038_task_inquiries.sql
- backend/openapi/openapi.json
- backend/src/api/collaboration.ts
- backend/src/api/files.ts
- backend/src/api/invitations.ts
- backend/src/api/jobs.ts
- backend/src/api/materials.ts
- backend/src/api/members.ts
- backend/src/api/project-simplification.ts
- backend/src/api/projects.ts
- backend/src/api/rehearsals.ts
- backend/src/api/resources.ts
- backend/src/api/reviews.ts
- backend/src/api/sources.ts
- backend/src/api/task-inquiries.ts
- backend/src/api/tasks.ts
- backend/src/api/username-invitations.ts
- backend/src/app.ts
- backend/src/core/auth.ts
- backend/src/env.ts
- backend/src/services/assessment-corrections.ts
- backend/src/services/collaboration-ai.ts
- backend/src/services/collaboration-evaluation.ts
- backend/src/services/collaboration.ts
- backend/src/services/creation-drafts.ts
- backend/src/services/file-contributors.ts
- backend/src/services/file-lifecycle.ts
- backend/src/services/files.ts
- backend/src/services/notifications.ts
- backend/src/services/project-ai-tools.ts
- backend/src/services/project-permissions.ts
- backend/src/services/project-simplification.ts
- backend/src/services/rehearsal.ts
- backend/src/services/task-readiness.ts
- backend/src/services/username-invitations.ts
- backend/test/102-project-simplification.test.ts
- backend/test/108-file-contributors.test.ts
- backend/test/114-rehearsal-ownership.test.ts
- backend/test/117-legacy-ai-evidence.test.ts
- backend/test/121-member-permissions.test.ts
- backend/test/121-task-messaging.test.ts
- backend/test/85-collaboration.test.ts
- backend/test/87-a-items-coverage.test.ts
- backend/test/97-file-recycle.test.ts
- backend/test/setup.ts
- frontend/src/App.tsx
- frontend/src/api/client.ts
- frontend/src/api/openapi.ts
- frontend/src/api/simplification.ts
- frontend/src/components/FileContributors.test.tsx
- frontend/src/components/FileContributors.tsx
- frontend/src/components/WorkspaceErrorBoundary.test.tsx
- frontend/src/components/WorkspaceErrorBoundary.tsx
- frontend/src/components/error-diagnostics.ts
- frontend/src/components/ui.tsx
- frontend/src/main.tsx
- frontend/src/pages/AssessmentWorkspacePage.tsx
- frontend/src/pages/CollaborationWorkspace.tsx
- frontend/src/pages/MaterialAttachments.tsx
- frontend/src/pages/MaterialsPage.tsx
- frontend/src/pages/MemberPermissions.tsx
- frontend/src/pages/ProjectFileLibrary.tsx
- frontend/src/pages/RehearsalsPage.tsx
- frontend/src/pages/SourcesPage.tsx
- frontend/src/pages/TaskInquiries.test.tsx
- frontend/src/pages/TaskInquiries.tsx
- frontend/src/pages/TeamPage.tsx
- frontend/src/pages/source-workflows.ts
- frontend/src/project-permissions.ts
- frontend/vite.config.ts
- scripts/verify-collaboration.mjs
- scripts/verify-integration.mjs

## 已执行生产发布

- main 已快进合并并推送，应用代码版本 e619433（后续记录提交仅更新验收脚本及本文）。
- 后端 Worker 版本：eb89001e-e69a-42bc-8e41-9e1a363aab57。
- 前端 Worker 版本：45f24ad7-615d-4bf1-8663-35dd4154a53d。
- 已执行生产迁移 0034–0038；0033 未执行，旧台账表保留。
- 迁移前后 8 类记录数完全相同：users=5、projects=6、files=2、tasks=12、rehearsals=1、contributions=0、decisions=0、resource_references=0；基线回填未发送 task_ready 通知。
- https://team.greenbp.dpdns.org 与 workers.dev 的 health 均为 200；生产 D1/R2 依赖检查均为 ok。
- 线上入口 index-DhgHQZXi.js 的 SHA-256 与已验证本地构建一致；线上登录页面浏览器无 page error。
- 既有普通验收账户实际生产登录返回 201。保存的生产管理员密码返回 401，未重置真实账号；生产双账号权限/任务验收未完成。新增 scripts/verify-collaboration-production.mjs 用于提供有效的已有生产凭据后复核，并通过 --cleanup 归档临时验收项目、撤销测试会话。
