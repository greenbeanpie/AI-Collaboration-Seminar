# 后端实现计划（backend_plan.md）

> 依据：[PLAN.md](./PLAN.md) 第二章「后端开发计划」。本文档由后端 AI 维护，是后端实施的执行蓝图；与 PLAN.md 冲突时以 PLAN.md 为准，并在本文档记录差异及原因。
>
> 版本：v3（2026-09-29，M0–M5 实施后更新）｜执行分支：`backend`｜当前进度：M0–M5 ✅（契约 55 路径，60 用例全绿）／M6 待实施

---

## 0. 已确认决策与待确认问题

### 0.1 已确认决策（2026-09-29 与后端负责人确认）

| 事项 | 决策 | 影响 |
|---|---|---|
| Cloudflare 资源 | 已有账号，**免费套餐优先**；开发先走 `wrangler dev` 本地模拟，真实资源由负责人按第 10.1 节清单创建 | B0 必须实测免费版 CPU 限制，准备降级路径（见 12.1） |
| 验证码邮件 | **先实现 `EmailProvider` 接口 + 开发回显模式**（验证码仅日志回显，限本地与演示）；拿到可验证域名后在 B1 接 Resend | 邮件通道不影响其他模块开发进度 |
| 模型 | **暂无任何模型 Key**。B0 用 Cloudflare Workers AI（自带免费额度、无需外部 Key）兜底跑通链路；`ai_config_versions` 按多供应商设计，组长提供 Key 后经能力探测即启用 | 能力探测脚本必须先就绪 |
| 排期 | **核心纵切优先**：先打通 登录→项目→上传→解析→AI 补位→采纳 端到端；预审/答辩随后；加固穿插 | 里程碑顺序按第 11 节调整，B0–B5 验收标准保留 |

### 0.2 待确认问题（随时可推翻已确认决策）

| # | 问题 | 当前默认处理 | 需要谁拍板 |
|---|---|---|---|
| 1 | 免费版 Workers 每次请求 10ms CPU，`unpdf` 解析 30 页 PDF 大概率超限 | M1 实测定路径（12.1） | 后端负责人 + 组长 |
| 2 | Workflows 免费版配额/并发上限未实测 | M1 实测并记录 | 后端负责人 |
| 3 | Resend 发信域名未定 | 回显模式先行，接口预留 | 组长 |
| 4 | 正式模型 Key（GLM/Gemini）待提供 | Workers AI 兜底 | 组长 |
| 5 | 前端 Worker 的 Service Binding 指向后端 Worker 名（暂定 `ai-office-api`）需与前端 AI 对齐 | 写入 OpenAPI 交接说明 | 组长转达前端 |

---

## 1. 角色与协作约定

- **分支**：后端全部工作在 `backend` 分支进行；只使用普通 `commit` / `push`，**禁止任何 force 操作**；merge 进 `main` 由组长执行。
- **提交信息**：中文一句话描述，按里程碑分批提交，每个里程碑保持可构建、测试通过。
- **目录**：后端代码全部位于 `backend/`，不触碰仓库根部的 PLAN.md 等既有文件（遵循 PLAN「独立目录」要求）。
- **契约冻结**：接口契约由双方共同确认，不能单方面修改（PLAN 约定）。具体机制：
  - 后端以 `@hono/zod-openapi` 生成 OpenAPI 3.1 文档，构建时导出 `backend/openapi/openapi.json`，作为**契约唯一来源**，前端 MSW 以此为依据。
  - PLAN 第 8 节端点清单与三个冻结写请求（AI 补位 / 草稿采纳 / 预审）不得单方面修改；如实现中发现契约缺陷，先在后端提出 issue 级记录（本文档 0.2 表），经组长转达前端双方确认后修改。
  - 本计划新增的内部表 `agent_runs`（见 5.6）纯内部实现，不影响任何对外契约。
- **与前端对齐的运行时约定**：统一响应 `ApiSuccess/ApiFailure` + `requestId`（同时回显 `X-Request-Id` 响应头）；异步任务 `202 + jobId`；`409 VERSION_CONFLICT` 携带服务器当前版本；`/capabilities` 提供文件限制与功能开关。

---

## 2. 技术栈（严格遵循 PLAN 二.1）

| 部分 | 选择 | 说明 |
|---|---|---|
| 语言/路由 | TypeScript（strict）+ Hono | 单 Worker 入口：`fetch` + `scheduled` + Workflow 类导出 |
| 校验/契约 | Zod + `@hono/zod-openapi`（OpenAPI 3.1） | 路由即契约 |
| 数据访问 | D1 prepared statements + `wrangler d1 migrations` | 不引入 ORM；提供极薄查询助手与 `batch()` 事务封装 |
| 文件 | 私有 R2 | 桶不公开，下载一律经鉴权 API |
| 耗时处理 | Cloudflare Workflows | 每个 jobId 对应确定性实例 ID |
| PDF 文本层 | `unpdf` | 按页提取；免费 CPU 限制的降级路径见 13.1 |
| 模型 | Cloudflare AI Gateway REST | `POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions` + `cf-aig-gateway-id`；Workers AI 与未来外部模型统一走此通道，不使用已弃用的 `/compat` 入口 |
| 邮件 | `EmailProvider` 适配器 | 首实现：`EchoProvider`（开发回显）；预留 `ResendProvider`（HTTP API） |
| 测试 | Vitest + `@cloudflare/vitest-pool-workers` | 本地 miniflare 提供 D1/R2/Workflows 模拟；Gateway 调用在测试中注入 mock |
| 明确不做 | 向量数据库、Redis、实时协同、独立微服务、自主多 Agent 协商、ORM | PLAN 明确排除 |

---

## 3. 工程结构

