# 系统技术说明：实现结构与维护验证

核对日期：2026-10-03。本文按现行路由、服务、迁移和测试编写；本次同步平级任务及待人工审核的实现说明。任务父子关系由增量迁移 `0043_remove_task_parent.sql` 移除。生产是否已应用迁移，应以发布验证记录和实际迁移状态为准；文末保留早期核对记录。

本文详细说明功能修改入口、数据归属、AI 请求执行链路及失败恢复条件，为代码阅读、系统维护与实现核对提供依据。先读代码地图、数据库关系和 AI 链路；需要某张表的全部字段或 DDL 时，打开[数据库完整结构字典](/app/help?doc=database)。资料整理、AI 评价及分数均为协作辅助结果，正式评审与供应商实际账单需要单独核验。

此前只读核对了生产数据库结构，不读取业务数据；该核对早于移除历史父任务字段的变更。文档不包含账户凭据、生产资源标识或模型密钥。代码路径相对仓库根目录，命令的环境与工作目录在对应章节标明。

## 1. 阅读顺序与代码地图

### 首次阅读顺序

本文依据当前工作区源码核对，先建立“页面 → API → 服务 → 数据表 → 后台作业”的地图，再阅读专项实现。建议依次阅读：根目录及两个子项目的 `package.json`；`frontend/src/App.tsx`、`components/ProjectNavigation.tsx`；`frontend/src/api/client.ts`；`backend/src/index.ts`、`app.ts`、`env.ts`；`core/auth.ts`、`services/project-permissions.ts`；相关 API 的 Zod 请求/响应与业务 handler；相应 service、迁移及测试。最后沿 `jobs.ts`、Workflows 与 AI gateway 深入异步执行。旧设计文档可解释历史背景，实际接口、权限和菜单以源码为准。

仓库不是前后端共同打包的单一应用。`backend/` 是 Hono Worker、D1/R2 访问、AI 服务和 Workflow；`frontend/` 是 React/Vite SPA 及转发 API 的独立 Worker；`scripts/` 是跨项目验证、发布预检和备份演练；`docs/` 记录历史决策及证据。根目录脚本使用 `--prefix` 分别执行两个项目；安装应使用各自锁文件的 `npm ci`，避免临时升级改变依赖版本。

### 功能修改入口

项目一级菜单当前只有概览、任务、资料、评分、团队五组。入口在 `ProjectNavigation.tsx` 的 `groups`；`App.tsx` 保留旧 URL 的 `ProjectRouteRedirect`，例如 sources/materials/ai 进入 data，requirements/reviews/rehearsals 进入 assessment。菜单扩展应以现行功能分组和路由映射为依据，不应按旧版页面数量重新增加菜单。`ProjectShell.useProject()` 提供项目上下文，使用 `['project', projectId]` 查询项目；页面必须位于该壳内。

| 需要修改的功能 | 前端入口 | 后端入口与深入阅读 |
| --- | --- | --- |
| 登录与个人账户 | `auth.ts`、`LoginPage.tsx`、`AccountSettingsPage.tsx` | `api/auth.ts`、`api/account-settings.ts`、`services/accounts.ts`、`password.ts` |
| 项目资料与材料编辑 | `DataWorkspacePage.tsx`、`SourcesPage.tsx`、`MaterialsPage.tsx` | `api/files.ts`、`sources.ts`、`materials.ts`、`resources.ts`；`services/files.ts`、`parse.ts`、`source-lifecycle.ts` |
| 任务分工与依赖 | `TasksPage.tsx`、`api/simplification.ts` | `api/tasks.ts`、`project-simplification.ts`；`services/project-simplification.ts`、`task-readiness.ts`、`assignment.ts` |
| 标准、评分及演练 | `AssessmentWorkspacePage.tsx` | `api/project-simplification.ts`、`reviews.ts`、`rehearsals.ts`；`services/assessments.ts`、`rehearsal.ts` |
| 成员与操作权限 | `TeamWorkspacePage.tsx`、`project-permissions.ts` | `api/members.ts`、`username-invitations.ts`；`services/project-permissions.ts` |
| AI 带做、工具、自动推进 | 页面中的 AI 入口、`api/collaboration.ts` | `api/agents.ts`、`ai-tools.ts`、`collaboration.ts`；`services/agent.ts`、`project-ai-tools.ts`、`project-progression.ts` |
| 活动历史与导出 | `LedgerPage.tsx`、`ExportPage.tsx` | `api/ledger.ts`、`project-simplification.ts`；`services/events.ts`、`project-context.ts` |
| 帮助文档 | `HelpPage.tsx`、`help/*.md` | Markdown 以 `?raw` 进入前端构建，无独立文档数据库 |

`services` 并非绝对的业务唯一位置：材料保存和任务部分写入直接在 API handler 内执行。修改前同时搜索 API 与 service 的 SQL，不能只根据文件名猜测业务边界。

### 关键文件的完整路径索引

| 调查对象 | 仓库根目录下的位置 |
| --- | --- |
| 前端入口、项目上下文和导航 | `frontend/src/main.tsx`、`frontend/src/App.tsx`、`frontend/src/components/ProjectShell.tsx`、`frontend/src/components/ProjectNavigation.tsx` |
| 请求、契约与协作客户端 | `frontend/src/api/client.ts`、`frontend/src/api/types.ts`、`frontend/src/api/openapi.ts`、`frontend/src/api/collaboration.ts`、`frontend/src/api/simplification.ts` |
| 资料与成果页面 | `frontend/src/pages/DataWorkspacePage.tsx`、`frontend/src/pages/SourcesPage.tsx`、`frontend/src/pages/MaterialsPage.tsx`、`frontend/src/pages/MaterialAiAssistance.tsx` |
| 任务、评分、成员 | `frontend/src/pages/TasksPage.tsx`、`frontend/src/pages/CollaborationWorkspace.tsx`、`frontend/src/pages/AssessmentWorkspacePage.tsx`、`frontend/src/pages/TeamWorkspacePage.tsx`、`frontend/src/project-permissions.ts` |
| 草稿与页面离开保护 | `frontend/src/storage.ts`、`frontend/src/pages/SettingsEditGuard.tsx`、`frontend/src/pages/settings-dirty.ts` |
| Worker与定时入口 | `frontend/src/worker.ts`、`backend/src/index.ts`、`backend/src/app.ts`、`backend/src/env.ts`、`backend/src/cron.ts` |
| 鉴权、权限、幂等 | `backend/src/core/auth.ts`、`backend/src/core/origin.ts`、`backend/src/services/accounts.ts`、`backend/src/services/project-permissions.ts`、`backend/src/services/idempotency.ts` |
| API与后台分发 | `backend/src/api/agents.ts`、`backend/src/api/collaboration.ts`、`backend/src/api/project-simplification.ts`、`backend/src/services/jobs.ts`、`backend/src/services/ai-jobs.ts` |
| Workflow和预算 | `backend/src/workflows/ai-job.ts`、`backend/src/workflows/parse-source.ts`、`backend/src/services/ai-execution-slices.ts`、`backend/src/services/budget.ts` |
| 工具、调查、证据 | `backend/src/services/project-ai-tools.ts`、`backend/src/services/project-context.ts`、`backend/src/services/project-investigation.ts`、`backend/src/services/project-evidence.ts`、`backend/src/services/project-reference-guard.ts` |
| 模型协议与调用审计 | `backend/src/ai/gateway.ts`、`backend/src/ai/transport.ts`、`backend/src/ai/tool-transport.ts`、`backend/src/ai/calls.ts`、`backend/src/ai/config.ts`、`shared/ai-providers.ts` |
| 来源与材料生命周期 | `backend/src/api/materials.ts`、`backend/src/services/files.ts`、`backend/src/services/source-lifecycle.ts`、`backend/src/services/source-inputs.ts`、`backend/src/services/parse.ts`、`backend/src/services/source-summary.ts` |
| 核心业务执行器 | `backend/src/services/agent.ts`、`backend/src/services/collaboration-ai.ts`、`backend/src/services/collaboration.ts`、`backend/src/services/assignment.ts`、`backend/src/services/assessments.ts`、`backend/src/services/review.ts`、`backend/src/services/rehearsal.ts` |
| 图、通知、推进、导出 | `backend/src/services/project-simplification.ts`、`backend/src/services/task-readiness.ts`、`backend/src/services/project-progression.ts`、`backend/src/services/notifications.ts`、`backend/src/api/ledger.ts` |

## 2. 系统组成与运行边界

```text
浏览器 React SPA（React Router / TanStack Query / Tiptap / PDF.js）
  ├─ 页面与帮助：前端 Worker → ASSETS
  └─ 同源 /api/v1：前端 Worker → API Service Binding → 后端 Hono Worker
      ├─ 请求中间件、Zod 契约、认证、项目操作权限 → API handler / service
      ├─ D1：实体、不可变版本、引用片段、状态、预算与审计元数据
      ├─ 私有 R2（FILES）：原文件、正文对象、AI 调用证据、调查检查点
      ├─ PARSE_WORKFLOW → ParseSourceWorkflow → runParseJob
      └─ AGENT_WORKFLOW → AgentRunWorkflow → executeAiSlice → runAiJob
定时 scheduled → handleScheduled：推进、通知、作业/分片恢复、预算/文件清理
```

主要运行组合为 React 19、React Router 7、Vite、TypeScript、Hono、Zod 与 Cloudflare Workers/D1/R2/Workflows。具体版本由两个子项目的锁文件决定，不能将 package.json 的范围表达式当成已安装精确版本。后端通过 nodejs_compat 使用密码 KDF 等兼容能力；浏览器不能直接访问 D1、R2 或模型密钥。

前端 Worker 的职责是静态资源与 API 转发；它不执行模型编排。后端 scheduled 使用 ctx.waitUntil 管理定时维护；模型长任务进入 Workflow，用户 HTTP 请求收到作业 ID 后读取状态。数据库提交、R2 写入和外部模型 HTTP 不构成一个全局事务，后文的幂等、预占、outbox、检查点及条件 SQL 都是为这个边界服务。

源码阅读主干：`frontend/src/App.tsx` → 对应 pages 页面 → `frontend/src/api/client.ts` → `frontend/src/worker.ts` → `backend/src/app.ts` → api 路由 → service → D1/R2 或 Workflow。接口完整清单来自 `backend/openapi/openapi.json`，上线版本也提供 `/api/v1/openapi.json`；两者可能因未发布源码不同而有差异，接口核对应比较二者。

## 3. 数据库结构与数据归属

### 源码核对先区分三类事实

`backend/migrations/*.sql` 是结构演进的事实源；`backend/src/services/*.ts` 和路由中的参数化 SQL 是运行时行为的事实源；生产 D1 的迁移记录与 `sqlite_master` 才是当前线上结构的事实源。不能凭文件名推断某个迁移已经应用，也不能把旧规划文档当成现行结构。

本节结构核对基于空的 SQLite 内存数据库按完整文件名执行迁移，仅跳过演示数据 `0002_seed.sql`。当前参考包含 `0033_remove_manual_ledger.sql` 的账本退役与 `0043_remove_task_parent.sql` 的平级任务调整，得到 79 张应用表、1 个视图、7 个触发器。逐列字典包括字段类型、默认值、主键、外键、唯一索引、普通索引和完整 CHECK DDL。空库参考不能证明生产存量数据内容或运行时行为；生产应用情况以实际迁移记录为准。

历史核对记录（早于上述迁移更新）：当时以只读导出的生产 `sqlite_schema` 做离线比对，排除 Cloudflare `_cf_KV`、`d1_migrations` 与 SQLite 内部对象：78 张业务表共 723 列的类型、默认值、NULL/PK 信息与 FK 元数据一致；所有表、1 个视图、5 个触发器的规范化 DDL 一致；51 个显式索引一致，无额外业务对象。生产迁移记录包含 37 个完整文件名（含 seed、两个 0025，不含 0033）。此证据证明核对时结构一致，不涉及读取生产业务行，也不证明存量数据内容或运行时行为正确。

### D1、R2 与运行时分别保存什么

- D1 保存账号、项目成员、来源及材料版本元数据、正文片段、任务依赖、提交/评估、作业状态、预算预占、AI 审计和通知发件箱。大部分主键是 `TEXT` UUID，时间戳是 ISO-8601 UTC `TEXT`，布尔值是带 CHECK 的 0/1 INTEGER，结构化载荷主要是 JSON TEXT。
- R2 通过 `env.FILES` 保存上传原文件、解析文本、图片、AI 输入输出证据、调查检查点及长文摘要块缓存。D1 的 `r2_key`、`text_r2_key`、`input_r2_key`、`output_r2_key`、`checkpoint_key` 是对象指针，不能把 D1 元数据存在等同于对象必然存在。
- `document-chunks.ts` 的 chunks 是将完整原文按模型输入容量划分的运行时数组，**没有 `document_chunks` 表**。原文落在 `source_fragments`；摘要块缓存使用 R2 中 `ai-document-chunks/...` 键。文件附件也没有独立 `attachments` 表，材料版本的 `attachments_json` 保存附件描述。
- `creation-template.ts` 当前模板目录是代码里的 `projectTemplates`（`blank`），没有 `project_templates` 表。项目导出通过读取当前项目与历史快照组装结果，没有持久化 `exports` 表；修改导出能力时应查对应导出路由和服务，避免假设数据库已有导出任务表。

### 主要关系图（文字版）

```text
users ── auth_accounts / sessions / personal_profiles
  └── project_members ── projects ── project_goals
                         ├── files ── file_contributors
                         ├── sources ── source_versions ── source_fragments / source_pages / source_processing
                         ├── materials ── material_versions（doc_json、markdown、attachments_json）
                         ├── requirement_sets ── requirements
                         ├── rubric_versions ── standards_versions ── assessments ── assessment_corrections
                         ├── tasks ── task_dependencies / task_submissions / task_summaries
                         │           └── task_inquiries ── task_inquiry_messages
                         ├── collaboration_proposals ── collaboration_proposal_revisions
                         ├── rehearsals ── rehearsal_turns
                         ├── agent_sessions ── agent_turns / agent_runs
                         └── jobs ── job_outbox / ai_execution_slices
                                    ├── usage_reservations ── ai_calls
                                    └── ai_investigations / ai_tool_calls
notification_events ── notification_inbox ── users
        └── notification_push_outbox ── push_subscriptions ── users
```

