# AI 内容引用标识验收（2026-10-05）

## 交付要求与实现

- 项目内容显示、填写和历史查看处增加蓝色圆角胶囊标识，文字为“AI 会引用”；形状参照提供的“已通过”标签。
- `AiReferenceBadge` 统一呈现样式、说明和显示偏好，`Field` / `SectionCard` 提供显式 `aiReference` 属性，不通过字段名称关键字猜测用途。
- 默认显示；在“设置 → 外观 → AI 内容引用标识”切换。偏好以 `buwei:ai-reference-badges:<accountId>` 保存在本浏览器，按账户隔离，支持刷新、重新登录及浏览器标签页同步；更换设备需分别设置。开关只控制标识显示，不改变已有 AI 授权或后台读取权限。
- Provider 在登录账户的 AppShell 内，覆盖项目内容、创建模板与 React portal 弹窗。输入项及标题内的装饰标识不改变现有可访问名称；独立内容块的标识可由辅助技术读取。打印时隐藏标识，不把告知文本写入用户正文。

## 覆盖核查

核查以实际后端 AI 数据入口和 JSX 内容节点为依据；下表包含现行页面、创建预览、固定版本和历史记录。

| AI 可引用内容 | 后端读取证据 | 前端标识位置 |
| --- | --- | --- |
| 项目名称、简介、截止、主目标 | `services/project-context.ts` 的项目背景读取 | ProjectShell、ProjectOverviewPage、ProjectSettingsPage、ProjectGoalSettings、DashboardPage |
| 来源标题、地址、文件、原文及正文片段 | `project-context.ts`、`project-ai-tools.ts` 的来源读取 | SourcesPage、SourceFullText、SourceProcessingCard、ResourceIndexView、ProjectSourceContext、ProjectFileLibrary |
| 文档标题、用途、正文及历史版本 | `project-context.ts` 的材料读取 | DataWorkspacePage、MaterialsPage、MaterialDocumentView、FixedMaterialVersions |
| 附件与任务成果文件 | `agent-bridge-context.ts`、`task-assistance-plan.ts` | MaterialAttachments、TaskFileUploads、文件库及绑定成果预览 |
| 任务内容、标准、工时、日期、执行人、状态和依赖 | `project-context.ts` 的 list_tasks / read_task | CollaborationWorkspace、TaskSettings、任务创建及修改、PendingTaskPreview、DashboardPage |
| 提交正文、固定文件、验收及 AI 反馈 | `project-context.ts` 的 read_submission、`collaboration-ai.ts` | SubmissionBody、提交详情、BoundMaterialVersion、验收输入和反馈显示 |
| 要求、评分维度、权重、说明和原文引用 | `project-context.ts` 的 read_project_standards、`project-reference-guard.ts` | StandardsEditor、StandardSummary、TemplateDraftWorkspace、ReferencePicker |
| 持续反馈和历史版本 | `gateway.ts` 的项目反馈追加、read_admin_feedback | CollaborationWorkspace 的填写区和每条历史记录 |
| AI 方案、人工修改内容和理由 | read_project_plan / `project-reference-guard.ts` | ProposalPreview、ProposalCorrection、建议历史 |
| 评分总分、总结、分项评语、证据、限制和人工修正 | read_assessment / `project-reference-guard.ts` | AssessmentWorkspacePage、ReviewsPage、ManualAssessmentEditor、AssistiveRubricScores |
| 项目事件及协作评论 | read_project_history | LedgerPage 每条事件、CommentsPanel 的每条正文及填写区 |
| 成员角色、责任人 ID 和任务工作量 | read_member_workload | TeamPage、任务分工显示和输入 |
| 已授权的个人介绍、专业、技能、倾向职位 | `personal-profiles.ts` 的 ai_use_allowed 检查及 recommendationDispatch | PersonalProfiles，仅当前资料允许 AI 使用时标记；每周时间始终不标记 |
| AI 指导输入及上下文会话 | `agent.ts`、`guide-history.ts` | AiWorkspacePage、任务执行计划、TaskAgentHandoff 执行提示词、TaskBridgeHandoff 成果说明 |
| 演练范围、问题、回答、确认字幕、点评和总结 | `rehearsal.ts` | RehearsalsPage、RehearsalVoicePanel |
| 澄清问题、选项和自由回答 | `ai-clarifications.ts`、项目 AI 工具恢复上下文 | AiClarificationCard |
| 公开搜索查询及保存引用 | 项目 AI 公开搜索工具 | ProjectSearchOption、SearchCitations |
| 创建草稿整份项目上下文及预览 | `creation-drafts.ts` 的 project:payload 输入 | CreateProjectPage、LegacyCreateProjectPage、CreationBehaviorFields、TemplateDraftWorkspace：项目/目标/文件/人数与邀请/要求/文档/任务/依赖/标准 |

未标记：界面搜索/筛选、翻页/选择历史轮次、正文解析方式、执行设备、账户密码、供应商 API key、设备凭据、通知投递偏好、私密任务质询。私密质询无 AI 读取入口；个人每周总可用时间不进入 AI 推荐。

## 修改文件

公共实现：`src/ai-reference-preferences.ts`、`components/AiReferencePreferencesProvider.tsx`、`components/AiReferenceBadge.tsx` 与 CSS、`components/ui.tsx`、`components/AppShell.tsx`、`pages/AppearanceSettings.tsx`、`App.tsx`。

页面与组件修改范围见上表；回归测试增加 `components/AiReferenceBadge.test.tsx`、个人资料授权断言及 `e2e/ai-reference-badges.mjs`。以上 `src` / `components` / `pages` 均位于 `frontend/src/`。

## 验证

- 前端全量：129 个文件、778 项测试通过。显示默认值、即时隐藏、重挂载持久化、账户切换隔离、跨标签页 storage 更新、存储失败时即时生效、原表单名称、个人资料授权条件均有回归断言。
- 前端类型检查、lint、生产构建及 `git diff --check` 通过。
- 真实 Edge + 生产构建浏览器验收：任务/项目输入、材料编辑器、标准维度与权重、成员负荷，蓝色样式与 999px 圆角，390px 窄屏，深色主题，设置关闭/刷新持久化/跨标签页和 portal 表单同步均通过。页面运行错误为零。
- 使用固定 API 夹具，无生产写入、无模型调用。自动脚本：`frontend/e2e/ai-reference-badges.mjs`，运行需 `PLAYWRIGHT_CORE` 指向已安装模块，并启动 `npm run preview -- --port 5175`。
- 浏览器结果与截图：`output/ai-reference-verification/result.json`、`tasks-light.png`、`task-form-mobile.png`、`tasks-mobile.png`、`materials-light.png`、`settings-dark.png`。

本记录中的本地验收随后已于 2026-10-05 发布到生产；版本与线上验证详见 `offline-ai-reference-release-20261005.json`。