```
backend/
├── package.json  tsconfig.json  vitest.config.ts  wrangler.jsonc
├── src/
│   ├── index.ts            # 导出 default(fetch)、scheduled、Workflow 类
│   ├── env.ts              # Bindings/Env 类型（D1、R2、vars、secrets）
│   ├── core/               # 横切机制
│   │   ├── http.ts         # 统一响应 ApiSuccess/ApiFailure、requestId、错误映射
│   │   ├── errors.ts       # AppError + 错误码目录（4.1）
│   │   ├── auth.ts         # 会话中间件、验证码、HMAC、Cookie
│   │   ├── permission.ts   # 成员关系/角色检查、权限矩阵
│   │   ├── idempotency.ts  # Idempotency-Key 处理
│   │   ├── pagination.ts   # 游标分页
│   │   └── origin.ts       # 写请求 Origin 校验
│   ├── db/
│   │   ├── query.ts        # prepared statement 助手、batch 事务封装
│   │   └── ids.ts          # uuid 生成
│   ├── api/                # 按域路由（auth/projects/files/sources/requirements/tasks/materials/agent/jobs/reviews/rehearsals/ledger/export/admin/capabilities）
│   ├── services/           # 业务逻辑（解析流水线、七项能力、预算、账本、文件校验、网页抓取）
│   ├── ai/
│   │   ├── gateway.ts      # AI Gateway REST 客户端（重试策略：应用层最多一次）
│   │   ├── config.ts       # ai_config_versions 读取与任务级锁定
│   │   ├── validate.ts     # Zod 输出校验、引用/分数/归属/日期复核、一次格式修复
│   │   └── prompts/        # 提示词模板（版本号常量，输入快照一并落库）
│   ├── email/
│   │   ├── provider.ts     # EmailProvider 接口
│   │   ├── echo.ts         # 开发回显实现（仅限非生产）
│   │   └── resend.ts       # Resend HTTP 实现（拿到域名后启用）
│   ├── workflows/          # ParseSource / AgentRun / Review / RehearsalTurn / WebFetch / Gc
│   └── cron.ts             # scheduled：恢复器（每分钟）、长期非终态核对、过期数据 GC
├── migrations/             # D1 SQL 迁移（0001 起，只增不改）
├── openapi/                # 构建产物 openapi.json（提交入库，供前端）
├── scripts/                # 能力探测、ai-config 种子、资源创建清单辅助
├── test/                   # 集成与单元测试
└── docs/                   # DEPLOY.md 部署说明、OPERATIONS.md 运维与恢复说明
```

### 3.1 环境与配置

`wrangler.jsonc` 定义 `environments`：`staging`、`production`（本地开发用顶层默认配置 + `.dev.vars`）。三环境分别使用独立 D1、R2、Gateway 与 Secrets（PLAN 二.10）。

| 绑定/变量 | 类型 | 说明 |
|---|---|---|
| `DB` | D1 | 主库 |
| `FILES` | R2 | 私有文件桶 |
| `AI_OFFICE_*` Workflow | workflows | 各业务 Workflow 绑定 |
| `crons` | 触发器 | `* * * * *`（每分钟恢复器） |
| `ALLOWED_ORIGINS` | var | 写请求 Origin 白名单（逗号分隔） |
| `EMAIL_MODE` | var | `echo` / `resend` |
| `ENV_NAME` | var | local / staging / production |
| `AUTH_SECRET` | secret | 验证码 HMAC 与会话令牌哈希密钥 |
| `CLOUDFLARE_API_TOKEN` | secret | 调 AI Gateway REST 用（含 Workers AI 运行权限） |
| `CLOUDFLARE_ACCOUNT_ID`、`AI_GATEWAY_ID` | var | Gateway 定位 |
| `ADMIN_TOKEN` | secret | 运维管理员访问 `/admin/*` |
| `RESEND_API_KEY` | secret | 启用 Resend 时配置 |

本地用 `.dev.vars`（已 gitignore），提交 `.dev.vars.example` 模板。`.env` 类文件一律不入库。

---

## 4. 横切机制设计

### 4.1 统一响应与错误码

```ts
// 成功
type ApiSuccess<T> = { data: T; requestId: string };
// 失败
type ApiFailure = { error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> }; requestId: string };
```

- `requestId`：中间件生成（`crypto.randomUUID()`），写入响应头 `X-Request-Id`，与错误日志关联。
- 所有 handler 抛 `AppError(code, message, httpStatus, retryable, details?)`，由集中错误处理映射为 `ApiFailure`；未捕获异常 → `INTERNAL(500, retryable=false)` 并记录日志。
- 错误码目录（前端据此分流）：

| code | HTTP | retryable | 场景 |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | false | Zod 校验失败，details 携带字段错误 |
| `UNAUTHENTICATED` | 401 | false | 未登录/会话失效 |
| `AUTH_CHALLENGE_INVALID` | 400 | false | 验证码错误 |
| `AUTH_CHALLENGE_EXPIRED` | 410 | false | 验证码过期 |
| `AUTH_ATTEMPTS_EXCEEDED` | 429 | false | 尝试超 5 次 |
| `RATE_LIMITED` | 429 | true | 发送间隔/IP 限流 |
| `PERMISSION_DENIED` | 403 | false | 非成员/角色不足 |
| `NOT_FOUND` | 404 | false | 资源不存在或不属于当前项目 |
| `VERSION_CONFLICT` | 409 | false | `expectedRevision` 不匹配，details 返回服务器当前 revision |
| `IDEMPOTENCY_CONFLICT` | 409 | false | 同键不同请求体 |
| `INVALID_STATE` | 409 | false | 终态改写、重复确认等状态机违规 |
| `FILE_TOO_LARGE` | 413 | false | 超过 10 MiB |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | false | MIME/扩展名/文件头不匹配 |
| `SOURCE_PARSE_FAILED` | 422 | true | 加密 PDF、缺页、解析失败（显式报错） |
| `PAGE_INVALID` | 400 | false | 非法页码/不属于该来源版本 |
| `QUOTA_EXCEEDED` | 429 | true | 项目 AI 并发 ≥2 或项目预算不足 |
| `AI_OUTPUT_INVALID` | 502 | false | 模型输出修复一次后仍不合法 |
| `AI_UNAVAILABLE` | 503 | true | Gateway/模型超时不可用（费用未知时保留待核对记录） |
| `EMAIL_UNAVAILABLE` | 503 | true | 验证码邮件发送失败（适配器故障/未配置） |
| `INTERNAL` | 500 | false | 未分类错误 |