此图表示业务关系，不表示每条线都存在数据库外键。`current_version_id`、`current_submission_id`、多个 `job_id` 与 JSON 内版本 ID 是逻辑指针；`task_links.target_id`、评估 `entity_id` 是多态引用，必须由服务检查类型、项目归属和生命周期。只有全量字典中的 FK 才是 SQLite 已声明约束。尤其多数 `project_id` FK 只证明项目存在，不能独立阻止“将 A 项目的材料挂到 B 项目”；跨实体业务边界由 `project-reference-guard.ts`、`source-lifecycle.ts` 与相关服务完成。

## 4. 核心数据字典与读写入口

### 身份、成员与隐私

| 表 | 关键字段与约束 | 代码入口与含义 |
| --- | --- | --- |
| `users` | `id TEXT PK`；`email TEXT NOT NULL UNIQUE`；`display_name TEXT`；`created_at`、`last_login_at TEXT` | 保留历史身份 ID；迁移登录方式不能重新建用户或重绑项目 FK。 |
| `auth_accounts` | `user_id TEXT PK/FK users`；`username`、`username_norm UNIQUE`、`contact_email`、`contact_email_norm UNIQUE`；`password_hash TEXT`；`email_verified`、`is_admin INTEGER CHECK 0/1`；`account_role TEXT CHECK super_admin/admin/user` 可为 NULL | `accounts.ts`、`password.ts`、`auth-policy.ts`。用户名/联系邮箱的规范化字段与展示字段分开；旧用户可能没有密码，角色兼容逻辑不能仅看旧 is_admin。 |
| `sessions` | `id TEXT PK`；`user_id FK users ON DELETE CASCADE`；`token_hash TEXT UNIQUE NOT NULL`；`expires_at`、`revoked_at`、`last_seen_at`、`created_at TEXT`；`auth_method CHECK legacy/password` | 保存令牌哈希而非明文令牌；读用户信息前需检查会话到期、撤销与登录方式。 |
| `project_members` | `id TEXT PK`；`project_id`、`user_id FK`；唯一 `(project_id,user_id)`；`role CHECK owner/member`；`permissions_json TEXT NOT NULL CHECK json_valid`；`permissions_revision INTEGER`；保留旧 `major`、`skills_json`、`hours_per_week` | `project-permissions.ts`。权限载荷键为 `teamManage`、`taskManage`、`resourceManage`、`scoreInitiate`、`scoreCorrect`（0042 起存在，普通成员默认 `false`）；有效权限应调用服务计算。`role` 是项目身份，`permissions_json` 是项目操作能力，两者不能互相推导。 |
| `personal_profiles` | `user_id PK/FK`；`searchable`；`bio`、`major`、`specialties`、`preferred_roles` 及各自 `_public`；`ai_use_allowed INTEGER CHECK 0/1`；`revision`；`weekly_available_hours REAL CHECK NULL 或 0..168` | `personal-profiles.ts`。搜索公开性、字段公开性、AI 同意分别控制，不能从“是成员”推断允许发送其私人档案给模型。 |
| `personal_profile_import_candidates` | `id PK`、`user_id FK`；`source_project_id/name`；旧 `major`、`skills_json`、`hours_per_week`；`created_at`、`imported_at` | 0026 在清空项目域旧档案前保留用户可导入候选，来源项目 ID 刻意是文本快照而非 FK。 |

新账号的 `users.email` 是为兼容旧结构保留的内部不透明身份键，不能当作用户联系邮箱；实际联系邮箱与登录归一化地址在 `auth_accounts.contact_email/contact_email_norm`，对外 User.email 也来自这里。因此注册邮箱可选与 users.email 的 NOT NULL 并不冲突。查询或修改账号资料应沿用 accounts.ts 的映射，不要把内部身份键显示给用户或当作已验证邮箱。

`account_invitations` 是账号注册邀请，`invitations` 是项目邀请码，`project_username_invitations` 是指定用户名的项目邀请。三者用途、使用次数/状态和撤销机制不同，不可互换。用户名邀请的唯一部分索引限制同项目同收件人只有一条 `pending`。

### 项目、资源、版本与标准

| 表 | 关键字段与约束 | 主要载荷与行为 |
| --- | --- | --- |
| `projects` | `id PK`；`name`、`description`；`status CHECK active/archived`；`revision`；`created_by FK`；`competition_deadline_date`、`deadline_precision`；`ai_budget_usd REAL`；`ai_collaboration_enabled`；`planning_mode`、`assignment_mode`、`evaluation_mode`、`progression_mode CHECK manual/automatic`；`collaboration_revision`、`collaboration_mutation_token` | 普通字段 revision 与协作设置 revision 分开；`team_size_limit` 仍是兼容字段，0030 将存量值改为 NULL，但没有删列。 |
| `project_goals` | `project_id PK/FK`；`title`、`detail`；`revision`、`graph_revision INTEGER`；`graph_token TEXT`；时间戳 | `project-simplification.ts`：目标文字与依赖图使用不同版本，修改任务图不应伪造目标文字变更。 |
| `files` | `id PK`；`project_id FK`、`uploader_user_id FK`；`r2_key`、`original_name`、`ext`；`mime_declared/detected`；`size_bytes`、`sha256`、`page_count`；`status CHECK pending/available/quarantined/discarded`；`gc_after`；`deleted_at/by`、`lifecycle_version`、`lifecycle_change_id` | `files.ts`、`file-lifecycle.ts`、`gc.ts`；索引 `(project_id,sha256)` 用于内容定位但不唯一。上传者身份与贡献者不是同一个概念。 |
| `file_contributors` | 复合 PK `(file_id,user_id)`；`file_id FK ON DELETE CASCADE`；`user_id TEXT`、`display_name TEXT` | 贡献署名保存用户和姓名快照，user_id 刻意无 FK，离开项目不会抹去历史署名。 |
| `sources` | `id PK`；`project_id FK`；`kind CHECK file/web/paste`；`title`、`url`；`current_version_id TEXT`；`purpose CHECK background/reference/output`；`resource_revision`；回收站与生命周期字段同 files，另有 `deleted_via_file_id FK files` | 来源实体与来源正文版本分开；用途改变不重建正文版本。 |
| `source_versions` | `id PK`；`source_id`、`project_id FK`；`revision`；唯一 `(source_id,revision)`；`origin CHECK file/web/paste`；`file_id FK`、`url`；`text_r2_key`、字符/页数；`status CHECK pending/processing/ready/failed`；`parse_error`；`ai_config_version_id FK` | 原始内容版本不覆盖；处理状态与冻结 AI 配置是版本上的执行元数据。 |
| `source_fragments` | `id PK`；`source_version_id`、`project_id FK`；`page_number`、`seq`；`kind CHECK text/ocr/web/paste`；`content TEXT`；唯一 `(source_version_id,seq)`；索引 `(source_version_id,page_number)` | 原文引用锚点。长片段切块后仍保留原 fragment ID，不能重写 ID 造成旧引用失效。 |
| `source_pages` | `id PK`；`source_version_id/project_id FK`；唯一 `(source_version_id,page_number)`；`text_status`、`image_status`、`ocr_status`；`image_file_id FK`、OCR方法/置信度、`needs_review` | 页级文本、页面图片、OCR 三种状态分别保存，解析失败不等于原文件被删除。 |
| `source_processing` | `source_version_id PK/FK`；`project_id FK`；`text_status`、`requirements_status`、`summary_status` 独立；要求/摘要错误；`summary_json`、`summary_job_id`、`summary_revision`、`covered_chars`、`total_chars` | `source-summary.ts`。全文读取完成、要求提取完成与摘要完成可以不同步；前端不应以一个总状态替代三个阶段。 |
| `materials` | `id PK`；`project_id FK`；`title`、`kind`；`current_version_id`；`revision`；`purpose`；`is_default_background`；部分 UNIQUE `(project_id) WHERE is_default_background=1` | 每项目最多一份默认背景；资料列表与可编辑稿件统一呈现，不等于来源表被废弃。 |
| `material_versions` | `id PK`；`material_id/project_id FK`；`revision`；唯一 `(material_id,revision)`；`doc_json`、`markdown`、`attachments_json TEXT`；`origin CHECK manual/ai_adoption`；`ai_run_id TEXT`、`author_id FK`、创建时间 | `tiptap.ts` 与材料路由。doc_json 是编辑器文档，markdown 是对应导出/上下文表示，附件是该版本的快照；保存新版本应同时维护三者。 |
| `requirement_sets` / `requirements` | 要求集含 `status draft/confirmed`、`revision`、`source_version_id FK`、确认者/时间；要求含 `requirement_set_id FK`、`seq`、分类、标题/细节、截止日期/精度、`citations_json`、`field_state ai_suggestion/edited/confirmed`；唯一 `(requirement_set_id,seq)` | 要求引用载荷含 `sourceVersionId`、`fragmentId`、`pageNumber`、`quote`；归属与原文校验需服务执行，数据库不验证引文真实性。 |
| `rubric_versions` | `id PK`；`project_id FK`；`version`；唯一 `(project_id,version)`；`source official/custom`；`weights_json`、`notes`；`status` 与确认字段 | 权重项通常含 `key`、`label`、`weight`，检查维度唯一、权重范围与总权重由服务执行。 |
| `standards_versions` | `id PK`；`project_id FK`；唯一 `(project_id,version)`；`requirement_set_ids_json`；`rubric_version_id FK`；`mappings_json`、`snapshot_json`；`status draft/confirmed`；`revision` 与确认字段 | 映射项 `{requirementId,dimensionKey}`；发布时将要求、维度和映射冻结在 snapshot_json。正式评估读取 confirmed 快照，不能用当前编辑草稿解释历史得分。 |

### 任务、提交、评估与人工修订

| 表 | 关键字段与约束 | 实现要点 |
| --- | --- | --- |
| `tasks` | `id PK`；`project_id FK`；`title/detail`；`assignee_id FK users`；`status CHECK todo/doing/blocked/done`；`revision`；`requirement_id FK`；`lifecycle_state CHECK open/in_progress/submitted/accepted/improve/rework` 可 NULL；`criteria`、`effort_hours REAL CHECK >0 且 <=200`；`current_submission_id`、`plan_proposal_id`；`source_citations_json` | 双状态用于兼容旧任务与协作流程。`collaboration.ts` 的映射对 NULL lifecycle 有回退；任意新写入必须保持状态一致，不能仅改一列。 |
| `task_dependencies` | 复合 PK `(task_id,depends_on_task_id)`；CHECK 非自身；两个 `(project_id,task_id)`/`(project_id,depends_on_task_id)` 复合 FK 引用 `tasks(project_id,id)` 并 CASCADE | 数据库阻止跨项目边及自环；环路仍由 `validateTaskGraph` 检查拓扑排序，不能只依赖 FK。 |
| `task_submissions` | `id PK`；`project_id/task_id FK`；唯一 `(task_id,round)`；`submitted_by FK`、`body`、`material_versions_json`；`criteria`、`task_revision`；`status pending/evaluated/accept/improve/rework`；`ai_decision/ai_feedback/ai_report_json`；`decision/feedback/decided_by`；`human_score_override_json`；`evaluation_job_id/attempts`；`revision/mutation_token` | 提交保存标准、任务版本与材料版本 ID 快照。AI 原始意见与最终决策、人工辅助得分覆盖分别保存，不能为了改分覆盖 AI 原证据。 |
| `collaboration_proposals` | `id PK`；`project_id FK`；`kind CHECK decompose/assign`；`job_id UNIQUE FK jobs`；`payload_json`；`settings_revision`；`status pending/applied/stale`；`revision/mutation_token` | 任务规划载荷可含 goal、tasks、updates、dependencies、references；分工含 assignments；实际结构以 collaboration-ai.ts 的 Zod schema 为准。应用建议前需核对每任务 expectedRevision。 |
| `collaboration_proposal_revisions` | `id PK`；`proposal_id/project_id FK`；唯一 `(proposal_id,revision)`；原 payload/status、actor、reason、created_at | 人工修改先保留上一版本；修改已应用规划不能重复创建原新增任务。 |
| `assessments` | `id PK`；`project_id FK`；`kind material_review/rehearsal`；`entity_id TEXT UNIQUE`；`goal_revision`、`standards_version_id FK`；`inputs_json`；`status pending/active/succeeded/failed`；`report_json`、`ai_report_json`；`job_id`、创建者/时间；`revision`、`origin` | `assessments.ts` 统一材料评估和答辩；输入冻结目标版本、标准版本与材料证据，entity_id 指向具体评估实体，未声明 FK。 |
| `assessment_corrections` | `id PK`；`assessment_id/project_id/actor_id FK`；唯一 `(assessment_id,revision)`；`reason`、`previous_report_json`、`report_json`、时间 | `assessment-corrections.ts` 保存修订链。界面可展示当前 report，审计必须同时保留原 AI report 和修订历史。 |
| `reviews` | `id PK`；`project_id/requirement_set_id/rubric_version_id FK`；`material_version_ids_json`；`status pending/running/succeeded/failed`；`report_json/job_id` | 原有预审底层实体仍存在；不要因统一 assessments 而直接删除。 |
| `rehearsals` / `rehearsal_turns` | 答辩含 `scope all/member`、`member_id FK`、材料版本 JSON、`status active/finished`、`processing_job_id`、`finish_job_id/finish_snapshot_json`；回合含唯一 `(rehearsal_id,sequence)`、`kind question/answer/followup/summary`、`content_json`、`run_id`、`author_id FK` | `rehearsal.ts`：共享答辩一次处理作业持有 processing_job_id，回答作者独立记录，避免两个成员并发覆盖同一轮。 |
| `task_readiness` / `task_completion_people` | readiness：`task_id PK/FK`、`assignee_id FK`、`ready CHECK 0/1`、`generation`；completion：`task_id PK/FK`、`user_id FK`、`completed_at` | 0037 的视图和触发器维护基线、完成者与通知。ready 要求任务未完成、已分配给当前成员、有依赖且所有上游 done；没有依赖不会触发“前置全部完成”通知。 |
| `task_inquiries` / `task_inquiry_messages` | inquiry：project/task/upstream/requester/recipient FK，`recipient_source CHECK submission/completion/substitute`，任务名称快照；message：inquiry/author FK，`body CHECK length 1..4000` | 新工单将 `task_id` 与 `upstream_task_id` 都保存为对应任务 ID，接收人由发起人选择；API 根据相同 ID 返回 `direct`。旧记录保留原双任务和 `recipient_source` 快照。参与者访问校验在路由，项目成员不能读取他人的私密工单。 |
| `task_summaries` | 复合 PK `(project_id,task_id,source_hash)`；`status queued/running/ready/failed`；`summary`、`job_id`、时间 | `task-summary.ts`：内容哈希隔离不同原文的摘要，避免旧作业覆盖新正文摘要。 |

