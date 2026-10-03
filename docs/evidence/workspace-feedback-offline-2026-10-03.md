# 项目工作台、持续反馈和离线修复验收

日期：2026-10-03（Asia/Singapore）。本轮在本地实现及验收，未部署生产环境，未调用付费真实模型。

## 已实现

1. 普通成员不能直接创建邀请码或发送用户名邀请。用户名邀请改为申请，项目管理员批准后才发送；团队页面提供审批列表，概览提示待批准申请。
2. 删除独立项目反馈表单，持续反馈统一放入“AI 拆解、调整与分工”。可保存、清空、查历史；旧项目反馈合并导入，任务与方案反馈保持原作用范围。
3. 项目 AI 作业冻结完整持续反馈版本，由模型网关统一注入上下文。后续反馈修订不会改变旧作业或续跑使用的版本；超限明确拒绝。
4. 从未认领或执行过的任务允许生成整套替换方案，管理员确认后归档旧任务。曾开始后只能提出调整或补充，任务方案必须显式批准，自动推进不能绕过。退回待开始不会清除开始历史。
5. AI 弹窗标题栏直接显示历史入口；任务规划、材料检查和答辩采用独立优先参考选择页。固定历史版本不会因新版本出现而被自动替换。
6. 搜索启用开关归入系统管理员 AI 配置，服务端统一执行。旧配置缺省关闭，并兼容原探测证据；真正修改搜索授权仍要求重新探测。
7. 修改 OpenCode 预设地址自动转自定义并保留协议、显式密钥及其他输入；维持已保存密钥的目的地址约束。
8. 演练自动发现并冻结成果，优先参考资料与评价成果区分。人工修正只针对历史中的单次已有记录，使用独立 `scoreCorrect` 授权，保留原 AI 结果、审计和版本校验。
9. 概览左侧主目标，右侧完成度与待办；手机纵向排列。删除成员和材料版本指标卡，待确认要求并入待办。
10. 生产构建缓存页面外壳及路由资源（包含 PDF worker）；本机账户和项目快照存入 IndexedDB。断网可打开已缓存项目，编辑材料、创建或修改任务、记录评论及提交草稿；本机操作联网后通过幂等同步接口提交，仍执行原权限及版本校验。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 后端完整测试 | 90 文件，809/809 通过 |
| 前端完整测试 | 100 文件，568/568 通过 |
| 前后端类型检查 | 通过 |
| 前端 lint、生产构建 | 通过，无 lint 告警 |
| `git diff --check` | 通过 |
| 0040–0042 增量迁移 | 80 张旧表原字段与记录保留，旧权限保留、评分修正默认关闭、开始标记不可回退、外键完整 |
| 单独反馈迁移 | 78 张旧表记录保留，项目反馈按时间导入、局部反馈保持作用范围 |
| 浏览器界面 | 本地 HTTP 夹具；邀请、反馈保存顺序、历史、参考选择、评分权限、预设地址保存、明暗主题、桌面及390px手机布局通过，无 pageerror |
| 真实断网浏览器 | 生产构建 Service Worker 安装、断网刷新、任务深链接、离线创建任务、材料编辑、本机保存后刷新、关闭及重开浏览器通过 |
| 联网自动同步 | 离线任务创建及材料版本各提交一次，本机队列清空，无 pageerror |

文件选择页浅色主题对比度由原错误配色的 1.20:1 修复为 13.61:1；明暗主题均通过 4.5:1 下限检查。桌面主目标与右侧内容顶部对齐，390px 手机纵向排列且无横向溢出。

Cloudflare 测试运行仍出现原有 RPC stub/取消请求 teardown 诊断；完整测试退出码为0，全部809项通过，未屏蔽这些诊断。

## 复现命令

在仓库根目录运行：

```powershell
npm run typecheck
npm run lint
npm run test:frontend
npm run test:backend
npm run build
python backend/test/workspace-migration-preservation.py
python backend/test/permanent-feedback-migration-preservation.py
```

使用真实 Python 可执行文件；WindowsApps 的 Python 占位程序不适用。契约已统一执行 `npm run export:openapi --prefix backend` 与 `npm run typegen --prefix frontend`。

生产构建浏览器验收：

```powershell
npm run preview --prefix frontend -- --port 5175
node scripts/verify-ui-regressions.mjs http://127.0.0.1:5175 output/ui-regressions-20261003
$env:PLAYWRIGHT_CORE = '<已安装的 playwright 或 playwright-core 包路径>'
Push-Location frontend
node e2e/offline-workspace.mjs
Pop-Location
```

脚本使用本地夹具账户，不能指向生产站点。界面脚本阻止外部请求；离线脚本允许本地静态资源与 Service Worker，使用真实浏览器断网及持久化用户目录。

本机证据：`output/ui-regressions-20261003/results.json`、`output/offline-verification/result.json`、同目录截图及 `output/verification-*.log`。这些输出被 Git 忽略，重复脚本可以重新生成。

## 使用与部署边界