### 4.2 登录（验证码）与会话

- 发起：`POST /auth/challenges`。生成 6 位随机数字验证码，**不存明文**：`code_hmac = HMAC-SHA256(AUTH_SECRET, email|challengeId|code)` 入 `auth_challenges`；10 分钟有效；单邮箱 60 秒发送间隔，叠加每邮箱/每小时与每 IP 限制（D1 计数实现）。
- 校验：`POST /auth/sessions`。先条件更新 `UPDATE auth_challenges SET attempts=attempts+1 WHERE id=? AND email=? AND consumed_at IS NULL AND expires_at>? AND attempts<5`（`changes=0` 即失败），尝试次数用尽返回 `AUTH_ATTEMPTS_EXCEEDED`；HMAC 比对通过后**条件更新一次性消费**（`SET consumed_at=now WHERE id=? AND consumed_at IS NULL`），防止并发重复验证；用户不存在则即建。
- 会话：32 字节随机令牌放入 Cookie（`Secure; HttpOnly; SameSite=Lax; Path=/`），DB 仅存 `SHA-256` 哈希；默认 7 天，`DELETE /auth/session` 立即撤销；滑动续期不做（首版固定时长）。
- 写请求（非 GET/HEAD/OPTIONS）校验 `Origin` ∈ `ALLOWED_ORIGINS`；`ENV_NAME=local` 时放行 localhost。
- 每次请求经会话中间件还原用户；项目路由再查 `project_members`，**不信任前端传来的角色**。

### 4.3 权限矩阵

| 操作 | 负责人 owner | 成员 member | 运维管理员 |
|---|---|---|---|
| 管理成员（移除他人）、撤销邀请 | ✅ | ❌ | ❌ |
| 确认要求集 / 确认评分标准 / 归档项目 | ✅ | ❌ | ❌ |
| 编辑任务/材料/评论、使用 AI、采纳草稿 | ✅ | ✅ | ❌ |
| 全局模型配置 `/admin/ai-config`、能力探测 | ❌ | ❌ | ✅（`ADMIN_TOKEN` Bearer） |
| 移除自己 | ❌（负责人不可自移，须转让后退出） | ✅（`DELETE /members/me`） | ❌ |

成员被移除后：立即失去该项目全部资源访问（所有读取经成员关系检查，天然生效）；其历史贡献记录保留，署名不变。

### 4.4 乐观锁与幂等

- 可修改实体带 `revision`（自 1 起）。更新请求携带 `expectedRevision`，条件更新 `SET revision=revision+1 WHERE id=? AND revision=?`；`changes=0` → `409 VERSION_CONFLICT`（details 附服务器当前版本）。失败后不得继续产生成功事件（PLAN 二.7）。
- 关键 POST（创建项目、上传发起、采纳、发起解析/AI/预审、邀请接受）要求 `Idempotency-Key` 头：
  1. 以 `(key, user_id, operation)` 唯一约束插入 `idempotency_records`，含请求体规范化哈希；
  2. 同键同内容且已完成 → 回放原响应；处理中 → 返回处理中；同键不同内容 → `409 IDEMPOTENCY_CONFLICT`；
  3. 记录与业务写入尽量同事务（D1 `batch()`）；无法同事务时以「先占位后补结果」+ 定时清理半途记录兜底。
- 材料版本 + 当前指针 + 账本事件 + 幂等结果用 D1 `batch()` 原子保存。

### 4.5 分页

列表接口统一游标分页：`?cursor=&limit=`，默认 20、最大 100；响应 `{ items, nextCursor }`。游标为 `(created_at, id)` 组合的 base64 编码，保证稳定翻页。

### 4.6 异步任务与可靠派发

状态机：`queued → running → succeeded / failed / cancelled`，另有 `waiting_input`（等待补充页面图片/回答，**无持续运行的 Workflow**，PLAN 二.7）。

派发与恢复：

1. API 层在同一 D1 `batch()` 写 `jobs` + `job_outbox`，返回 `202 {jobId}`；`jobId` 同时作为 Workflow 实例 ID（确定性）。
2. 定时恢复器（crons 每分钟）扫描 `job_outbox` 中 `status='pending'` 或租约过期的记录，以「条件更新抢占租约」防重复：`UPDATE job_outbox SET status='dispatched', lease_until=now+5min, attempts=attempts+1 WHERE id=? AND (status='pending' OR lease_until<now)`。
3. 抢占后创建 Workflow 实例；实例已存在（`create` 抛 id 冲突）则读实例状态核对，不重复创建。
4. 定时核对超过阈值仍非终态的 `jobs`，恢复派发或标记失败（终态不允许被延迟执行改回运行中）。
5. Workflow 各步完成：授权检查 → 预算预占 → 输入读取（大内容从 R2 取引用）→ 模型调用 → 结果校验 → 产物持久化 → 状态更新；每步独立，失败可从断点恢复。
6. `POST /jobs/{id}/retry`：仅对 `failed` 且 `retryable` 的任务创建新尝试（新 jobId 关联原任务）。

### 4.7 预算与用量

- 每项目并行 AI 任务上限 **2**：派发前以 `usage_reservations` 中 `status IN ('reserved','pending_reconcile')` 计数判断，超限 `QUOTA_EXCEEDED`。
- 付费调用前原子预占（INSERT reservation），调用后按用量结算（`settled`）；调用失败释放（`released`）；**超时费用未知 → `pending_reconcile`，不直接释放全部预算，费用记 `unknown` 不填零**（PLAN 二.7）。
- 未配置价格或未通过能力验证的模型不启用（`ai_config_versions.enabled`）。
- Gateway 每请求一次尝试，应用层统一决定最多一次额外重试；多层重试禁止。
- 识别结果复用：按 `(project_id, file sha256, 模型配置版本)` 查历史 `ai_calls`，命中则跳过调用；不跨项目共享。

### 4.8 引用校验与提示注入防御