### 创建草稿、模板和导出边界

`project_creation_drafts` 以 `id TEXT PK` 保存私人创建工作区；`owner_id FK users` 约束所属人，`status active/cancelled/committed` 标识提交状态，`revision` 用于 CAS，`payload_json` 保存用户输入，`preview_json` 保存预览，`preview_revision` 标识预览对应输入版本。`preview_state none/running/ready/failed`、`preview_attempt_id`、`preview_error` 使过期预览不能覆盖新预览。预分配的 `project_id TEXT UNIQUE NOT NULL` **没有项目 FK**，这是刻意设计：保存草稿、上传与预览不能创建正式项目。`commit_token` 作为创建提交门禁，`result_encrypted` 保存加密的提交结果；提交一次才将工作区转换为项目、成员、材料和标准。

`creation_draft_files` 以 `id PK`、`draft_id FK` 归属草稿，包含 `name/ext`、`r2_key UNIQUE`、`sha256`、`size_bytes/mime`、`pages_json`、`text_error`、`removed INTEGER` 与创建时间。草稿文件不在正式项目 files 表，提交时需要有意识地转移归属而不是只改 project_id。`ai_calls.draft_id FK` 允许没有正式 project_id 的预览调用仍可追溯。实现入口为 `creation-drafts.ts`、`draft-preview-jobs.ts`、`creation-template.ts`。

模板定义来自代码而不是数据库，当前支持 `blank`；workspace 材料项包含 key/title/markdown/purpose，标准项包含 requirements/weights/notes。导出要按对象关系与冻结版本读取，JSON内引用不是FK，不应写出已回收的资源为当前可用对象，也不应误导使用者为导出包包含所有 R2 原件。

### 作业、AI 证据、预算与通知

| 表 | 关键字段与约束 | 行为 |
| --- | --- | --- |
| `jobs` | `id PK`；可 NULL 的 `project_id FK`；kind 为 parse_source/ocr_pages/requirement_extract/assignment_suggest/agent_run/review_run/rehearsal_turn/web_fetch/gc；status 为 queued/running/waiting_input/succeeded/failed/cancelled；`input_json/input_r2_key/result_json/error_json`；`attempts/lease_until`；创建者与时间 | `input_json.operation` 在既有 kind 内区分摘要、协作等细分操作，新增操作不一定需要新增 kind。创建时冻结 configVersionId 与来源生命周期版本。创建草稿预览直接以 draftPreview payload 进入 AGENT_WORKFLOW，不落普通 jobs。 |
| `job_outbox` | `id PK`；`job_id UNIQUE FK`；`status pending/dispatched/done/failed`；`available_at/lease_until`；attempts/last_error/时间 | 作业和 outbox 同批写入；派发失败靠恢复器补投，先落库后派发不能只写 jobs。 |
| `ai_execution_slices` | 复合 PK `(job_id,slice)`；job FK；CHECK `0 <= slice < 512`；`instance_id UNIQUE`；`status pending/dispatched/running/continued/complete`；attempts/last_error/时间 | `ai-execution-slices.ts`：slice0 的实例名为 jobId，后续为 jobId-sN；一个作业允许跨独立 Workflow 实例接力，仍共用 job、预算和审计。 |
| `ai_investigations` | `id PK`；project/job/requested_by FK；`prompt_version/checkpoint_key`；`phase`、`step`、updated_at；索引 `(job_id,prompt_version)` | D1 保存检查点位置与进度；完整 exchanges、证据等在 R2，私人上下文检查点采用分块加密 envelope；不要将检查点当作普通公开资料。 |
| `ai_config_versions` | `id PK`；`version INTEGER UNIQUE`；`config_json TEXT`；`enabled`、notes、created_by/at | 每调用关联配置版本；冻结模型名称、供应商、输入输出限额与价格等配置，服务读取时校验。不能以最新配置推断过去调用。 |
| `usage_reservations` | `id PK`；project FK；`job_id`、`purpose`；`estimated_cost REAL`；`status reserved/settled/released/pending_reconcile`；`settled_cost`、时间；`attempts_started`、`max_calls` | `budget.ts` 原子预占并发槽位/金额；fetch 前持久化 started 尝试。预估为0不等于真实免费；未知实际费用不能写“已结算0美元”。 |
| `ai_calls` | `id PK`；project/config/reservation/draft FK；`job_id/run_id`；`purpose textEconomy/visionEconomy/review`；`prompt_version/model`；`input_r2_key/output_r2_key`；prompt/completion tokens、cost；`cost_status known/unknown`；`status ok/repaired/invalid/failed/timeout`；latency/time；`search_usage_json` | 模型调用审计，与业务成功分开：收到模型输出但校验失败可记录 invalid。排查路径从 jobId 到 reservation、call、R2证据和业务实体，不要只看作业状态。 |
| `ai_tool_calls` | `id PK`；project/job/requested_by FK；`name/args_json/result_json`；`status ok/failed`；时间 | 工具调用证据，可和模型调用按 jobId 串起来；工具失败并不自动代表整个调查失败。 |
| `ai_diagnostics` | `id INTEGER PK AUTOINCREMENT`；`entry_json TEXT`；`byte_size CHECK=length(CAST(entry_json AS BLOB))+1` | 有界运维诊断，设计上不存 prompt、response 或密钥。不能向此表写模型完整输入来“方便排查”。 |
| `idempotency_records` | 唯一 `(idempotency_key,user_id,operation)`；request_hash；`status processing/completed`；response_status/body；created_at | 相同操作同用户同键同内容可返回历史响应；不同内容返回冲突，processing 不应被当成 completed。 |
| `notification_events` | `id PK`；`event_key UNIQUE`；kind/scope project或ticket；resource_id、actor FK；title/body/url/time | 去重事件源。任务可开始事件键含任务与 generation，避免重复通知也支持下一轮有效转换。 |
| `notification_inbox` | 复合 PK `(event_id,user_id)`；两者 FK；read_at/dismissed_at | 站内每人状态独立。 |
| `push_subscriptions` | `id PK`；user FK；session_hash；`endpoint UNIQUE`；p256dh/auth；时间与 disabled 字段 | Web Push 端点和密钥是用户敏感信息，不应进入公开文档或诊断输出。 |
| `notification_push_outbox` | 复合 PK `(event_id,subscription_id)`；两者 FK；status pending/sending/sent/cancelled/failed；attempts、available_at、lease_until、时间 | 发通知的网络请求发生在事务之后，以 outbox 保留派发进度；成功站内事件不保证设备已经收到 Push。 |

## 5. 状态机、并发写入与一致性约定

### 原子业务写入不等于端到端事务

项目使用 D1 `batch` 将相关 SQL 作为事务执行。例如 `createJobAndDispatch` 同批写 jobs 与 job_outbox；依赖图修改先 CAS 更新 `project_goals.graph_revision/graph_token`，后续删除/插入边带相同 token 门禁；应用协作建议先 CAS 更新 proposal 的状态和 mutation_token，后续任务/目标/事件写入必须带该 token。

需要保留 SQL 的 `WHERE revision=?`、当前成员权限、来源生命周期、AI 配置版本、项目开关、目标/图版本与当前作业状态条件。`meta.changes=0` 是前置条件失败，必须返回版本冲突或状态错误，不能当作操作成功。路由先检查权限只减少无效请求，SQL 中再次检查才能防止请求读完权限后项目负责人立刻撤权的竞争。

R2 写入、D1 批处理、Workflow 创建和 Web Push HTTP 请求不构成一个跨服务事务。正确性来自冻结快照、幂等键、确定性实例 ID、状态门禁和恢复机制；新功能需要说明“数据库已提交但网络派发失败”“对象已上传但数据库没写入”如何处理，不应假定一个 try/catch 能回滚所有外部资源。

### 不可覆盖的证据与可更新的执行状态

- 新材料内容写新的 `material_versions` 并移动材料 current_version_id；来源新内容写新的 source_versions。版本内容和作者、AI采纳来源用于追溯，处理元数据可随执行更新。
- 发布 standards 时冻结 snapshot_json；提交保存 task_revision、criteria、material_versions_json；AI结果只有在版本与成员/来源仍有效时才能应用。
- `task_submissions.ai_report_json`、`assessments.ai_report_json` 是 AI 原始证据；人工最终决定/得分保存在单独字段或修订表。修订不能倒写原模型意见。
- 回收站使用 deleted_at、lifecycle_version、lifecycle_change_id 做墓碑。老作业持有旧生命周期版本时不得写回，恢复文件也不能使旧作业获得新生命周期权限。

### 关键状态转换

```text
jobs: queued → running → succeeded / failed / cancelled
                  └── waiting_input（可继续输入；终态不得原地重放）
outbox: pending → dispatched → done / failed
AI slice: pending → dispatched → running → complete
                                  └── continued ＋ 下一 slice.pending
submission: pending → evaluated → accept / improve / rework
task lifecycle: open → in_progress → submitted → accepted / improve / rework
proposal: pending → applied；失效 → stale；人工修订创建历史并更新 revision
reservation: reserved → settled / released / pending_reconcile
```

箭头是主要流向；恢复器可能将尚未开始付费调用且引擎确证缺失的派发恢复成 queued/pending。`jobs.attempts` 是派发次数，`usage_reservations.attempts_started` 是持久化模型请求尝试次数，`ai_calls` 是已保存审计记录数，三者不能互相代替。引擎查询暂时失败不构成安全重放证据；付费调用已开始但实例/调用记录缺失时，要保留费用不确定性，不能自动再请求模型。

长调查只有保存安全检查点后才能继续下一 slice；`continueExecutionSlice` 原子创建下一行、将当前标为 continued、刷新 job，随后派发新的独立实例。claimExecutionSlice 仅抢占 pending/dispatched 且必须是最新 slice，避免引擎重放重复执行同一付费段。

### 图依赖与通知触发器

0037 的 `task_readiness_current` 视图和5个触发器是 schema 的执行逻辑，不只是查询优化：任务创建建立 baseline，任务状态/执行人变更更新 readiness，完成时记录实际提交者或旧执行人，0→1 readiness 写去重通知与 Push outbox，成员离开清 readiness。涉及 tasks、提交状态或成员退出的变更，必须同时检视触发器及 `task-readiness.ts`。

`generation` 使同任务下一次 readiness 转换有独立事件键。切换执行人建立新基线而不通知“领取后立即可开始”。旧任务迁移仅建立基线，不重放历史通知。改变依赖关系时还需服务刷新 readiness；数据库触发器不是对所有表变化自动覆盖的万能订阅器。

## 6. 后端入口、鉴权与写入约束

### 一次请求如何进入应用

前端 `src/worker.ts.fetch()` 将 `/api` 和 `/api/*` 经 `API` Service Binding 转发，其余请求由 `ASSETS.fetch()` 返回。后端 `index.ts` 将 fetch 交给 `createApp()`，scheduled 通过 `ctx.waitUntil(handleScheduled(env))` 运行 cron，并导出两个 Workflow 类。

`app.ts.createApp()` 依次注册 requestId 中间件、部分私密路由的 no-store 响应头、写请求 Origin 检查；业务路由再挂 `requireUser` 与 `requireProjectMember` 等。Zod 验证失败经 defaultHook 转成统一错误；AppError 和未预期异常都进入统一 failureBody，后者只公开固定内部错误消息。新路由应直接注册到根 OpenAPIHono 并使用完整 `/api/v1` 前缀，才能进入导出的契约，不宜额外建立不被导出收集的旁路子应用。

`core/http.ts.requestIdMiddleware` 只接受 UUID 格式的外部 request ID，否则生成新 UUID，写回响应头。`core/origin.ts` 放行 GET/HEAD/OPTIONS；其他方法带 Origin 时必须匹配白名单，local 允许 localhost/127.0.0.1；没有 Origin 的服务调用不在此拦截。Origin 检查不是业务鉴权，也不是允许非成员操作的理由。

### 账户权限和项目权限是两层约束

`api/auth.ts` 的 POST sessions 调用 `loginPasswordAccount`，用户名或联系邮箱加密码建立会话；register 使用一次性注册码。`services/password.ts` 使用 scrypt 并以 timingSafeEqual 核对；`core/auth.ts.loadSessionUser()` 只接受有效、未撤销、未到期且 auth_method=password 的会话，且账户必须存在 password_hash。Cookie 名为 ai_office_session，带 HttpOnly、Secure、SameSite=Lax、Path=/；数据库查找 token 的 SHA-256 哈希，不存明文 token。会话固定期限由 accounts.ts 的 SESSION_TTL_SECONDS 决定，不采用滑动续期。

### 账户角色、项目身份与项目权限是三层，不要混用

`core/account-role.ts` 与 `auth_accounts` 决定账户角色（`super_admin` / `admin` / `user`）；`project_members.role` 决定项目身份（`owner` / `member`）；`project_members.permissions_json` 决定项目操作能力（`teamManage`、`taskManage`、`resourceManage`、`scoreInitiate`、`scoreCorrect`）。三者不能互相推导：账户 `admin` 也必须先加入项目，才能获得该项目的成员记录与项目权限。

`requireProjectMember()` 先核实项目存在，再查成员，再核对 owner 或指定权限，不信任前端角色。仅项目 owner 获得完整项目权限；其他成员（包括 `admin` / `super_admin` 账号）按显式授权操作，未授权时默认 `teamManage=false`、`taskManage=false`、`resourceManage=false`、`scoreInitiate=true`、`scoreCorrect=false`。