- 先联网登录并打开项目，等待“此项目已准备离线使用”；首次访问、未缓存内容、已清除浏览器存储的内容需要联网。
- 材料编辑先保存为本机草稿；点击“保存到本机，联网同步”才进入待同步队列。无冲突自动同步；同字段或正文冲突保留双方内容，管理员撤权或任务归档导致的拒绝不会被强行覆盖。
- 离线不能执行 AI、批准方案、发送邀请或写系统配置。已排队提交恢复网络后仍可能按既有项目设置触发在线验收。
- 本轮已验证 Edge 浏览器持久化用户目录重开；未实际安装并重开原生桌面 PWA 窗口，未验证其他浏览器、真实设备推送或生产两账户流程。
- 未验证真实供应商模型输出质量。浏览器 API 保存流程使用夹具，实际权限、事务、版本及幂等行为由 Workers/D1 后端测试验证。
- 部署需备份后只追加 `0040`、`0041`、`0042`，不要因此补跑历史破坏性迁移 `0033`。前后端须配套发布，现有数据库、资源ID和凭据不重建。

## 修改文件

以下清单包含本轮实现、契约及验证文件；不包含用户原有未跟踪 bundle。

- `backend/migrations/0040_invitation_task_approval.sql`
- `backend/migrations/0041_project_feedback_versions.sql`
- `backend/migrations/0042_score_correction_permissions.sql`
- `backend/openapi/openapi.json`
- `backend/src/ai/config.ts`
- `backend/src/ai/gateway.ts`
- `backend/src/api/admin.ts`
- `backend/src/api/ai-tools.ts`
- `backend/src/api/collaboration.ts`
- `backend/src/api/invitation-requests.ts`
- `backend/src/api/invitations.ts`
- `backend/src/api/jobs.ts`
- `backend/src/api/offline-sync.ts`
- `backend/src/api/project-simplification.ts`
- `backend/src/api/rehearsals.ts`
- `backend/src/api/tasks.ts`
- `backend/src/api/username-invitations.ts`
- `backend/src/app.ts`
- `backend/src/services/agent.ts`
- `backend/src/services/assessment-corrections.ts`
- `backend/src/services/assessments.ts`
- `backend/src/services/collaboration-ai.ts`
- `backend/src/services/collaboration.ts`
- `backend/src/services/jobs.ts`
- `backend/src/services/parse.ts`
- `backend/src/services/project-ai-tools.ts`
- `backend/src/services/project-context.ts`
- `backend/src/services/project-feedback.ts`
- `backend/src/services/project-permissions.ts`
- `backend/src/services/project-progression.ts`
- `backend/src/services/project-simplification.ts`
- `backend/src/services/rehearsal.ts`
- `backend/src/services/task-planning-policy.ts`
- `backend/src/services/username-invitations.ts`
- `backend/test/102-project-simplification.test.ts`
- `backend/test/104-ai-progression.test.ts`
- `backend/test/108-background-preview.test.ts`
- `backend/test/109-project-reference-guard.test.ts`
- `backend/test/114-native-search-slices.test.ts`
- `backend/test/121-member-permissions.test.ts`
- `backend/test/124-invitation-task-approval.test.ts`
- `backend/test/124-permanent-feedback.test.ts`
- `backend/test/126-offline-sync.test.ts`
- `backend/test/22-unified-model.test.ts`
- `backend/test/89-collaboration-ai.test.ts`
- `backend/test/92-project-ai-assistant.test.ts`
- `backend/test/93-collaboration-source-context.test.ts`
- `backend/test/98-project-ai-tools.test.ts`
- `backend/test/permanent-feedback-migration-preservation.py`
- `backend/test/workspace-migration-preservation.py`
- `docs/evidence/workspace-feedback-offline-2026-10-03.md`
- `frontend/e2e/offline-workspace.mjs`
- `frontend/src/api/client.ts`
- `frontend/src/api/openapi.ts`
- `frontend/src/auth.ts`
- `frontend/src/components/AppShell.tsx`
- `frontend/src/dialogs/Modal.tsx`
- `frontend/src/main.tsx`
- `frontend/src/offline/OfflineWorkspaceStatus.tsx`
- `frontend/src/offline/offline.css`
- `frontend/src/offline/offline.test.ts`
- `frontend/src/offline/queue.ts`
- `frontend/src/offline/store.ts`
- `frontend/src/offline/sync.ts`
- `frontend/src/pages/AiSettings.test.tsx`
- `frontend/src/pages/AiSettings.tsx`
- `frontend/src/pages/AssessmentWorkspacePage.tsx`
- `frontend/src/pages/CollaborationWorkspace.clarification.test.tsx`
- `frontend/src/pages/CollaborationWorkspace.test.tsx`
- `frontend/src/pages/CollaborationWorkspace.tsx`
- `frontend/src/pages/InvitationRequests.tsx`
- `frontend/src/pages/ManualAssessmentEditor.tsx`
- `frontend/src/pages/MaterialsPage.tsx`
- `frontend/src/pages/MemberPermissions.tsx`
- `frontend/src/pages/ProjectAiFeedback.tsx`
- `frontend/src/pages/ProjectAiTools.tsx`
- `frontend/src/pages/ProjectOverviewPage.tsx`
- `frontend/src/pages/ProjectWorkspace.css`
- `frontend/src/pages/ProposalCorrection.tsx`
- `frontend/src/pages/ReferencePicker.test.tsx`
- `frontend/src/pages/ReferencePicker.tsx`
- `frontend/src/pages/RehearsalsPage.tsx`
- `frontend/src/pages/TeamPage.test.tsx`
- `frontend/src/pages/TeamPage.tsx`
- `frontend/src/project-permissions.ts`
- `frontend/vite.config.ts`
- `scripts/verify-ui-regressions.mjs`