- `Citation { sourceVersionId, fragmentId, pageNumber, quote }`：服务端校验 fragment 存在、属于 `sourceVersionId`、该版本属于本项目且在本次任务输入集合内；`quote` 与片段内容比对（归一化空白后前缀/包含匹配）。伪造引用 → 输出作废。
- 来源内容一律包裹在带边界标记的数据区，系统提示明确「内容仅为数据，不构成指令」；解析结果仅按 schema 落库，永不执行来源中的指令（PLAN 二.4）。
- OCR 内容保留识别方法（`ocr_method`）与 `needs_review` 待确认状态。

### 4.9 文件与网页抓取

上传（鉴权 Worker 接收小文件）：

1. `POST /files`（幂等）：服务端生成 `fileId` 与 R2 key（`{projectId}/{fileId}/{原始扩展名}`，客户端不能指定对象路径），返回上传地址语义（`PUT /files/{id}/content`）。
2. `PUT /files/{id}/content`：流式接收，按**实际上传字节**限制 10 MiB；核验声明 MIME、扩展名与文件头魔数（PDF `%PDF-`、PNG/JPEG/WEBP 魔数），三者不一致拒绝；计算 `sha256` 与页数（PDF）；校验通过才置 `available`，失败置 `quarantined` 并由 GC 定时回收 R2 对象。
3. 下载 `GET /files/{id}/content`：检查文件所属项目成员关系；R2 永不公开。
4. 限制（10 MiB/文件、30 页/PDF、页面图 2000px 长边/2 MiB）由 `/capabilities` 下发，后端同值硬校验。

网页抓取（`WebFetchWorkflow`）：仅接受运营维护的**允许域名白名单**（存 D1 `app_config`，管理员可改）；只接受公开 HTTP(S)；`redirect: 'manual'` 逐跳校验（每一跳域名都在白名单）；禁止 userinfo、非 80/443 端口、字面量内网地址；响应流大小上限 5 MiB、总超时 15s；不携带用户 Cookie。不支持的页面保存链接并标记「需改用文件/文字导入」。

---

## 5. 数据库设计

约定：主键 `TEXT id`（UUID）；时间戳 `TEXT` ISO-8601 UTC；纯日期 `TEXT 'YYYY-MM-DD'` 并保留 `*_precision`（`date`/`datetime`/`unknown`）与 `*_tz_note`，不自动补时刻；`revision INTEGER`；JSON 以 TEXT 存储（读侧 Zod 解析）；项目业务表一律含 `project_id`。

### 5.1 身份

- `users(id, email UNIQUE, display_name, created_at, last_login_at)`
- `auth_challenges(id, email, code_hmac, attempts, ip, requested_at, expires_at, consumed_at)`；INDEX(email, requested_at)
- `sessions(id, user_id, token_hash UNIQUE, expires_at, revoked_at, last_seen_at, created_at)`

### 5.2 项目

- `projects(id, name, description, competition_deadline_date, deadline_precision, status('active'|'archived'), revision, created_by, created_at, updated_at)`
- `project_members(id, project_id, user_id, role('owner'|'member'), skills_json, hours_per_week, joined_at)`；**UNIQUE(project_id, user_id)**
- `invitations(id, project_id, code_hash, created_by, expires_at, max_uses, used_count, revoked_at, created_at)`

邀请接受（`POST /invitations/accept`）原子流程：条件更新 `used_count=used_count+1 WHERE id=? AND revoked_at IS NULL AND expires_at>now AND used_count<max_uses`（`changes=0` → 失效/超限），再检查项目人数规则（本赛模板 5 人，作为项目配置字段 `team_size_limit` 保存，不硬编码为所有项目限制）后插入成员；同一 `batch()` 完成。

### 5.3 来源

- `files(id, project_id, uploader_user_id, r2_key, mime_declared, mime_detected, ext, size_bytes, sha256, page_count, status('pending'|'available'|'quarantined'), gc_after, created_at)`；INDEX(project_id, sha256)
- `sources(id, project_id, kind('file'|'web'|'paste'), title, url, current_version_id, created_by, created_at, updated_at)`
- `source_versions(id, source_id, project_id, revision, origin, file_id, url, text_r2_key, char_count, page_count, status('pending'|'processing'|'ready'|'failed'), parse_error, created_at)`
- `source_pages(id, source_version_id, project_id, page_number, text_status('none'|'extracted'|'empty'), image_file_id, image_status('none'|'uploaded'|'rejected'), ocr_status('none'|'pending'|'ok'|'failed'), ocr_method, ocr_confidence, needs_review, updated_at)`；**UNIQUE(source_version_id, page_number)**
- `source_fragments(id, source_version_id, project_id, page_number, seq, kind('text'|'ocr'|'web'|'paste'), content)`；**UNIQUE(source_version_id, seq)**；INDEX(source_version_id, page_number)

大文本（提取的整册文本）存 R2（`text_r2_key`），DB 只存引用与计数；片段逐条入库支撑引用定位。

### 5.4 要求与评分

- `requirement_sets(id, project_id, source_version_id, status('draft'|'confirmed'), revision, confirmed_by, confirmed_at, created_at, updated_at)`
- `requirements(id, requirement_set_id, project_id, seq, category('deadline'|'deliverable'|'format'|'scoring'|'team'|'other'), title, detail, due_date, due_precision, citations_json, field_state('ai_suggestion'|'edited'|'confirmed'), updated_at)`
- `rubric_versions(id, project_id, version, source('official'|'custom'), weights_json, notes, status('draft'|'confirmed'), confirmed_by, confirmed_at, created_at)`

重新解析生成新 `requirement_set` 草稿并与旧结果做差异对比，不覆盖已确认内容（PLAN 一.3）。本赛事评分权重 20/25/20/25/10 作为该项目的 rubric 版本数据保存，标注 `source='official'` 且注明非官方模拟展示；自拟细则存 `notes` 并显式标注。

### 5.5 任务与材料