权限管理的入口是 `requireProjectAdministrator()` / `canManageProjectPermissions()`：**仅项目 owner**。系统账号的 `admin` / `super_admin` 身份不参与项目授权。`teamManage` 覆盖邀请、撤销邀请、用户名邀请、审批加入申请和移除其他非负责人成员，不允许修改任何成员的 `permissions_json`。管理员账号作为非负责人成员时同样可被负责人调整权限或由团队管理者移除。`DELETE /members/{userId}` 统一使用 `projectPermissionSql()` 在事务内二次校验，移除 owner 一律拒绝。项目持续反馈仅 owner 可写；转让 owner、核心项目配置、AI 自动协作规则、标准版本也保持 owner-only。

「协作管理员」只是前端权限 preset（`administratorPermissions`），一键填入五项权限，不是数据库 `role`，也不产生新的权限表。前端 `projectPermission()` / `useProjectPermissions()` 与后端 `projectPermissionSql()` 使用同一组键；`canManagePermissions` 仅在该成员为项目负责人时为 true，`permissionsRevision` 与 `expectedRevision` 提供乐观并发控制（冲突返回 409）。

关键写 SQL 再次包含 `projectPermissionSql()`，让权限撤回与正在执行的请求竞争时，最终数据库判断生效。新增管理接口应同时做到入口校验、业务对象属于当前项目、SQL 提交时仍具权限；仅隐藏按钮不能形成权限边界。

### revision、幂等键和生命周期版本各解决什么问题

`expectedRevision` 是“我编辑时看见的业务版本”。以 materials 保存为例，先检查当前材料 revision；D1 batch 中插入新 material_versions 的 SQL 仍检查 expectedRevision、当前成员与作者/资源管理权限，再更新 materials 指针和 revision。任务 PATCH/assignment 同样将 revision 条件放在 UPDATE 内。冲突返回 VERSION_CONFLICT，调用方必须重新读取并保留用户编辑，不得 blind retry。

任务依赖图有独立 `project_goals.graph_revision`，替换依赖要求 expectedGraphRevision；不能用任务 revision 替代整张图的版本。文件与来源还有 lifecycle_version：软删除、恢复或重新生命周期可能使后台旧输入失效；`source-inputs.ts` 的 snapshot/assert/SQL guard 负责核对来源与文件快照。AI 结果应绑定创建时的输入与配置版本，不得将“旧输入得到的结果”直接发布到变化后的新数据上。

`services/idempotency.ts.withIdempotency()` 的唯一逻辑范围是 key、userId、operation，另外存请求体哈希。同键同内容且 completed 回放原响应；同键不同内容返回 IDEMPOTENCY_CONFLICT；processing 返回 INVALID_STATE。业务已成功但响应保存失败时保留 processing，不能定时删掉后重新执行。人工恢复接口须先核对业务记录，确认未生效或重试无重复副作用后才释放。expectedRevision 防止覆盖并发编辑，幂等键防止重复动作，二者不能相互替代。

## 7. 核心业务写入与后台执行边界

### 资料上传与来源处理

`services/files.ts.createFileInit()` 验证扩展名、贡献人和派生原文件属于项目，服务端生成 R2 key，创建 pending 文件及贡献人快照，并返回经鉴权的上传路径；客户端不能指定对象路径。`storeFileContent()` 按实际字节限制大小，检查 PDF/PNG/JPEG/WebP magic bytes 或 TXT/MD UTF-8，写 R2 后以生命周期条件改为 available，并记录 sha256、字节数和实际 MIME。类型不符的内容进入 quarantined 并安排回收；超大内容不落 R2，保留 pending 允许换小文件重试。下载还会在读取对象后再次检查生命周期。

`api/sources.ts` 建立来源与 source_versions，来源版本关联文件、URL 或 R2 文本。解析主逻辑在 `services/parse.ts.runParseJob()`，依次深入 extractSourceVersionText、ocrPendingPages、extractRequirements；`workflows/parse-source.ts` 承接持久执行。文本、PDF 文本和图像 OCR 是不同阶段，来源 exists 不代表已解析可用；排障需要分别查看 source_versions.status/parse_error、页文本及对应 job。更改文件处理务必验证软删除后旧作业无法重新发布，不能只验证正常上传。

### 材料版本与任务图

`api/materials.ts` 用 Tiptap JSON 保存可编辑结构，通过 `services/tiptap.ts` 生成 markdown，material_versions 保存不可变快照；materials.current_version_id 是当前指针。保存使用 D1 batch 同步版本、指针和事件，附件还保存引用快照，便于历史追溯。新增材料字段先确认属于稳定实体还是版本快照：标题等实体属性与某一版本正文、附件、作者来源不能混为一列。

`services/project-simplification.ts.validateTaskGraph()` 检查边指向同项目其他任务、重复边及环；`replaceTaskDependencies()` 用图版本和 guard 原子替换，再追加 `readinessStatements()`。依赖未 done 时准备状态提示为未就绪；这只是提示，不阻止提前认领、执行、提交或人工验收。task_readiness 记录 ready 转变与 generation，用于准备通知；新增/分派/更改依赖要在现有 batch 内补齐 readiness，避免事务之后异步补写而漏通知或重复通知。任务状态来自用户或受控流程，API 契约明确 AI 不允许直接任意改任务状态。

### 标准评分与答辩演练

`services/assessments.ts.assessmentInputs()` 冻结标准版本、材料版本、项目目标及来源快照；`scoreAssessment()` 生成评分报告；`assessmentPublication()` 在发布 SQL 再检查 assessment 原始 AI 状态、job 状态、成员及来源有效性，更新 report_json/ai_report_json 并增加 revision。人工修订与 AI 发布分开，不能将人工修订后的报告当作未发布 AI 作业继续覆盖。`runMaterialAssessmentJob()` 成功发布后结算预算及 succeedJob，失败标记 assessment 并释放预留；续执行异常必须交还持久执行，不可误判成普通失败。

`services/rehearsal.ts.runRehearsalTurnJob()` 要核对 processing_job_id，材料按版本读取；member 范围核对目标仍是项目成员并读取其任务，不能把请求者误当演练对象。summary 阶段使用 finish_snapshot_json 的回答快照，核对 finish_job_id，批量发布 assessment、summary turn 与 finished 状态。共享演练的操作者和目标成员属于不同概念，修改前阅读 `api/rehearsals.ts` 的所有权检查及 114-rehearsal-ownership 测试。

## 8. AI 调用链路：从用户操作到结果发布

### 阅读范围与版本边界

本章依据当前工作区源码核对。`agent.ts`、`assessments.ts`、`assignment.ts`、`guide-history.ts`、`project-ai-tools.ts`、`project-context.ts` 六个服务文件存在未提交修改，尤其涉及工具参数契约、评分提示、带做历史和调查继续执行的异常透传。以下函数名、表名和链路描述对应本地源码；这些未提交实现是否已发布，需要结合部署构建和线上版本另行核对。不能凭帮助页面更新就推断后台代码已经发布，也不能把本章的静态检查当作真实供应商付费调用验证。

核心调查函数的真实名称是 `projectToolConversation`，在 `backend/src/services/project-ai-tools.ts`；不要寻找不存在的 `runProjectInvestigation`。建议按 `api → budget/jobs → workflows → ai-jobs → 业务执行器 → agent/project-ai-tools → gateway → transport/tool-transport → calls → 发布 SQL` 的顺序阅读。

### 用户入口与执行器对照

路径中的 `{projectId}` 等参数由服务端路由解析。普通业务接口统一在 `/api/v1` 下；幂等记录的 `operation` 与 `jobs.input_json.operation` 用途不同，前者避免重复创建，后者参与后台业务路由，不能混为一个枚举。

| 用户操作 | HTTP 入口与主要源码 | 作业与执行器 |
| --- | --- | --- |
| 创建助手、代做/带做/只审 | `POST /api/v1/projects/{projectId}/agent-sessions`；后续 `POST .../agent-sessions/{sessionId}/turns`；`api/agents.ts` | `agent_run → runAgentJob`，由 `capability` 决定 `do/guide/review_only` |
| 采纳助手草稿 | `POST .../agent-runs/{runId}/adopt` | 独立采纳事务，不等同模型已生成 |
| 任务拆解/调整 | `POST .../collaboration/decompose`；`api/collaboration.ts` | `agent_run` + `collaboration.decompose → runCollaborationAiJob` |
| 分工建议 | `POST .../collaboration/assign` | `agent_run` + `collaboration.assign`；通用分工入口另使用 `assignment_suggest → runAssignmentSuggestionJob` |
| 提交后自动评价 | `POST .../tasks/{taskId}/submissions`（协作路径为同一处理器） | AI 启用时自动创建一次 `agent_run` + `collaboration.evaluate`，由 `enqueueEvaluation` 冻结轮次和标准；AI 禁用时不创建作业，不注册独立手动评价接口 |
| 任务简介 | `POST .../collaboration/tasks/{taskId}/summary`，也注册 `/projects/{projectId}/tasks/...` 别名 | `agent_run` + `collaboration.summary → runTaskSummaryJob` |
| 固定材料预审 | `POST .../reviews`；`api/reviews.ts` | `review_run → runReviewJob` |
| 主目标材料检查/演练评分 | `POST .../assessments`；`api/project-simplification.ts` | 材料检查 `review_run` + `assessmentId`；演练 `rehearsal_turn` |
| 答辩演练、回答、结束 | `POST .../rehearsals`、`.../{rehearsalId}/answers`、`.../{rehearsalId}/finish` | `rehearsal_turn → runRehearsalTurnJob`，`phase=question/followup/summary` |
| 解析来源、扫描页 OCR | `POST .../sources/{sourceId}/parse`、`.../page-images`；`api/sources.ts` | `parse_source/ocr_pages → runParseJob` |
| 单独文件总结 | `POST .../sources/{sourceId}/versions/{sourceVersionId}/processing/summary` | `requirement_extract` + `source.summary → runSourceSummary`，并非独立 JobKind |
| 创建项目的 AI 预览 | `api/creation-drafts.ts → enqueueDraftPreview` | 直接创建 `AGENT_WORKFLOW`，携带 `draftPreview`；不进入普通 `jobs` 路由 |

`services/jobs.ts` 中 `JobKind` 的完整类型是 `parse_source`、`ocr_pages`、`requirement_extract`、`assignment_suggest`、`agent_run`、`review_run`、`rehearsal_turn`、`web_fetch`、`gc`。其中 `gc` 虽被类型声明允许，不代表 `runAiJob` 有对应实现；实际垃圾回收由 cron 调用 `gc.ts`。解析路由集合是 `parse_source/ocr_pages/requirement_extract/web_fetch`；其他普通作业派发到 AI Workflow，而 `runAiJob` 只接受四种 AI 作业，新增类型必须同时补路由和执行器。

### 一次普通 AI 作业的顺序

以下以已存在项目的助手、协作或评分作业为例；来源处理按阶段预占，创建草稿预览另走直接 Workflow 路径。

```text
用户点击 → API 校验身份、项目权限、参数、expectedRevision、幂等键
  → withReservedAiJob / reserveAiSlot：冻结 configVersionId，预占预算与并发
  → 写 agent_run / assessment / submission 等业务记录与输入快照
  → createJobAndDispatch：jobs(queued) + job_outbox(pending) 同 batch
  → tryDispatchJob：原子领取 jobs，queued → running，attempts + 1
  → ensureInitialExecutionSlice → dispatchExecutionSlice → AGENT_WORKFLOW.create
  → AgentRunWorkflow.step.do(retries.limit=0)
  → executeAiSlice → claimExecutionSlice → runAiJob → 业务执行器
  → aiJsonCall → projectToolConversation（需要项目工具时）
  → gatewayChat → beforeFetch guard/预算尝试标记 → prepareMessages
  → buildProviderRequest / applyToolMode → onDispatch → fetch
  → 规范化协议结果 → recordAiCall → 保存调查检查点 / 执行只读工具
  → 最终 JSON 与业务证据校验 → 条件 SQL 发布 → settleReservation
  → succeedJob → job_outbox(done) → GET /api/v1/jobs/{jobId} 展示结果
```

`createJobAndDispatch` 会将 `configVersionId` 写入 `jobs.input_json`；有来源时还冻结 `sourceLifecycleVersion`。除独立 `source.summary` 外，同一来源的解析/OCR/要求提取共享 `source_versions.ai_config_version_id`。配置版本冻结是可追溯依据，但很多业务同时要求其仍为最新启用版本；后台配置改变时旧作业可能被拒绝，需要重新发起，而不是无声切换到新模型。

任务状态只有 `queued/running/waiting_input/succeeded/failed/cancelled`。`waiting_input` 常表示扫描页需要用户补图片，并不表示所有运行都可以自动继续。`failJob`、`succeedJob` 使用条件更新避免覆盖终态；失败重试接口创建新 job ID，旧失败记录保留。`jobs.attempts` 是领取派发次数，既不是模型调用次数，也不是工具轮数。

### 各业务能力的生成、采纳和自动执行边界

助手 `do` 产出 `{title,markdown}`，转为 Tiptap `doc` 后保存 `agent_runs.output_json` 和 `agent_turns`，用户采纳才形成正式材料版本。`guide` 输出 `{type:question|draft,content}`，本轮会话由服务器绑定 `guideSessionId`；`buildGuideHistory` 提供历史目录，`list_guide_turns/read_guide_turn` 按页读取回答，每页最多 4000 字符，避免把目录摘要当成完整历史。仅原发起人、当前项目成员、仍 active 的 guide 会话可读取其历史。`review_only` 输出问题列表，含严重程度、说明、建议和可选 quote；引文须能在已输入材料或实际已读引用中核对，生成审阅结果不会自动改正文。

拆解与调整在 `collaboration-ai.ts` 生成 `collaboration_proposals`。局部调整只能修改冻结 scope 的标题、说明、验收标准和工时，不能删除任务或修改权限。`assertSnapshot/currentConfig` 检查任务 revision、来源、成员、`settingsRevision`、`goalRevision/graphRevision` 等。`applyProposal` 位于 `collaboration.ts`，采纳时仍检查当前权限和版本；自动采纳同样走该函数。结果会区分 `autoApplied/applyError`，因此“生成成功”不保证“已经应用”。

自动拆解后自动分工由 `enqueueDecompositionAssignment` 创建一个独立预算的 `collaboration.assign` 后续任务，带 `parentProposalId`，使用确定性 ID 避免重复；没有待分配任务则不创建。已创建的任务不会因此重新递归拆解。`continueConfirmedPlan` 支持明确确认方案后继续分工。分工使用 `generateAssignmentSuggestions`；验证每个任务恰好覆盖一次，责任人只能为输入中的项目成员或 null。模型给出的自由理由不作为个人评价发布，服务器生成固定协作提醒。

分工个人偏好采用 `profileStamp`：job 只保存成员 ID、成员记录 ID、个人资料 revision 和 `ai_use_allowed`，不保存个人简介正文。`recommendationDispatch` 在真实 fetch 前最后一次数据库读取中统一检查授权、成员范围、来源和最新配置，再提供当前允许用于 AI 的偏好与负载；调用方不能在这次读取与 fetch 之间加入异步 I/O。`finishRecommendationJob` 的发布 SQL 再检查 `profileSnapshotGuard`，防止授权撤回后仍发布旧推荐。

每轮提交在系统与项目 AI 启用时只自动创建一个评价作业，禁用时不评价；同轮重复或失败作业不能通过手动评价或通用重试接口创建第二份评价。提交评价使用固定 `task_submissions` 轮次、完整 `material_versions.markdown` 和可选生效标准的 `rubricSnapshot`。`evaluate` 要求 `current_submission_id/evaluation_job_id/task_revision/assignee_id/submitted_by` 一致，阶段性提纲按本任务 criteria 评价，不能要求尚未到达阶段的最终成果。此操作 `maxAttempts:1`，不自动修复评价结论。`assessEvidence` 检查逐字证据、附件/链接未读、coverage、limitations、低于 0.6 的评分置信度。任务为平级任务，主目标单独保存，依赖通过 `task_dependencies` 表达。原文证据不足时即使模型给 accept，自动验收仍被阻止；只有未读附件或引用造成证据限制、正文证据有效且其他校验通过时，可以先行接受，并在报告 `humanReview.status` 中保存 `pending`，对外返回 `pendingHumanReview`；负责人随后完成人工审核。先行接受仍使用 `accepted/done`，计入完成与依赖就绪；评分总分由 `calculateRubricWeightedTotal` 算，不采信模型总分。结果落 `ai_report_json` 后才可能由 `decideSubmission` 应用。已存在报告可复用，避免再次付费生成。

材料预审与主目标评分是两条路径。旧 `reviews` 冻结 `requirement_set_id/rubric_version_id/material_version_ids_json`；新 `assessments` 冻结 `goal_revision/standards_version_id/inputs_json`，`review_run` 携带 `assessmentId` 时 `runReviewJob` 转 `runMaterialAssessmentJob → scoreAssessment → publishAssessment/assessmentPublication`。每个数字评分都要固定成果引文；没有可靠证据或置信度不足则 score=null，不冒充 0 分。要求检查覆盖全部 requirement ID；没有证据的 met/unmet 改 unknown。材料检查不要求答辩回答，演练数字分必须含实际 answer 证据。空材料、无实际回答可返回 unscorable，无须收费模型请求。

演练依靠 `rehearsals.processing_job_id` 保证当前轮独占；finish 使用 `finish_job_id/finish_snapshot_json` 冻结完整问答。普通首问/追问输出 `{action:question|feedback,content}`，用户回答由 API 保存；有 assessment 的结束阶段调用 `scoreAssessment`，将评分发布、summary turn、finished 状态放在 batch 中，条件检查作业仍拥有结束权。`scope=member` 针对明确 `member_id` 的责任任务，不能把请求账户当目标成员。历史回合表没有 role 列：`kind=answer` 为答辩者，其余是评委侧。

文件解析不把所有阶段当作一次模型调用：`extractSourceVersionText` 尝试正文提取，缺扫描图返回 `waiting_input`；OCR 用 `visionEconomy`，要求提取用 `textEconomy`，文件总结单独记录于 `source_processing.summary_*`。`source.text` 表示只提正文；`source.summary` 可单独重试，不重复上传或 OCR。`runParseJob` 最先检查 source 生命周期；正文、要求、总结各有独立状态，禁止通过单一 `source_versions.status` 推断全部已完成。

任务简介实际表名为 `task_summaries`，operation 为 `collaboration.summary`。`runAiJob` 优先处理此 operation，否则会误落通用协作执行器。输入冻结 `sourceHash`；`runTaskSummaryJob` 每次调用及发布都检查 task、claim、用户、配置及 hash，生成最多 60 字简介，最多一次格式修复，不提供项目工具。

本地 Agent 交接的适用性由 `task-agent-eligibility.ts` 调用当前 `textEconomy` 模型判断，不使用关键词规则。任务保存和内容修改通过数据库触发器记录后台检查需求，由现有定时维护有界派发；已有任务及重新启用 AI 后的失效判断也会补检。判断按完整标题、说明、验收标准、配置版本及提示词版本的哈希缓存，失败不自动重发付费检查；前端仅读取和轮询状态。只有当前内容对应的 `ready/eligible=true` 允许代实施。

`GET/POST .../collaboration/tasks/{taskId}/assistance-plan` 读取和手动生成持久化辅助计划；生成作业复用预算、审计和 Workflow。计划上下文包含项目背景、目标、生效标准、资料及前置任务固定成果，发布前再次核对上下文和成员资格。重新生成时保留上次成功计划，过期只标记、不自动生成。辅助计划不受整项任务执行适用性限制。

DSH 桥接设备在设置中授权项目并选择默认设备，本机工作目录通过 DSH 原生选择器绑定。插件持久化凭据并在启动和网络恢复后自动连接；打开任务的“AI 辅助”弹窗不派发执行。只有显式执行才创建交接，成果回传为待核对草稿。手动复制、下载提示词作为无桥接配置时的交接方式保留。

创建项目草稿预览走例外路径：`enqueueDraftPreview → AGENT_WORKFLOW.create({draftPreview}) → previewDraft → gatewayChat`。它尚无正式 project ID，不使用普通项目 `usage_reservations`、调查工具或执行分片。预览使用 `preview_state/preview_attempt_id/preview_revision`，只生成主目标及 1–20 个任务，不分工、不评分，验证依赖无循环及文件页逐字 citations。模型输出失败不通过 `aiJsonCall` 修复；显式重新生成可能再次计费。提交项目后通过 `draft_id` 将对应 `ai_calls.project_id` 归到新项目。

自动项目推进不是新 operation：`cron.ts → dispatchProjectProgression` 消费 `events.actor_type=user`，15 秒防抖，用 `project_progression` 游标和 `pending_job_id` 限制单个在途推进，再创建 `collaboration.decompose` + `progression:true/causeEventId`。AI 写事件不会递归触发；人工修订仍待审方案优先保留；存在活跃协作或解析任务时跳过。结束游标记录观察事件，避免每分钟无变化重复付费。

## 9. 工具的授权和证据模型

`projectToolConversation` 首先通过服务器读取 `get_project_overview/list_project_resources/list_tasks/read_project_standards` 给出索引，再由模型选择相关正文。工具只读当前授权项目；project ID、user ID、guide session 由服务器绑定，模型不能通过参数指定别的项目。`project-context.ts` 的工具参数由 Zod 同一 schema 生成 JSON Schema 并执行校验，避免提示契约与实际验证不一致。

发现工具包括 `get_project_overview`、`list_project_plans/read_project_plan`、`list_assessments/read_assessment`、`list_project_resources/search_project_information/list_resource_versions/read_resource`、`list_tasks/read_task/read_submission/read_project_standards/read_admin_feedback/read_project_history/read_member_workload`；文件工具为 `list_project_files/read_project_file`。文件列表每页 20 项；文件正文或保存总结每页最多 6000 字符；目录和分页继续采用 `nextOffset`。工具读取文件不自动发起 OCR 或总结收费任务，缺正文返回 unavailable；总结标记 `derived:true`，不能冒充来源原文引文。连续三轮相同工具名和参数、没有进展会停止。

工具返回和文件名统一按不可信数据处理。工具参数非法时将安全字段错误返回给模型，使其修正；权限变更、生命周期失效、预算不足、供应商不可用和 `InvestigationContinuation` 必须透传，不能包装成普通可忽略工具错误。工具审计落 `ai_tool_calls(name,args_json,result_json,status,requested_by,job_id)`，保留分页、片段 ID、错误和引用元数据，避免直接保存文件全文或搜索查询。

`ProjectReference` 包含 `resourceType/resourceId/versionId/revision/fragmentId/pageNumber/quote/usage`，派生总结还有 `offset/summaryRevision`。`referencesFromRead` 不给目录 `directoryOnly:true` 生成正文依据；`decisionReferences/extractDecisionReferences` 仅接受实际读过的 reference ID。模型最终返回 `referenceIds/decisionReferences:[{decisionPath,referenceIds}]`，用于区分读过与用于决策的依据。`validateReadReferences` 核对来源当前生命周期、固定版本、正文引文、派生总结 revision、带做回合所属会话、方案/评分当前生效内容；发布 SQL 的 `projectReferenceGuard` 再堵住检查与提交间的竞态。引用存在不等于语义上充分支持判断，仍需业务证据校验。

## 10. 调查检查点、分片和付费请求不确定性

调查 ID 通常为 `jobId + '-' + sanitized promptVersion`，对象位置 `ai/investigations/{id}.json`；索引在 `ai_investigations`，包含 `project_id/job_id/requested_by/prompt_version/checkpoint_key/phase/step/updated_at`。检查点保存 `step/exchanges/references/trace/compacted/pendingDispatch/content/pendingOutput/pendingResults/pendingSearchOutput/citations/searchUsed/providerRetry`。`phase` 为 read 或 complete，不是 JobStatus。

`privateContext=true` 时 JSON 按 Unicode 码点每 16000 字符拆块，用现有 `seal/unseal` 和 `AUTH_SECRET` 加密；信封格式 `encrypted-investigation-v1`，每块核对 id、index、total。不要更换 AUTH_SECRET 来解决普通失败，否则会同时影响既有加密数据。`compactExchanges` 做确定性历史压缩，保留资源定位元数据和近期交流，遗漏正文可以重新读取；它不允许凭压缩目录宣称已核对原文。

`projectToolConversation` 内部的 `checkpoint()` 调用 `project-investigation.ts.saveInvestigation()`，先写 R2，再更新 D1 的调查索引。模型请求前先保存 `pendingDispatch:true`，持久化预算调用开始标记，再重查 guard，最后 fetch。响应和账本记录成功后保存 `pendingDispatch:false` 及 `pendingOutput`。`loadInvestigation` 发现 pendingDispatch 时直接拒绝重放：上次已派发但结果不确定，应核对账单后重新发起。收到响应但未执行完工具时保存 pendingResults；恢复使用已持久化 pendingOutput，不重复模型请求。

`ai_execution_slices` 是同一业务 job 下独立 Workflow 实例的恢复 outbox：首片 instance ID=job ID，后续为 `{jobId}-s{n}`；状态 `pending/dispatched/running/continued/complete`，slice 从 0 到 511，最多 512 个，不等于允许 512 次模型调用。`claimExecutionSlice` 条件 UPDATE 确保每片只执行一次，旧片不能覆盖新片。收到模型工具响应后立即安全保存并 yield；工具每片最多执行 4 个，保存结果后再继续。`executeAiSlice` 只识别 `InvestigationContinuation` 并调用 `continueExecutionSlice`，其他异常不能当安全继续处理。外层业务 catch 必须先原样抛出该类，不能 failJob 或释放预算。续片要同时传递 `AI_EXECUTION_SLICE:true`、原 job ID、promptVersion、私有上下文及业务 scope，确保读取同一检查点和预算。

分片用于重置 Worker invocation 子请求额度；单纯增加 `step.do` 不能重置该额度。512 是保护界限，不是 Cloudflare 任意错误恢复器。10034/嵌套子请求深度错误与供应商 HTTP 503 不同，不能靠供应商重试分类假装解决。

## 11. HTTP 协议、结构修复和供应商重试

`gatewayChat` 是共同网络入口；`transport.ts` 的 `buildProviderRequest/normalizeProviderResponse` 与 `tool-transport.ts` 的 `applyToolMode/normalizeToolResponse` 分别处理普通输出和工具协议。`shared/ai-providers.ts` 的 `protocolForConfig/modelCapabilities/providerOptionErrors` 决定兼容协议和参数，不通过任意 header/body 透传配置。

| 协议 | 请求和工具历史 | 返回与限制 |
| --- | --- | --- |
| Chat Completions | Bearer；messages；模型能力决定 max_tokens 等字段；tools.function + role=tool/tool_call_id | choices.message.content、usage.prompt_tokens/completion_tokens；拒绝截断/拒答；length 明示 output_limit |
| Responses | Bearer；input，store=false，max_output_tokens；function_call_output/call_id | output 中 assistant output_text；input_tokens/output_tokens；必须 completed；工具 adapter 另处理 function call |
| Anthropic Messages | x-api-key、anthropic-version；system 单独；max_tokens 必填；tool_use/tool_result | end_turn/stop_sequence；usage 将 cache_creation/cache_read 算入输入；thinking 不当答案 |
| Gemini | x-goog-api-key；contents/model、systemInstruction、inlineData、generationConfig；functionDeclarations/functionResponse | STOP；忽略 thought；候选输出与 thoughtsTokenCount 合计输出用量；grounding 搜索引用另外处理 |

`workers-ai` 使用 `https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1/chat/completions` + Bearer + `cf-aig-gateway-id`。自定义供应商由 apiUrl/apiKeyEncrypted 指定，解密密钥仅用于当前请求；生产要求公网 HTTPS 域名，禁查询、用户信息、本地/内网地址，local 才允许回环 stub。设置 `redirect:'manual'`，任何 3xx 都不会跟随或转发凭据。不支持视觉输入时拒绝，不回落其他端点。输入最多 32 条消息、`maxInputChars`，序列化工具 body 还有大小界限；JSON 响应最多 4 MiB。敏感上下文设置 `cf-aig-skip-cache=true/cf-aig-collect-log=false`，但不能据此替外部自定义供应商承诺隐私行为。