- `tasks(id, project_id, title, detail, assignee_id, due_date, due_precision, status('todo'|'doing'|'blocked'|'done'), requirement_id, revision, created_by, created_at, updated_at)`
- `task_links(id, task_id, project_id, kind('requirement'|'material'|'source_version'|'file'), target_id, created_at)`；UNIQUE(task_id, kind, target_id)
- `comments(id, project_id, target_type, target_id, author_id, body, created_at)`；INDEX(target_type, target_id)
- `materials(id, project_id, title, kind, current_version_id, revision, created_by, created_at, updated_at)`
- `material_versions(id, material_id, project_id, revision, doc_json, markdown, origin('manual'|'ai_adoption'), ai_run_id, author_id, created_at)`；**UNIQUE(material_id, revision)**；历史版本不可变

### 5.6 AI

- `agent_sessions(id, project_id, capability('do'|'guide'|'review_only'), title, task_id, status('active'|'closed'), created_by, created_at, updated_at)`
- `agent_turns(id, session_id, project_id, sequence, role('user'|'assistant'), kind('instruction'|'answer'|'draft'|'question'|'review_result'), run_id, payload_json, created_at)`；**UNIQUE(session_id, sequence)**
- `agent_runs`（**内部新增表**，支撑 `/agent-runs/{id}/adopt`，不改契约）：`(id, session_id, project_id, capability, job_id, mode, status('running'|'succeeded'|'failed'|'adopted'), inputs_json, output_json, prompt_version, ai_config_version_id, created_at, adopted_at, adoption_material_version_id)`

三档语义：`do` 生成可编辑草稿；`guide` 按步骤提问、结合回答逐步形成成果（每轮一个关联任务）；`review_only` 检查已有材料给问题/依据/建议。AI 永不直接改正式数据、不将任务标完成（PLAN 一.3）：产物只能经「采纳」成为新 `material_version`，采纳必须 `reviewed: true`。

### 5.7 预审答辩

- `reviews(id, project_id, requirement_set_id, rubric_version_id, material_version_ids_json, status, report_json, job_id, created_by, created_at)`
- `rehearsals(id, project_id, scope('all'|'member'), member_id, material_version_ids_json, status('active'|'finished'), created_by, created_at, finished_at)`
- `rehearsal_turns(id, rehearsal_id, project_id, sequence, kind('question'|'answer'|'followup'|'summary'), content_json, run_id, created_at)`；**UNIQUE(rehearsal_id, sequence)**

预审报告绑定具体材料版本；材料更新后前端据 `material_version_ids` 提示「报告针对旧版本」。

### 5.8 证据（过程账本）

- `events(id, project_id, actor_type('user'|'ai'|'system'), actor_id, type, entity_type, entity_id, dedup_key, payload_json, occurred_at)`；**UNIQUE(project_id, type, entity_type, entity_id, dedup_key)**（账本去重，PLAN 二.2）
- `decisions(id, project_id, title, detail, made_by, decided_at, related_json, created_at)`
- `contributions(id, project_id, user_id, kind, description, evidence_json, created_at, updated_at)`（更正走 `POST /contributions/{id}/corrections`，保留原记录）
- `resource_references(id, project_id, kind('url'|'file'|'model'|'other'), title, url, file_id, meta_json, declared_by, created_at)`

### 5.9 基础设施

- `jobs(id, project_id, kind, status, input_json, input_r2_key, result_json, error_json, attempts, lease_until, created_by, created_at, updated_at, finished_at)`；INDEX(status, lease_until)；INDEX(project_id, created_at)
  - `kind`：`parse_source` / `ocr_pages` / `requirement_extract` / `assignment_suggest` / `agent_run` / `review_run` / `rehearsal_turn` / `web_fetch` / `gc`
- `job_outbox(id, job_id UNIQUE, status('pending'|'dispatched'|'done'|'failed'), available_at, lease_until, attempts, last_error, created_at, updated_at)`
- `idempotency_records(idempotency_key, user_id, operation, request_hash, status('processing'|'completed'), response_status, response_body, created_at)`；**UNIQUE(idempotency_key, user_id, operation)**
- `ai_config_versions(id, version, config_json, enabled, notes, created_by, created_at)` — `config_json` 结构：

```jsonc
{
  "textEconomy":   { "provider": "workers-ai", "model": "...", "timeoutMs": 60000,
                     "maxInputChars": 0, "maxOutputTokens": 0, "supportsJson": true, "supportsVision": false, "pricePer1kInOut": [0, 0] },
  "visionEconomy": { "provider": "workers-ai", "model": "...", "...": "同上，supportsVision=true" },
  "review":        { "provider": "workers-ai", "model": "..." }
}
```

- `ai_calls(id, project_id, job_id, run_id, purpose('textEconomy'|'visionEconomy'|'review'), config_version_id, prompt_version, model, input_r2_key, output_r2_key, prompt_tokens, completion_tokens, cost_usd(可空=未知), cost_status('known'|'unknown'), status('ok'|'repaired'|'invalid'|'failed'|'timeout'), latency_ms, created_at)`
- `usage_reservations(id, project_id, job_id, purpose, estimated_cost, status('reserved'|'settled'|'released'|'pending_reconcile'), settled_cost, created_at, settled_at)`；INDEX(project_id, status)
- `app_config(key PRIMARY KEY, value_json, updated_at)`：网页白名单、团队人数模板等运营配置。

### 5.10 迁移策略

`wrangler d1 migrations`；迁移文件只增不改（向后兼容的新增方式），先在 staging 执行验证；代码回滚不自动执行破坏性数据库降级（PLAN 二.10）。生产迁移前保留可恢复备份（`wrangler d1 export`）。

---

## 6. AI 接入

### 6.1 Gateway 调用

- 统一 REST：`POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions`，头 `Authorization: Bearer {CLOUDFLARE_API_TOKEN}` + `cf-aig-gateway-id: {AI_GATEWAY_ID}`。当前阶段模型为 Workers AI 系列（provider `workers-ai`，经 Gateway）；后续 GLM/Gemini 等以 OpenAI 兼容 provider 接入同一 Gateway，仅改 `ai_config_versions`。
- Gateway 默认关闭完整请求响应日志与响应缓存；业务记录由本系统按权限保存（`ai_calls` + R2）。
- 调用输入/输出快照、提示词版本、配置版本、用量、费用、时延全部落 `ai_calls`（大内容存 R2 传引用）。

### 6.2 能力探测（模型启用前置条件）

`scripts/probe-model`（受 `ADMIN_TOKEN` 保护的 `POST /admin/ai-config/probe` + 本地脚本两种形态）对候选配置执行：中文短文生成、中文截图识别（固定测试图 fixture）、JSON Schema 约束输出、用量字段完整性检查。四项全过才允许 `enabled=1`；不支持结构化约束的模型降级为「JSON 提示 + Zod 校验」并记录。探测结果与失败原因写入 `ai_config_versions.notes`。**不自动切换到更贵模型**。

### 6.3 输出校验与修复

1. 模型原始输出 → 提取 JSON → Zod schema 校验（该能力专用 schema）；
2. 校验失败 → 一次格式修复调用（附加错误说明重问）；再失败 → 任务失败 `AI_OUTPUT_INVALID`，`ai_calls.status='invalid'`（修复调用计费如实记录）；
3. 业务复核：引用校验（4.8）、分数范围（预审 0–100、权重 20/25/20/25/10 或该 rubric 实际权重）、项目归属、日期精度（缺时刻不补造）；
4. 通过后产物持久化并更新任务状态（终态不可逆）。

### 6.4 上下文策略

显式关联资料（任务、指定来源版本与材料版本），不引入向量检索；输入超模型预算时任务失败并提示缩小输入范围，**不静默丢弃关键要求**（PLAN 二.6）。

---

## 7. Agent 七项能力规格

每项固定业务流程，模型不直接改正式数据；输入快照 + 输出 + 引用校验全落库。

| 能力 | 触发 | 输入 | 输出（Zod schema） | 落库 |
|---|---|---|---|---|
| 通知解析 | `POST /sources/{id}/parse` → job `requirement_extract` | 来源片段（文本层优先，OCR 补充） | 要求/日期/材料/评分条目 + Citation[] | 新 `requirement_sets` 草稿 + `requirements` |
| 分工建议 | `POST /assignment-suggestions` → job | 已确认要求、成员技能/投入、现有任务 | 建议（成员×任务映射）+ 缺口说明 | 建议记录（供 `apply-assignment` 人工应用） |
| 代做 do | `POST /agent-sessions`(mode=do) → job | 任务、指定来源与材料版本 | Tiptap 草稿 JSON | `agent_runs` + 草稿待采纳 |
| 带做 guide | 每轮 `POST /agent-sessions/{id}/turns` → job | 步骤、已有回答、项目上下文 | 下一问题 或 阶段草稿 | `agent_turns`（UNIQUE(session_id, sequence)） |
| 只审 review_only | `POST /agent-sessions`(mode=review_only) → job | 已有材料版本与要求 | 问题 + 依据 + 建议 | `agent_runs` |
| 预审 | `POST /reviews`（冻结请求#3）→ job | 材料版本 + 评分版本 + 要求集 | 分项结论 + 模拟分数 + 修改建议 | `reviews.report_json` |
| 答辩 | `POST /rehearsals`、`/rehearsals/{id}/answers` → job（每轮一个） | 材料、成员任务、决策记录 | 问题/追问/反馈/总结 | `rehearsal_turns` |

提示词模板集中管理于 `src/ai/prompts/`，每模板带版本号常量；模板变更 = 新版本号 + 存量任务不受影响（任务固定使用创建时的配置与提示词版本）。

---

## 8. API 清单（/api/v1，对齐 PLAN 二.8）

通用：鉴权除 `auth/*`、`capabilities`、`health` 外全部需要会话；项目资源统一置于 `/projects/{projectId}` 下；写请求带 `Origin` 校验；标注 🔒 的需 owner，标注 ⚙️ 的需 ADMIN_TOKEN；标注 ⟳ 的返回 `202 + jobId`。

| 域 | 端点 | 说明 |
|---|---|---|
| 系统 | `GET /health`、`GET /health/deps`、`GET /capabilities` | 存活/依赖检查不触发付费调用；capabilities 返回限制与 AI 开关 |
| 登录 | `POST /auth/challenges`、`POST /auth/sessions`、`GET /auth/session`、`DELETE /auth/session` | 验证码；回显模式仅非生产返回 `devCode` |
| 项目 | `GET/POST /projects`、`GET/PATCH /projects/{projectId}` | PATCH 归档需 🔒；均支持 expectedRevision/幂等 |
| 成员 | `GET /projects/{id}/members`、`GET/PATCH /projects/{id}/members/me`、`DELETE /projects/{id}/members/{userId}`🔒、`DELETE /projects/{id}/members/me` | PATCH me 维护技能/投入时间（供分工建议） |
| 邀请 | `POST/GET /projects/{id}/invitations`🔒、`DELETE /projects/{id}/invitations/{iid}`🔒、`POST /invitations/accept`（全局） | 接受为原子操作（5.2） |
| 文件 | `POST /projects/{id}/files`、`PUT/GET /files/{id}/content` | 校验与 GC 见 4.9 |
| 来源 | `POST/GET /projects/{id}/sources`、`GET /projects/{id}/sources/{sid}/versions[/{vid}]`、`POST /projects/{id}/sources/{sid}/parse`⟳ | |
| 页面处理 | `GET /projects/{id}/sources/{sid}/render-requests`、`POST /projects/{id}/sources/{sid}/page-images`⟳ | 前端 PDF.js 渲染上传，绑定 `sourceVersionId+pageNumber` |
| 要求评分 | `GET/POST /projects/{id}/requirement-sets`、`GET/PATCH /projects/{id}/requirement-sets/{rsid}`、`POST /projects/{id}/requirement-sets/{rsid}/confirm`🔒、`GET/POST/PATCH/confirm /projects/{id}/rubrics[...]` | confirm 幂等，重复确认 `INVALID_STATE` |
| 分工任务 | `POST /projects/{id}/assignment-suggestions`⟳、`POST /projects/{id}/tasks/apply-assignment`、`GET/POST /projects/{id}/tasks`、`GET/PATCH /projects/{id}/tasks/{tid}`、`GET/POST /projects/{id}/comments` | |
| 材料 | `GET/POST /projects/{id}/materials`、`GET /projects/{id}/materials/{mid}/versions[/{vid}]` | 版本经采纳/保存创建 |
| 补位 | `POST/GET /projects/{id}/agent-sessions`、`GET /projects/{id}/agent-sessions/{asid}`（含 turns）、`POST /projects/{id}/agent-sessions/{asid}/turns`⟳、`POST /projects/{id}/agent-runs/{arid}/adopt` | 创建会话请求 = 冻结写请求#1；采纳 = 冻结#2 |
| 异步 | `GET /jobs/{id}`、`POST /jobs/{id}/retry` | 轮询契约见 PLAN 一.7（2s→10s 退避） |
| 预审答辩 | `POST/GET /projects/{id}/reviews`、`GET /projects/{id}/reviews/{rid}`、`POST/GET /projects/{id}/rehearsals`、`GET /projects/{id}/rehearsals/{hid}`、`POST /projects/{id}/rehearsals/{hid}/answers`⟳、`POST /projects/{id}/rehearsals/{hid}/finish`⟳ | 发起预审 = 冻结写请求#3 |
| 过程记录 | `GET /projects/{id}/events`、`GET/POST /projects/{id}/decisions`、`GET/POST /projects/{id}/contributions`、`POST /projects/{id}/contributions/{cid}/corrections`、`GET/POST /projects/{id}/resources` | |
| 导出 | `GET /projects/{id}/export-bundle` | JSON 汇总（材料 Markdown + 账本 + 声明），首版同步返回 |
| 管理 | `GET/PUT /admin/ai-config`⚙️、`POST /admin/ai-config/probe`⚙️、`GET/PUT /admin/app-config`⚙️ | |