OpenCode Go 额外要求稳定 opaque session ID，生成 `x-opencode-session` 和已验证 user-agent；不能把用户输入直接当 header。模型 JSON 能力不足时不强行发送不支持字段，仍通过明确 JSON 提示和 Zod 验证。业务最终 JSON 错误由 `aiJsonCall` 至多增加一次修复请求；工具调查结束的修复关闭工具，保留完整输出和已读 ID，提示只纠正字段，且重复原权限/配置/授权检查。输入过大直接拒绝，不静默截掉报告末尾。评分评价可指定 `maxAttempts:1` 禁止修复改变判断。

供应商恢复与 JSON 修复是两个预算维度。`gatewayChat` 仅对已收到的 HTTP 429/500/502/503/504、且 AppError 为 retryable 的 `AI_UNAVAILABLE`，按 1 秒、5 秒、15 秒额外最多三次恢复；从首次明确拒绝开始共享 60 秒窗口，下一次 timeout 取配置 timeout 与窗口剩余时间较小值。调查作业通过 `onProviderRetry` 保存 `attempt/deadline/nextAttemptAt` 后抛 continuation，在独立实例等待后恢复；窗口跨分片不能重置。每次再次调用都执行 beforeFetch 和 prepareMessages。网络失败、超时、重定向、配置/预算/权限错误、解析失败、10034 不属于该恢复列表。调用方不得在 JSON 修复循环中重新启动供应商恢复窗口；`AI_UNAVAILABLE` 终止当前调用内恢复；业务失败另由 D1 持久重试链在至少60秒后排队新作业，最多追加3次，旧未知费用保留待核对。配置、预算和权限拒绝会停止恢复，不能把业务恢复计数与调用内计数混为一谈。存在 `withSingleRetry` helper 也不代表核心链路应重复套用它。

原生搜索由 `nativeSearchCapability` 按 preset/protocol/model 白名单判断，不等于所有兼容模型都能搜索。只有 `allowSearch=true`、公开 `searchQuery`、模型能力支持，才暴露 web_search；工具查询必须与授权查询逐字一致，本轮最多一次。有限金额预算禁原生搜索，因为附加费用不能由 token 上界保证。搜索单独请求只带公开查询，不带项目正文；必须返回 performed 与实际 citations 才可声称联网。Responses 使用 web_search，Messages 使用 web_search_20250305，Gemini 用 google_search，OpenRouter 强制 native 引擎；不可用不回落第三方。供应商真实兼容性仍应逐项验证，尤其 DeepSeek Anthropic 搜索不是仅凭模拟响应即可证明。

## 12. 预算、审计与发布竞态

`usage_reservations` 持有 `project_id/job_id/purpose/estimated_cost/status/max_calls/attempts_started/settled_cost`。每项目同时 reserved 最多 2 个；原子 INSERT 同时检查并发、预算和现有预占，避免应用层先查后写竞态。`reserveAiSlot` 将 kind 映射到 `textEconomy/visionEconomy/review`；默认至少 2 次，最多 24 次。调查到调用额度时，`markAiCallStarted(...,true)` 可在同一预占里追加两个 allowance 至最多 24，并检查余额，不无限创建新预算。4 工具/片、24 请求预算、512 分片分别限制不同资源，不能互相替代。

上述24次是普通调用预占及调查扩容的上限；`markAiCallStarted` 对 purpose 为 `ocr_pages` 的预占有单独计数条件，不能将调查的调用上限直接套用到逐页 OCR。OCR 同时依赖来源、页面范围、页数及图像输入限制。

有限 `ai_budget_usd` 要求 known price、输出 cap、可估算 Workers AI 文本模型；图片/OCR、自定义兼容模型、未知价格、关闭输出 cap 无法保证上界，拒绝而非按零费放行。`estimateCostUsd` 用输入字符转义上界和协议开销规划两次文本请求；它不代表实际供应商账单上限。预算用途与实际 purpose 要对齐，新增调用不能只写模型请求而不预占。

`recordAiCall` 将 input/output 存 `ai-calls/{id}/input.json/output.json`，将模型、`config_version_id/prompt_version/job_id/run_id/reservation_id/draft_id`、用量、延迟、状态写 `ai_calls`。有合法输入/输出 token、配置价格且无 searchUsage 才 `cost_status=known`；缺 usage、无价格、搜索附加费等记 unknown，`cost_usd=null`，不是 0。`settleReservation` 汇总该 reservation 的 calls：存在 unknown 或 `attempts_started > calls`，则 `pending_reconcile`；失败请求已发生调用也结算或待核对，只有没有调用才 released。调用前记尝试是保守规则，后续 guard 拒绝可能留下需核对记录，不可人工把数量差一概视为零费用。

R2/账本写失败不能触发第二次付费请求；checkpoint 先标记 in-flight，可阻止崩溃后无证据重放。`ai_diagnostics`（见 diagnostics.ts）记录请求 ID、协议、HTTP 状态、阶段、safe host/path、失败类别；不要向用户暴露解密密钥、原始供应商响应正文或私有完整输入。

运行前检查并不足以保证发布正确，发布 SQL 仍绑定作业状态、当前项目成员、项目 active、来源 lifecycle、固定材料与实际已读引用、配置版本、设置 revision、任务 revision、提交轮次、guide session 或演练处理权。自动应用再检查一次规则，失败时保留提案/报告及 applyError，供人工审查。发布路径变更必须保留条件 UPDATE/INSERT SELECT 和结果 meta.changes 检查。

## 13. 排查与人工恢复：先取证，再创建新请求

先取前端 job ID，通过 `GET /api/v1/jobs/{jobId}` 看 status/result/error。以下是只读 SQL 示例，将 `'JOB_UUID'` 替换为观察到的 ID；查询应在对应环境的 D1 上运行，不读取私有全文或云端 secret。

```sql
SELECT id,kind,status,attempts,created_at,updated_at,finished_at,
       json_extract(input_json,'$.operation') AS operation,
       json_extract(input_json,'$.configVersionId') AS config_id,
       error_json
FROM jobs WHERE id='JOB_UUID';
SELECT job_id,status,attempts,available_at,lease_until,last_error
FROM job_outbox WHERE job_id='JOB_UUID';
SELECT job_id,slice,instance_id,status,attempts,last_error,updated_at
FROM ai_execution_slices WHERE job_id='JOB_UUID' ORDER BY slice;
SELECT id,purpose,status,estimated_cost,settled_cost,max_calls,attempts_started
FROM usage_reservations WHERE job_id='JOB_UUID';
SELECT id,purpose,model,config_version_id,prompt_version,status,
       prompt_tokens,completion_tokens,cost_status,cost_usd,latency_ms,created_at
FROM ai_calls WHERE job_id='JOB_UUID' ORDER BY created_at;
SELECT id,prompt_version,phase,step,checkpoint_key,updated_at
FROM ai_investigations WHERE job_id='JOB_UUID';
SELECT name,status,args_json,result_json,created_at
FROM ai_tool_calls WHERE job_id='JOB_UUID' ORDER BY created_at;
```

queued 且 outbox pending 看 lease/available_at 和 cron；running 看最新 slice，再查真实 Workflow instance 状态，不能仅因时间长就重派。cron 对超过 5 分钟未更新的 running 每批 10 条执行 `reconcileWorkflowJob`，先检查实例；只有明确 instance.not_found、且没有已开始模型证据的路径才安全补派。查询引擎 transient error 不允许重放。实例已结束而业务未提交则失败并核对费用；最新 pending slice 可由 `recoverExecutionSlices` 补派。超过两小时预占只在 job 不属于 queued/running/waiting_input 时清理，不释放仍在运行的槽位。

waiting_input 看 source processing 和缺图片页；AI_OUTPUT_INVALID 看协议完成状态、output_limit、Zod 字段、引文/coverage；QUOTA_EXCEEDED 看并发、pending_reconcile、max_calls；INVALID_STATE 看 settings/source/config/profile 版本；AI_UNAVAILABLE 看 HTTP 响应与网络失败分类。若有 pendingDispatch 或 usage unknown，先对照供应商调用记录/账单，保留证据；不要手动清 pendingDispatch、重置 running、清 R2 或将 unknown 改为 known 0。

`POST /api/v1/jobs/{jobId}/retry` 仅接受 failed，创建新 job；source.summary 要走 processing/summary 专用入口，`collaboration.*` 从当前任务重新发起重冻快照；演练仅原发起人在旧作业仍持有 processing_job_id 且 rehearsal active 时可重试。成功/取消任务不复活。通用 retry 不保证所有关联业务记录都能重新跑，因此优先使用对应业务的新发起路径，确认旧请求费用后再创建新的付费任务。

### 源码核对清单

可优先阅读 `backend/test/111-investigation-continuation.test.ts`、`113-investigation-execution-slices.test.ts`、`114-native-search-slices.test.ts`、`120-provider-retries.test.ts`、`116-guide-history.test.ts`、`121-project-tool-contracts.test.ts`、`21-provider-adapters.test.ts`、`28-budget-adoption-atomic.test.ts`、`96-output-limit-switch.test.ts`。当前文档只说明源码和已有测试覆盖意图，不宣称这些测试在本次文档调查中重新通过。

维护核对顺序：确认源码与部署版本；用本地 stub 验证 API 到 job 到报告，无付费模型；核对 continuation 穿过每个业务 catch；验证重复派发不重复模型请求、pendingDispatch 拒绝重放；验证拒绝/超时/输出修复分类；验证有限预算和 unknown 结算；验证成员移除、授权撤回、来源回收、设置变更及并发 finish 在发布 SQL 被拒绝；最后在获授权的供应商真实接口逐协议验证 token、搜索证据及计费。真实供应商可达性、当前模型能力和 Worker 子请求深度不能仅凭本地测试确认。
## 14. 前端请求、缓存与编辑安全

### 请求契约和查询刷新

`api/client.ts.request()` 为请求增加合法的 `X-Request-Id`，使用 `credentials: 'include'` 携带会话 Cookie；JSON 正常响应须有 `data`。错误转为 `ApiError`，保留 `status/code/requestId/retryable/stage/action/details`，显示消息通过 `error-info.ts` 转换。网络错误使用状态 0；AbortError 原样抛出；非 JSON 或缺少 data 的成功响应成为 `INVALID_RESPONSE`。遇到非 session 查询的 401 会广播 `auth-expired`，`App.tsx.ProtectedApp` 清空 QueryClient 并跳转登录。

`main.tsx` 的 QueryClient 默认查询新鲜期为 8 秒，窗口聚焦重新取数，最多额外重试一次且不重试 401；mutation 默认不自动重试。页面写入成功后显式失效相关 query key，例如 MaterialsPage 保存后刷新 material、materials、materialVersions 和 resource-library。新增修改必须检查列表、详情、壳内项目状态是否都应刷新，且 key 必须包含项目或账户边界；不要只更新一个局部组件后留下旁边的旧数据。

前端 POST 默认生成幂等键，但每次重新调用 `api.post` 会生成新键；这不是“任意重新点击都不会重复”。需要恢复同一个业务动作时，调用方必须持有并复用原键，服务端具体接口也必须使用 `withIdempotency`。分页批量读取 `listAllItems()` 会检测重复游标、items 缺失及超过 200 页，避免静默返回不完整列表。

### 材料草稿、版本冲突及离开保护

`storage.ts.saveDraft/getDraft/removeDraft` 以账户、项目、材料组成 localStorage 键；保存失败返回 false。`MaterialsPage.tsx` 维护文档、baseRevision 和重连确认状态，保存前提交当前 `expectedRevision`；409 VERSION_CONFLICT 时保留本地内容并读取最新服务器版本，不能通过将 revision 直接改成新值而静默覆盖他人的编辑。离线本机草稿不是已同步的共享材料，也不是跨设备备份。

`SettingsEditGuard.tsx` 用脏编辑集合和 React Router `useBlocker` 拦截页面切换，beforeunload 处理关页，`settings-before-leave` 协調退出登录。新增编辑页面要接入现有 dirty context，而非各自增加互不相容的 confirm。`WorkspaceErrorBoundary` 和 `resilient-lazy` 负责路由运行错误和懒加载资源失败；修改加载/错误流程时需检查手机网络断续及已登录会话恢复。

### PWA 更新、离线边界和通知

`vite.config.ts` 配置更新提示模式、`skipWaiting: false`、`clientsClaim: true`；导航由 `public/navigation-worker.js` 处理，不启用 Workbox 的运行时 HTML 缓存。带 hash 的 JS/CSS 使用 `ai-office-assets-compat-v1` CacheFirst，最多 256 项、保留 7 天，帮助旧标签页读取旧 chunk。API 由网络和后端提供，不把 Service Worker 缓存视为业务数据源。

`public/app-updates.js` 的更新控制器注册 `/sw.js`，检查等待 worker，确认后发 `SKIP_WAITING`，等待控制及激活后重新加载；重新加载发 `app-update-reload`，编辑保护识别该确认流程。新增 PWA 更新逻辑要配合既有草稿/dirty 保护，验证旧标签页、失败恢复和离线情形，避免只测全新打开页面。

`NotificationRuntime.tsx` 随登录账户挂载，`App.tsx.PwaStatus` 将通知 scope 切到账户加项目。服务端 `services/notifications.ts`、`web-push.ts` 与 `api/notifications.ts` 管理通知和设备订阅，浏览器推送由 `public/push-worker.js` 处理。账户通知、项目通知、系统更新提示具有不同作用域，退出登录和切换账户的测试不能省略。Web Push 还依赖浏览器权限及 VAPID 配置，单元测试不等于真机推送通过。

## 15. 本地启动、契约同步与验证

### Windows PowerShell 的可重复开发流程

以下命令在仓库根目录运行；分别检查退出码，失败即停止后续步骤。本地迁移仅针对模拟数据库；不附带 remote 或 production。两终端启动比后台进程更易观察错误：终端 A 跑后端，终端 B 跑前端，结束时 Ctrl+C。

```powershell
npm run install:all
if (!(Test-Path backend/.dev.vars)) {
  Copy-Item backend/.dev.vars.example backend/.dev.vars
}
git check-ignore backend/.dev.vars
```

复制后先在本机编辑 backend/.dev.vars，将 AUTH_SECRET、ADMIN_TOKEN 的示例值换为独立随机开发值；本地不调用模型时其余 provider 值可保持为空。下面初始化命令只适用于新的、空的本地模拟库；已有本地库先核对迁移和数据，不要盲目全量应用0033。全量新库重放包含0033，并移除旧人工账本表；不能用空库验证直接推断目标生产库的实际迁移状态。

```powershell
Push-Location backend
npm exec -- wrangler d1 migrations apply DB --local
Pop-Location
npm run bootstrap:admin:local
npm run dev:backend
```

bootstrap 仅初始化本地管理员，凭据保存在 Git 忽略目录；重复运行不会自动重置密码。查看本机凭据再登录，不把其内容粘贴到公开报告。后端终端保持运行。

另开终端进入同一仓库根目录：

```powershell
npm run dev:frontend
Invoke-RestMethod http://localhost:5173/api/v1/health
Invoke-RestMethod http://localhost:5173/api/v1/health/deps
```

Vite 默认 5173，代理 `/api` 到 127.0.0.1:8787；`AI_OFFICE_API_TARGET` 可更改代理目标。localhost 前端与后端要使用一致地址，避免会话、Origin 和代理产生误判。首次创建本地测试账号可按仓库 bootstrap 的 local 流程操作；私密参数放忽略文件，不把真实密码、密钥写进终端命令历史、报告或 Git。不要为解决本地登录覆盖生产凭据。

如确实需隐藏后台开发服务，使用 PowerShell `Start-Process`、`-WindowStyle Hidden`，分别将 stdout/stderr 指向本地忽略日志并保留 `-PassThru` 的进程信息。停止时只终止本次启动的准确进程或进程树；不要全局终止 node/wrangler。CLI 版本可从 package-lock 和 npm 脚本核对，不要求全局安装另一个 Wrangler。

### OpenAPI 变更顺序

契约来源为后端路由中的 createRoute/Zod schema，导出文件是生成物：

```powershell
npm run export:openapi --prefix backend
npm run typegen --prefix frontend
npm run typecheck
npm run lint
```

`backend/scripts/export-openapi.ts` 调用 createApp 导出到 `backend/openapi/openapi.json`；`frontend` typegen 生成 `src/api/openapi.ts`，手写业务别名在 `api/types.ts`。不能只改生成的 TypeScript 消除报错；必须同步请求验证、返回 DTO、契约和页面读取。导出后检查 diff 是否只出现预期内容，并跑 `backend/test/03-contract.test.ts`。

### 按变更选择测试

后端 Vitest 配置使用 Cloudflare Workers pool，`test/setup.ts` 在模拟 D1 按序应用迁移；测试 mock 模型调用，不应用测试去证明真实 provider 可用。按变更范围运行受影响测试及必要的全量检查，前端最终 build 已含 tsc。

| 变更范围 | 最低优先测试 |
| --- | --- |
| 上传、来源生命周期、解析 | 10-files、70-sources-parse、源分页与文件/来源生命周期相关测试 |
| 材料和任务 | 80-tasks-materials、102-project-simplification、110-project-plans-assessments-tools |
| 登录和权限 | 40-auth、41-password-kdf、43-account-roles、121-member-permissions |
| 评分与演练 | 84-reviews-rehearsals、110-project-plans-assessments-tools、114-rehearsal-ownership |
| AI 工具/执行恢复 | 121-project-tool-contracts、109-project-reference-guard、116-independent-workflow-slices、120-provider-retries |
| 前端请求与草稿 | api/client.test、storage.test、MaterialsPage 相关测试、SettingsEditGuard 相关测试 |
| 导航、帮助和 PWA | project-routes、HelpPage、AppShell、app-updates、navigation-worker、asset-compat、push-worker |

可从根目录运行 `npm run test:backend`、`npm run test:frontend`、`npm run typecheck`、`npm run lint`、`npm run build`。定向运行示例为 `npm test --prefix backend -- test/80-tasks-materials.test.ts`。有 UI 改动须另外真实浏览器核对桌面和手机宽度、深链接刷新、键盘和错误态；有运行时依赖改动须区分本地 Worker 模拟与线上 Cloudflare 实测。

## 16. 迁移与结构核对

1. 先查看 Git 状态、当前迁移文件和部署配置，再以只读方式核对目标 D1 的 `d1_migrations`、`sqlite_master`、关键表 `PRAGMA table_info/foreign_key_list/index_list`。生产资源 ID、凭据和业务数据不应出现在公开帮助文档。
2. 当前存在两个 `0025`：`0025_project_simplification.sql` 与 `0025_ticket_images.sql`。跟踪的是完整文件名；不能按数字前缀去重或认定二者互相替代。存在 0007 等编号缺口不代表数据库缺迁移，不得凭空补 SQL。
3. `0033_remove_manual_ledger.sql` 清空 contributions.correction_of 后 DROP contributions、resource_references、decisions。当前结构参考包含该迁移；重放新数据库与更新既有生产库是两种不同任务。未确认备份、实际迁移记录和历史数据保留要求前不能执行该文件。
4. 0012 是新增 auth_accounts 并回填联系邮箱，不迁移 user ID；0013 包含一个历史指定身份的角色回填，仅适合了解历史，不能当通用新环境 bootstrap；0026 先保存旧成员档案导入候选再清项目域字段，不能拆开运行。0030 清除 team_size_limit，0036 根据历史回答和作业回填作者/处理持有者，0037 建立通知 baseline，都含数据迁移副作用。
5. 本地参考重放必须有 SQLite JSON1、外键约束和迁移依赖；执行检查点为 integrity_check 与 foreign_key_check。通过空数据库检查只能证明结构可创建，不能验证存量数据转换；对真实迁移还需使用相关 preservation 测试和脱敏副本进行前后行数、ID、引用链及字段值核对。
6. 写跨表业务改动前找对应 service 的 CAS 门禁与 batch 边界；写 JSON 字段前找 Zod schema、契约和 toView 映射；删除文件前读 lifecycle/GC；改变任务图前读 validateTaskGraph；改变 AI 执行前读 budget/jobs/execution-slices/investigation。只改前端模型或数据库字段，通常无法完成完整行为变更。

### 可复现核对流程

```text
py scripts/verify-handover-docs.py
```

文档结构验证脚本在本地 SQLite 内存重放迁移，并核对已发布的结构字典；不连接生产，也不修改项目数据库。本次额外结构证据记录迁移完整文件名、执行/跳过原因与 SHA-256、所有表列/FK/索引/DDL、视图/触发器、完整性检查结果及生产结构离线比对。服务行为核对基于 jobs.ts、budget.ts、collaboration.ts、project-simplification.ts、source-summary.ts、document-chunks.ts、ai-execution-slices.ts、project-investigation.ts 等现行源码。完整列字典应作为可下载附录，帮助页面正文优先呈现关系、状态与读写入口。

## 17. 发布、恢复与排障

### 环境绑定与生产迁移

后端环境有 local、staging、production；绑定名称为 `DB`、`FILES`、`PARSE_WORKFLOW`、`AGENT_WORKFLOW`，cron 每分钟执行；前端绑定 `ASSETS` 和 `API`。现有 production 使用两个 Worker，前端 Service Binding 指向同环境后端。保留 wrangler 配置中的真实资源，不重建数据库或桶来“修复”环境。staging 的占位配置未完成时预检应失败，不可擅自借生产绑定。

Env 中需要按部署功能核对的敏感变量名称包括 AUTH_SECRET、CLOUDFLARE_API_TOKEN、ADMIN_TOKEN、RESEND_API_KEY、TURNSTILE_SECRET_KEY、VAPID_PRIVATE_KEY；其他绑定变量/配置包括 CLOUDFLARE_ACCOUNT_ID、AI_GATEWAY_ID、ALLOWED_ORIGINS、EMAIL_FROM、VAPID_PUBLIC_KEY、VAPID_SUBJECT。这里只列名称，实际是否必需应结合所启用功能和服务代码核对。当前 Env.AUTH_MODE 类型仍写 invite-only/turnstile，而 wrangler 实际使用 password，是需要核对的类型与配置不一致处；不要据旧枚举重新开启旧邮件登录。

发布前执行 `npm run preflight:deploy -- production`。`scripts/preflight-deploy.mjs` 检查环境、password 模式、D1/R2/Workflows、前后端 Service Binding 和 HTTPS Origins；它不会部署，也不验证线上 Secrets、数据库版本或真实模型。后端有 deploy:production 脚本；前端部署需在 build 后用现有 production Wrangler 配置。顺序按契约兼容性决定，一般先发布兼容旧前端的后端，再发布前端及静态资源，之后验证线上资源和 API。

禁止把 `wrangler d1 migrations apply --remote` 当成可直接执行的生产全量更新。`0033_remove_manual_ledger.sql` 会清除 correction_of 自引用并 DROP contributions、resource_references、decisions；它是破坏性历史迁移。先读取目标库迁移历史与真实 schema，列出已应用/待应用范围，核对数据依赖并备份，再决定单项批准的迁移。不能只将文件移走或更改迁移记录来绕过风险，也不能让测试已全量迁移的结果替代生产库判断。

生产备份应使用整库可恢复导出并保护文件访问，另核对 R2 对象、配置版本及作业恢复要求；数据库 SQL 不是文件对象的备份。`npm run backup:drill:local` 是独立模拟恢复演练，不能证明当前生产备份齐全。恢复后还需检查 users/project_members 外键、版本指针、jobs/预算预留及引用有效性；不要自动 reset 管理账号或重放仍在执行的付费作业。

### 排障取证顺序

请求失败先保留 requestId、时间、URL、账户/项目操作类型和错误 code/stage/action，不复制 Cookie 或 token。`health` 只能证明 Worker 存活；`health/deps` 返回 D1/R2 可达性，不能证明业务权限、schema 完整或模型正常。后端 `request_failed` 日志包含 requestId/code/httpStatus/retryable，公共错误有脱敏；需要深入诊断时使用现有允许的管理员诊断，不把 provider 原始响应公开到帮助页面。

异步任务先查 `/api/v1/jobs/{jobId}` 与创建业务对象：确认 queued/running/succeeded/failed、输入配置版本、实体版本和 Workflow ID/状态，然后判断是否可恢复。requestId 标识某次 HTTP，jobId 标识持久作业，Workflow instance 标识执行容器；三者不能互换。长作业要核对执行切片/continuation 与现有运行实例，避免因页面超时再次创建作业。失败是否可重试以错误分类和保存的业务状态为准，而非统一重新 POST。

怀疑 schema 漂移时查看目标库迁移历史及 `sqlite_master`/表字段、索引、外键；核对报错 SQL 所需列在哪个迁移加入，比较源码 DTO 与 OpenAPI 生成物。不要把 ai_config_versions.version、材料 revision、任务 graph_revision 当成数据库 schema 版本。前端菜单或代码旧时比较构建版本、hash 静态资源、等待 Service Worker 和旧标签页；先保存草稿再按既有更新流程刷新。

## 18. 典型扩展方法与当前状态边界

### 为实体增加字段

先写清字段属于实体当前属性、不可变版本快照还是派生展示。增加向后兼容迁移并决定旧行默认值；更新 SQL 写入/读取、Zod 验证和 DTO；必要时增加 expectedRevision 防并发覆盖及事务 guard；导出 OpenAPI/typegen；更新页面输入、空值展示、query 失效、导出及 AI 上下文。测试覆盖旧数据、未传字段、非法值、跨项目引用和版本冲突。最后检查新增字段是否含隐私，是否应该进入 AI 工具、公共资料或通知载荷。

### 增加 AI 工具或一种 AI 作业

读 `services/project-ai-tools.ts.projectToolDefinitions/executeFileTool/projectToolConversation`，先定义模型可见的 schema、参数限制、服务端绑定 context 和结果 DTO；严禁让模型参数决定 actor/project/session 身份。执行前后沿用 assertToolAccess、文件/来源生命周期快照及引用核验，记录脱敏 ai_tool_calls；接入 tool transport 时同时考虑可支持的 provider 及 continuation checkpoint。新作业还需 API 参数冻结、job 类型/dispatcher、预算预留、Workflow 可恢复分支、幂等发布与失败结算。不要只写一个 fetch gateway 的 handler 就绕过持久执行和费用证据。

测试至少涵盖非法参数、非成员/撤权、跨项目文件、软删除后的输入、模型返回格式错误、工具多轮上限、执行恢复及结果重复发布；更新功能入口和契约后再做本地/线上边界明确的验证。

### 当前工作区不是生产版本证明

本次核对时，`backend/src/services/agent.ts`、`assessments.ts`、`assignment.ts`、`guide-history.ts`、`project-ai-tools.ts`、`project-context.ts` 六个服务已有未提交修改；相应部分测试以及前端帮助/移动导航也有未提交改动。本文描述的是读取时的工作区实现，不能据此推断所有分支已经提交或线上 Worker 已部署相同实现。变更与发布核对前应保存 git status/diff、当前 commit、目标 Worker 版本及前端构建版本，分别确认这些修改的负责人、测试状态和发布范围；不要为“清理工作区”丢弃它们，也不要把 unrelated 后端改动夹进文档发布。
## 19. 术语与维护验证

| 标识或概念 | 应用于哪里 | 不应混用的概念 |
| --- | --- | --- |
| requestId | 某一次 HTTP 请求、响应错误与 request_failed 日志 | 一次点击可能创建长期 job，requestId 不等于 jobId |
| jobId | jobs 与调用、预占、调查、工具审计关联 | jobs.attempts 不是模型调用次数 |
| Workflow instance_id | 某一运行实例，首片为 jobId，后续为 jobId-sN | slice 是执行预算边界，不是新的业务任务 |
| configVersionId / promptVersion | 模型配置快照 / 提示词语义版本 | 当前配置不自动替换过去输入 |
| revision / graph_revision / lifecycle_version | 实体编辑 / 全图变更 / 删除恢复有效性 | 数据库迁移版本是 d1_migrations 的完整文件名 |
| source / material / fixed version | 来源证据 / 成果文档 / 已保存不可变版本 | 草稿、总结、附件目录不等于已核验原文 |
| read reference / decision reference | 实际读过的片段 / 对某项决定使用的依据 | 引文格式合法不证明语义判断正确 |
| reserved / pending_reconcile | 在途预算预占 / 费用不确定待核对 | 请求失败不等于供应商未受理或免费 |