三个冻结写请求的请求体严格按 PLAN 二.8：补位 `{mode, roleTemplate, taskId, instruction, materialVersionIds, sourceVersionIds}`；采纳 `{materialId, expectedRevision, reviewed: true, doc(Tiptap 节点集合)}`；预审 `{rubricVersionId, requirementSetId, materialVersionIds}`。后端不接受前端传入任意模型地址、供应商密钥或系统提示词。

---

## 9. 测试计划

框架：Vitest + `@cloudflare/vitest-pool-workers`（真实 D1/R2/Workflows 语义）；Gateway 调用以可注入 fetch mock 覆盖异常路径。每个里程碑随代码交付测试。

PLAN 二.9「必须覆盖」→ 测试映射：

| 场景 | 测试方式 |
|---|---|
| 并发保存 | 两请求同 `expectedRevision` 并发提交，恰一成功一 `VERSION_CONFLICT` |
| 重复采纳 | 同一 run 采纳两次，第二次 `INVALID_STATE`；同 `Idempotency-Key` 则回放 |
| 任务派发中断及恢复 | 构造 outbox 租约过期，恢复器重派且不重复创建实例；终态不可被改回 |
| 成员移除后访问 | 附件/任务结果/导出全部 403 |
| 超限上传/伪造 MIME/加密 PDF/非法页码/网页重定向 | 文件校验与 WebFetch 单测表驱动覆盖 |
| 中文截图/表格/旋转页/扫描混合 PDF | 探测脚本 fixture + 解析流水线集成测试（mock 视觉模型输出） |
| AI 无效 JSON/伪造引用/超时/预算竞争 | mock 输出用例集；并发预占断言并发≤2、未知费用标 unknown |
| 赛道规则隔离 | 团队人数与评分权重为项目级数据，非本项目模板不生效 |

---

## 10. 部署与运维

### 10.1 资源创建清单（负责人在本地执行，脚本见 `scripts/`）

```bash
wrangler login
# staging（production 同理替换后缀）
wrangler d1 create ai-office-db-staging
wrangler r2 bucket create ai-office-files-staging
# AI Gateway：dashboard → AI → AI Gateway 创建，记下 gateway id
# API Token（dashboard 创建，权限：Workers AI Run、AI Gateway Write）→ 作为 CLOUDFLARE_API_TOKEN secret
wrangler d1 migrations apply ai-office-db-staging --remote
wrangler secret put AUTH_SECRET --env staging          # 依此类推
wrangler deploy --env staging
```

健康检查：`GET /health`（存活）与 `GET /health/deps`（D1 一查、R2 头校验），**不触发付费模型调用**。

### 10.2 监控与恢复

- 关注指标：错误率、任务失败率、排队时间、模型时延、识别失败页数、各项目预算水位（PLAN 二.10）。
- 备份：生产迁移前 `wrangler d1 export`；恢复操作写入 `docs/OPERATIONS.md`。
- 交付物（对齐 PLAN 二.10）：源码、迁移、`openapi.json`、`wrangler.jsonc` 配置模板、`.dev.vars.example`、`docs/DEPLOY.md`、能力探测脚本、测试报告、`docs/OPERATIONS.md`。

---

## 11. 里程碑（核心纵切优先）

> 对应 PLAN 二.9 的 B0–B5 验收标准全部保留，仅顺序按纵切调整；目标日期以 2026-09-29 起算，10/8 为比赛材料截止。