维护验证应形成可复核记录：本地安装和构建正常；登录及五组项目功能可定位到路由与 SQL；数据库字典验证通过并与目标环境迁移记录对齐；固定响应模型夹具能追踪排队、调用、报告和发布；并发编辑、撤权、回收站、pendingDispatch 及重复执行负向测试通过；发布只包含已核对的变更；线上资源和 API 状态有独立检查。真实模型费用、质量、设备推送与平台限制仍需单独验证，不能把本文的结构检查当成这些结果。

## 20. 全表定位目录

以下目录覆盖全部 78 张应用表；同域关系及核心列见前文，完整列/约束见结构附录。目录没有列出的 templates、exports、document_chunks、attachments 不是遗漏的数据库表。

| 域 | 表 | 用途与关系 |
| --- | --- | --- |
| 身份 | `users`, `auth_accounts`, `sessions` | 用户主体、密码身份与会话；账号和会话引用 users。 |
| 账号治理 | `account_invitations`, `account_role_audit` | 注册邀请及角色变更审计；创建/使用/操作/目标用户引用 users，不与项目邀请混用。 |
| 登录保护 | `auth_challenges`, `auth_password_rate_limits` | 邮箱验证码挑战的 HMAC/尝试/过期消费状态；密码登录限流的 bucket_key/attempts/expires_at。 |
| 邮件配额 | `auth_email_daily_usage`, `auth_email_recipient_usage`, `auth_email_ip_attempts` | 分别按 day、(day,email_hash)、ip_hash/attempted_at 计数或记录；非用户 FK 关联，不存验证码明文。 |
| 档案 | `personal_profiles`, `personal_profile_import_candidates` | 用户全局档案及旧成员档案候选，均归属 user；公开与AI使用同意独立。 |
| 项目 | `projects`, `project_members`, `project_goals` | 项目/成员/单主目标；成员(project,user)唯一，目标(project)一对一。 |
| 项目邀请 | `invitations`, `project_username_invitations` | 项目邀请码与指定账号邀请；邀请码保存 hash，用户名邀请保存处理状态和过期时间。 |
| 推进 | `project_progression`, `project_admin_feedback` | 项目推进游标 observed/pending_event 与待执行job；项目管理者人工反馈与是否要求AI重做，归属 project。 |
| 创建草稿 | `project_creation_drafts`, `creation_draft_files` | 未创建正式项目的私人工作区与上传文件，draft→owner，draft_file→draft。 |
| 文件 | `files`, `file_contributors` | 原文件对象索引与贡献署名；file→project/user，contributor→file并保留用户姓名快照。 |
| 来源 | `sources`, `source_versions`, `source_pages`, `source_fragments`, `source_processing` | 来源实体→版本→页/原文片段/处理状态；版本关联原文件与冻结AI配置。 |
| 材料 | `materials`, `material_versions` | 可编辑资料实体与内容/附件/作者快照，按(material,revision)唯一。 |
| 要求与标准 | `requirement_sets`, `requirements`, `rubric_versions`, `standards_versions` | 要求集→要求；评分维度版本→已发布整体标准快照。 |
| 任务图 | `tasks`, `task_dependencies`, `task_links` | 任务、项目内依赖边、多态关联；task_links种类 requirement/material/source_version/file，target_id需服务验证。 |
| 任务交付 | `task_submissions`, `task_summaries` | 每轮提交及哈希隔离摘要；提交保留当时标准、材料与任务版本。 |
| 任务准备 | `task_readiness`, `task_completion_people` | readiness基线/generation与实际完成者，关联tasks；配合视图/触发器。 |
| 私密询问 | `task_inquiries`, `task_inquiry_messages` | 当前/上游任务与请求者/收件人形成询问，消息归属inquiry/author。 |
| 协作建议 | `collaboration_proposals`, `collaboration_proposal_revisions` | 一个job一条规划/分工建议，修订保存原payload与人工理由。 |
| 助手 | `agent_sessions`, `agent_turns`, `agent_runs` | 项目助手会话、唯一(session,sequence)回合、执行/采纳证据；run关联job并保存inputs/output与采纳material version。 |
| 评估 | `assessments`, `assessment_corrections`, `reviews` | 统一评估及修订历史、原有预审底层实体；绑定已发布标准与材料版本证据。 |
| 答辩 | `rehearsals`, `rehearsal_turns` | 答辩范围/版本/处理作业、按序回合与回答作者。 |
| 过程记录 | `events`, `comments` | events按(project,type,entity_type,entity_id,dedup_key)去重；comments按target_type/id定位，多态target不含FK。 |
| 作业 | `jobs`, `job_outbox`, `ai_execution_slices`, `idempotency_records` | 业务任务、可靠派发、独立执行接力与HTTP请求去重；不能用一张表的状态替代全部执行证据。 |
| AI配置 | `ai_config_versions`, `ai_probes`, `app_config` | 模型配置版本；probe复合PK(config_version_id,purpose)保存能力检查passed/report/tested_at；app_config按key保存应用级JSON与时间。 |
| AI执行 | `ai_calls`, `usage_reservations`, `ai_investigations`, `ai_tool_calls`, `ai_diagnostics` | 调用证据、预算/并发预占、R2调查检查点索引、工具证据、有界无内容诊断。 |
| 通知 | `notification_settings`, `notification_events`, `notification_inbox`, `push_subscriptions`, `notification_push_outbox` | 用户站内/Push开关、去重事件、每人已读状态、设备订阅与可靠网络发件箱。 |
| 反馈工单 | `support_tickets`, `support_ticket_messages`, `support_ticket_images` | 私人工单→回复/状态记录/图片；ticket归owner，message归author；图片先reserve pending再R2上传ready，限制类型与1..5MB。 |

当前标准由 `backend/src/services/effective-standard.ts` 统一解析：最高保存版本立即生效，新保存和修订均创建不可变版本。`GET /standards/current` 提供使用入口；不再注册标准确认接口。新评分、演练、任务评价和 AI 资料工具自动绑定此版本；模型调用、发布、应用及重试均核对版本，旧版本只可作为历史依据读取。`0044_saved_standard_activation.sql` 冻结旧保存草稿及引用组件，不改写已有报告。

### 任务设置自动保存与质询入口

任务设置由 TaskSettings 串行保存内容、依赖、分工，停止输入三秒和区域失焦触发保存，窗口关闭调用异步保存守卫。任务写入采用响应中的 revision；依赖采用最新 graphRevision，提交依赖后重新读取任务版本。409 后重新读取任务和依赖图，三方字段合并仅自动处理无冲突字段；同字段冲突保留草稿并要求选择。前端版本提示隐藏，后端事务守卫和审计保留。

任务质询按一对一工单组织。项目成员可在对应任务中选另一位项目成员创建工单，不要求是任务执行人，也不受依赖关系或任务状态限制。新记录将 `task_id` 与 `upstream_task_id` 都设为该对应任务；创建与回复通知均跳转到该任务。列表、回复和已读接口仍逐项校验发起者/接收者与当前项目成员资格，只有工单双方可见。旧记录的两个任务 ID 保持不变，并继续分别显示在历史发起任务和接收任务。GET /task-inquiries/unread 复用 `notification_inbox.read_at` 汇总；POST /tasks/{taskId}/inquiries/read 只更新已展示的 `messageIds`。无需数据库迁移。

离线工作台在项目入口、online、focus 和可见状态恢复时先 synchronizeOffline 再 prepareProject；组件和缓存准备层合并重复执行。正常联网时隐藏缓存就绪提示，失败与冲突仍可处理。可缓存 GET 优先读取当前账户的 IndexedDB 快照（含待同步操作叠加），再合并重复请求、后台静默更新；后台请求限时 15 秒，失败保留当前内容，快照变化后失效活动查询以刷新视图。任务页的澄清、建议历史及质询未读列表也纳入缓存；项目准备先保存任务与材料，再分批读取独立页面，单项失败不阻止其他页面保存，仅完整成功后写入就绪标记。Service Worker 对工作台导航优先返回构建时预缓存的静态入口，API 数据仍由账户隔离的应用缓存负责。

### 任务文件版本与归档（0055）

项目可供 AI 引用的业务输入和内容节点由 `AiReferenceBadge` 标记，`Field` / `SectionCard` 通过显式 `aiReference` 开启；标识为蓝色胶囊，不向用户正文写入告知文字。AppShell 内的 `AiReferencePreferencesProvider` 按账户读取本浏览器偏好，用户在“设置 → 外观”控制显示，默认开启，跨标签页通过 storage 事件同步。隐藏标识不改变个人资料授权或服务器读取权限；个人资料只有 aiUseAllowed 为真时标记，私密任务质询和安全凭据不标记。

0055_task_files_archive.sql 为 files 增加 archived_at，为 materials 增加 task_id/archived_at，并新增 task_file_uploads 保存物理上传文件到稳定材料身份的映射。一个任务上传文件对应 kind=task-file 的材料；current_version_id 指向当前附件，替换上传新 R2 对象及不可变 material_versions，旧文件和提交快照保留。登记按 fileId 去重，替换成功响应丢失后重试同一当前 fileId 返回原结果。新文件自动产生材料，提交界面按未归档当前版本构建 materialVersionIds，原提交协议保留。

任务文件管理权限在事务内重检当前执行人或 resourceManage；公共材料创建者和公共文件上传者可管理本人的内容。更换执行人后前任不再因上传身份管理任务文件。文件归档复用 lifecycle_version 乐观锁，材料归档递增 revision；审计与状态更新处于同一事务。归档和回收站分离，恢复文件不恢复整份材料。任务文件正文禁止普通编辑和 AI 采纳，通过文件替换入口更新。

共享 archive-policy 过滤默认 AI 文件发现、资料搜索、任务计划和交接输入；已归档或已被新版本替换的上传不进入普通列表。显式固定版本读取、历史提交和前置任务成果快照保留，不因归档破坏历史证据。提交写入事务拒绝已归档材料或附件，避免读取列表后发生归档仍提交。未提取正文的附件沿用现有未读证据与人工验收规则，不把上传成功视为 AI 已完整读取。

### 标准摘要展示与提交正文折叠

评分分区导航由 ProjectSectionNavigation 统一提供，保留 assessment 的 section 查询参数与旧 requirements/reviews/rehearsals 路由。StandardsEditor 保留评分维度编辑与历史入口，StandardSummary 只遍历 rubric.weights，并按 mappings 从对应 requirements.citations 生成引用编号；不会从 rubric.notes 猜测来源。编号按首次出现顺序分配，以固定 fileId 优先去重，文件名仅在底部引用列表展示。固定文件采用带成员权限的文件内容链接，避免当前来源版本的归档状态影响旧引用定位。

standardView 批量读取项目范围内的引用元数据与可用状态，源版本引用每份标准仅增加一次批量查询，fragmentId 历史引用另加一次解析查询。输出补充可选文件名和定位信息，不修改 snapshot_json 或评分规则；2000 条重复引用的测试验证仅执行两次读取（版本状态及引用元数据）。SubmissionBody 使用默认关闭的原生 details，仅折叠成果正文，完整文本和验收控件保留。此变更不需要数据库迁移。

### AI 失败请求批量重试

`0056/0057` 新增管理员批次、失败快照、后继映射和自动恢复队列。`cron` 分批执行 `recoverAdminAiRetries` 与 `recoverAutomaticAiRetries`，调用共同的业务恢复校验；并发槽位不足继续排队，预算/权限/输入失效则停止。管理员读取统计，超级管理员才能一键入队。`GET /jobs/{id}` 跟随后继，待自动恢复的失败尝试对逻辑请求呈现 queued 并附 retry 元数据，保留原始错误；数据库旧失败作业仍保持终态。详见仓库 `docs/AI-RETRIES.md` 与 `docs/GEMINI-VOICE-PLAN.md`，语音答辩已接入，文件转录仅Whisper；实时转录经Gateway、TTS使用系统本地语音，失败回退文字，真实模型验收仍需专用凭据。

### 音频模型职责与语音答辩

设置将 mediaUnderstanding 音视频理解、audioFileTranscription 固定 Whisper、realtimeAudioTranscription 专用实时模型、rehearsalSpeech 系统本地 TTS 和 processingStrategies 分开。新语音调用由后台保存凭据，浏览器只连接本项目 WebSocket，不发送项目材料给 ASR，也不让 TTS 出题，本地朗读不向合成服务器发送文字。语音失败切回文字，最终字幕保留，仍由用户核对并提交原 answers 接口；后台文字模型生成追问与评分。详见仓库 docs/GEMINI-VOICE-PLAN.md 的接口、权限、账目和真实验收边界。
### 评分生成输出契约 v2 与错误透传

standards.generate 使用严格 scoringStandardOutputSchema，只接受 methodSource 和 dimensions，维度只含 key/label/weight/citations。documented 必须引用实际读取的 source 固定片段，名称与原始分值逐字可验证，引用不得夹带其他原文；proposed 根据主目标生成总和100的权重，引用必须为空。服务端转换到兼容保存结构时 detail/notes 为空、category=scoring、日期为 null，原始分值按比例转换为百分比。scoringOnly 上下文只预载来源目录，仅暴露原文检索工具，不读取任务、反馈、旧标准或模型总结。引用批量补充原文件名和定位字段，前端 fromGenerated 保留并通过保存协议传回引用核心字段。scoringOutputVersion=2 阻止旧格式任务恢复或旧成功结果进入编辑器，不重放旧的已付费调查。

ApiError.message 直接取后端 message，兼容无错误码/请求编号的消息对象及纯文本原因。ErrorNotice、页面边界和所有作业/传输/通知/权限错误入口使用统一 errorMessage 原文显示，React 文本节点安全渲染并保留换行；诊断元数据只留在内部，不作为网页错误提示展示，不追加 traceback 或固定泛化提示。