| 里程碑 | 对应 | 内容 | 验收 | 目标 |
|---|---|---|---|---|
| **M0 脚手架** | — | backend/ 工程初始化（Hono+TS+Vitest 可跑）、统一响应/requestId/错误处理、`/health`、`/capabilities`、OpenAPI 骨架与导出、根 .gitignore、本文档 | `npm test` 通过；`wrangler dev` 可启动；openapi.json 生成 | 9/30 |
| **M1 基础设施** | B0' | D1 核心迁移（身份/项目/文件/来源/infra 表）、R2 上传下载与文件校验、Gateway 客户端 + Workers AI 能力探测、ai_config 种子、**unpdf 免费 CPU spike**、资源创建清单交付负责人 | 真实上传下载成功；真实 Workers AI 调用落 ai_calls；spike 结论定案（13.1）；能力和费用记录完整 | 10/1 |
| **M2 身份项目** | B1 | 验证码全套（回显模式）、会话、项目/成员/邀请、权限与 Origin 中间件 | 两个账户可协作，第三者不能越权（对齐 B1 验收） | 10/2 |
| **M3 来源解析** | B2 | 来源版本、文本提取（按 spike 结论）、render-requests/page-images、视觉 OCR、片段化、要求提取+引用校验、要求集确认与 rubrics | 本次比赛 PDF 生成正确要求且引用可跳转（对齐 B2 验收） | 10/4 |
| **M4 任务材料 AI** | B3 | 任务/评论/材料版本、三档 agent_sessions/turns/runs、采纳、事件账本、幂等/乐观锁/预算预占/并发 2 | 任务→AI→采纳→材料版本→事件闭环可追溯；并发与重复采纳测试通过 | 10/6 |
| **M5 预审答辩账本** | B4 | reviews、rehearsals（逐题/追问/总结）、contributions+corrections、resources、export-bundle | 预审答辩输出关联明确输入版本（对齐 B4 验收） | 10/8 |
| **M6 加固联调** | B5 | 恢复器与长期非终态核对完善、预算并发压测、staging/production 部署与迁移流程、Service Binding 联调、监控与文档收尾 | 真实前端端到端验证通过（对齐 B5 验收）；交付 10.2 全部交付物 | 10/8 后 |

---

## 12. 风险登记与降级路径

### 12.1 免费版 CPU 限制 vs unpdf（最高风险）

Workers 免费版每次请求约 10ms CPU；`unpdf` 解析多页 PDF 的纯 JS 计算大概率超限。M1 用真实 30 页中文 PDF 实测（本地 miniflare 计时 + 部署到免费计划实测）后定案，降级路径按序：

1. **Workflow 分步分页处理**：按 1–2 页拆步，每步独立 CPU 预算；`getDocument` 一次解析结构、逐页 `getTextContent` 分步执行（成本仍可能集中，需实测）。
2. **前端提取文本层**：前端本就集成 PDF.js，改为前端提取文本+渲染页面图一并上传，后端只做校验、片段化与建模；此路径需与前端 AI 协商契约微调（来源解析接口入参增加文本层内容），经组长双方确认后执行。
3. **开通 Workers Paid（$5/月）**：CPU 上限提升至 30s，一劳永逸；由组长决策。

### 12.2 其他风险

| 风险 | 缓解 |
|---|---|
| Workflows 免费版配额/并发未实测 | M1 spike 记录实际配额；必要时减少 Workflow 种类，用「API 内小任务 + 单一 Workflow 类」收敛 |
| Resend 域名未定 | EchoProvider 先行；`EmailProvider` 接口稳定，接入 Resend 仅新增实现与配置 |
| 模型 Key 未到位 | Workers AI 兜底；探测脚本就绪，Key 到位后配置即启用 |
| 免费版 D1 写限额（10 万行/日） | 写入集中在业务事件与片段；分页/幂等写入量可控，监控余量 |
| 上传体 10 MiB 与 Worker 内存 | 流式读取 + 实际字节计数 + 即时落 R2，不整册驻留内存 |
| 前后端联调窗口紧张 | M0 起即提交 openapi.json，前端可全程用 MSW 并行开发 |

---

## 13. 完成状态记录（随进度更新）

- [x] M0 脚手架（2026-09-29，commit 2cab0cd：Hono+Zod/OpenAPI+Vitest、统一响应/requestId/错误目录、health、capabilities、openapi.json 导出，7 用例）
- [x] M1 基础设施（2026-09-29，commit 6da3984：D1 全量迁移+种子、R2 文件上传下载与魔数校验/隔离回收、会话与成员中间件、AI Gateway 客户端+ai_calls 记录（费用未知标未知）、admin 配置版本化+能力探测、unpdf spike（30 页约 6–8ms，见 backend/docs/SPIKE-unpdf.md）、DEPLOY.md，13 用例）
- [x] M2 身份项目（2026-09-29：验证码 HMAC 全流程（回显模式/60s 间隔/IP 限流/一次性消费）、会话 Cookie、项目 CRUD+乐观锁+归档、成员权限矩阵（owner 不可自移/退出）、邀请生命周期（次数/撤销/过期/人数规则）、Origin 白名单，16 用例；共 36 用例全绿）
- [x] M3 来源解析（2026-09-29：来源导入（文件/粘贴/网页）与版本、ParseSourceWorkflow（确定性实例 ID=jobId）+ outbox/cron 恢复器、unpdf 按页提取与片段化、扫描页 render-requests/页面图上传/视觉 OCR（待复核标记）、要求提取（JSON+一次修复+伪造引用拒绝→AI_OUTPUT_INVALID）、要求集编辑/owner 确认、评分标准版本 CRUD/确认、网页白名单抓取、jobs 查询与 retry，9 用例）
- [x] M4 任务材料 AI（2026-09-29，commit b01cee4：任务/评论、材料版本+乐观锁（batch 原子+孤儿补偿）、Markdown↔Tiptap 纯函数转换、三档 AI 补位（代做/带做/只审，统一 JSON+一次修复+引文核验）、采纳（冻结#2，reviewed 强制、batch 原子、重复采纳 409）、事件账本（去重写入）、Idempotency-Key 幂等（回放/冲突/处理中）、预算并发预占（每项目 2+cron 释放），12 用例）
- [x] M5 预审答辩账本（2026-09-29：预审（冻结#3，分数覆盖全部维度校验）、答辩演练（首问/逐题/追问/总结，反馈不做个人排名）、事件流查询、决策/贡献+更正链（迁移 0003）/资源声明、export-bundle 汇总（AI 用量费用未知如实标注），3 用例；共 60 用例全绿，契约 55 路径）
- [ ] M6 加固联调（长期非终态任务核对细化、压测、staging/production 部署、Service Binding 真实联调、监控）
- [ ] 真实联调完成（后方可标「可试用 MVP」）
- [ ] 比赛材料完成
