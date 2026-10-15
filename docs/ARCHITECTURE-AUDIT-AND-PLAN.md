# 「补位」AI 项目办公室 —— 结构性架构审计与渐进式重构计划（终版共识稿）

> **文档状态**：经 Gemini 初审/复核与 GPT 交叉核验后的终版共识报告与可执行演进计划  
> **审计范围**：`backend/`、`frontend/`、`desktop/`、`packages/`、`shared/`、`scripts/`（基于当前 `main` 分支）  
> **核心原则**：**区分“业务安全不变量（Security & Reliability Invariants）”与“实现层面的高复杂度（Implementation Complexity）”**。任何结构简化、性能优化或代码收敛，均以不削弱多用户权限隔离、防重复计费、原子并发控制与离线数据安全为前提。

---

## 一、 总体判断与交叉核验共识

经过两轮静态代码取证与交叉核验，双方对本项目工程现状达成以下核心共识：

1. **项目并非“架构错误”，而是“防御性补丁叠加导致的实现高熵”**：
   - 项目围绕多租户隔离、协作权限撤销、外部付费 AI 调用防重放、网络中断恢复及存储配额硬闸，构建了严密的防御体系。这些防御机制背后均有真实的业务与成本保护动机（例如 Cloudflare Workflows 设为单步且 `retries: { limit: 0 }`，是为了防止付费模型请求在响应丢失时被平台自动重放而产生双倍计费）。
   - 核心技术债在于：**基础设施与业务模型存在多处平行重复实现、跨表状态协调缺乏统一封装、部分数据库触发器与前端缓存机制产生了不必要的读写放大，以及大量核心源码被写成数千字符一行的“单行压缩体”**。
2. **明确区分三类结论的边界**：
   - **已证实的代码事实（可直接治理）**：`task_readiness` 触发器的全项目写放大、前端 `replaceLocalIds()` 的全文字符串替换隐患、`secrets.ts` 的 `String.fromCharCode(...iv, ...bytes)` 栈溢出隐患与三套重复检查点分块协议、前端 `offline-snapshot-updated` 触发的全局无差别 `invalidateQueries()`、以及多处 1,500～3,700 字符的单行压缩代码。
   - **合理的架构耦合痛点（需渐进收敛，不可莽撞删除）**：R2 存储桶通过 `storageOwner()` 反推归属（12 处 `FILES.put` 调用点中仅 `ai/calls.ts` 显式传入 `owner`）、三套 AI 状态表（`usage_reservations` / `ai_resource_dispatches` / `ai_executions`）的跨表互查、正式项目文件与创建草稿文件的两套分片上传/解析实现、以及巨型拼接 SQL Guard。
   - **尚需生产或专项数据量化的推断（先测量后决策）**：除已由本地合成基准（`docs/verification/resource-audit-benchmark.json`、`backend/scripts/d1-read-benchmark.md`）证实的特定查询外，复杂 AI Guard 与 R2 计数器触发器在实际生产流量下的 D1 读写行占比，需采集真实 `meta.rows_read` / `meta.rows_written` 后再决定取舍。

---

## 二、 核心问题清单与核验定性总表

| 编号 | 模块领域 | 问题描述 | 核心代码定位 | 核验定性 | 风险与改造边界 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **F-01** | 数据库触发器与写放大 | 单任务 `status` 或 `assignee_id` 更新时，触发器重算并更新**全项目所有任务**的 `task_readiness`；若叠加 `readinessStatements()` 则翻倍（N 任务项目单次修改产生 N+1 至 2N+1 行更新） | `backend/migrations/0037_task_readiness.sql:21-48`<br>`backend/src/services/task-readiness.ts:3-9` | **已证实（高价值优化项）** | `backend/test/121-task-messaging.test.ts:47-61` 直接通过 `UPDATE tasks` 验证通知，**不可直接删除触发器通知**；应通过新迁移将触发器更新范围收敛至当前任务及其直接后继任务。 |
| **F-02** | 前端离线同步 | `replaceLocalIds()` 使用 `JSON.parse(JSON.stringify(row.body).replaceAll(from, to))` 全文替换本地临时 UUID，存在破坏用户正文与结构不严谨的风险 | `frontend/src/offline/queue.ts:108-115` | **已证实（数据完整性风险）** | 需按不同离线操作类型（任务、评论、提交、材料）显式映射引用 ID 字段，保留操作顺序与幂等键。 |
| **F-03** | 前端缓存与状态同步 | `api.get` 读取 IndexedDB 快照并在后台 `revalidate()`，数据变化时派发 `offline-snapshot-updated`，`main.tsx` 监听后执行无过滤条件的 `queryClient.invalidateQueries()` | `frontend/src/api/client.ts:84-108`<br>`frontend/src/main.tsx:37-40` | **已证实（状态刷新放大）** | 查询键之间存在业务依赖，改为定向失效时必须梳理 URL 到 `queryKey` 前缀的完整映射，防止出现陈旧视图。 |
| **F-04** | 加密工具与检查点复用 | `secrets.ts` 使用 `String.fromCharCode(...iv, ...bytes)` 存在大数组栈溢出风险；三处检查点各自重复实现了 16,000 字符切块与循环 `seal()` | `backend/src/ai/secrets.ts:29`<br>`backend/src/services/draft-preview-checkpoints.ts:74-82`<br>`backend/src/services/project-investigation.ts:35-52`<br>`backend/src/services/ai-checkpoints.ts:40-56` | **已证实（代码重复与隐患）** | 修复底层 Base64 编码并提取公共分块加解密辅助函数，但**必须保留现有 3 种 `format` 信封标识**以兼容存量 R2 数据。 |
| **F-05** | 源码可读性与格式 | 大量核心文件被压成超长单行（如 `TemplateDraftWorkspace.tsx` 单行 3,701 字符，`RecordingIntake.tsx` 3,665 字符，`collaboration.ts` 2,566 字符） | `frontend/src/pages/TemplateDraftWorkspace.tsx`<br>`frontend/src/features/recordings/RecordingIntake.tsx`<br>`backend/src/services/collaboration.ts` | **已证实（严重阻碍维护）** | 引入 Formatter 执行纯格式化，必须作为独立 Commit 提交并配置 `.git-blame-ignore-revs`。 |
| **F-06** | 后端 ETag 流式计算 | `snapshot-etag.ts` 使用 `response.clone().body.getReader()` 流式切片并用正则剥离末尾 `requestId`，存在 `Response.clone()` 双流缓冲内存开销 | `backend/src/core/snapshot-etag.ts:6-45`<br>`backend/src/core/api.ts:13-15` | **已证实（潜在内存开销）** | `apiData()` 目前是同步纯对象包装函数，不能简单塞入异步哈希；需单独设计响应辅助层并在大载荷接口先行基准测试。 |
| **F-07** | AI 状态机跨模块耦合 | `usage_reservations`（项目并发）、`ai_resource_dispatches`（日配额与全局并发）、`ai_executions`（轮次与代次）职责不同，但存在直接跨表读写对方状态的耦合 | `backend/src/services/ai-reservations.ts:110-120`<br>`backend/src/services/ai-execution-control.ts:51-61`<br>`backend/src/services/background-model-call.ts:8-33` | **已证实（结构耦合）** | **不可合并删除三类底层约束**；应构建统一的协调层（Execution Coordinator）收敛事务内的状态流转。 |
| **F-08** | R2 存储配额与归属反推 | 全局 `withManagedStorage` 代理保障了配额不漏记，但 12 个 `FILES.put` 文件中除 `ai/calls.ts` 外均未传 `owner`，依赖 `storageOwner()` 拆分 Key 查 8 张业务表反推；每次新对象写入最多触发 3～12 次计数器更新 | `backend/src/services/managed-storage.ts:14-128`<br>`backend/migrations/0072_resource_policy_storage.sql:25-74` | **已证实（反向依赖与写开销）** | **严禁绕过内部快照计量或删除全局兜底代理**；应逐步推广显式、经服务端校验的归属上下文，保留 `storageOwner()` 作为兜底。 |
| **F-09** | 双轨上传解析与创建工作区 | 正式文件（`file-multipart.ts` / `document-imports.ts`）与草稿文件（`draft-documents.ts`）维护了两套相似的分片租约与解析逻辑；前端 `CreateProjectPage.tsx` 与 `TemplateDraftWorkspace.tsx` 维护了两套草稿轮询与上传状态机 | `backend/src/services/file-multipart.ts`<br>`backend/src/services/draft-documents.ts`<br>`frontend/src/pages/CreateProjectPage.tsx`<br>`frontend/src/pages/TemplateDraftWorkspace.tsx` | **已证实（低层逻辑重复）** | 正式项目与未提交草稿的权限生命周期不同，**不宜强行合并数据库表**；应优先提取共享的流校验、分块摘要与前端 Controller Hook。 |
| **F-10** | 巨型拼接 SQL Guard | 在单条 `UPDATE/INSERT` 中拼接十余个跨表 `EXISTS` 子查询，保证了无锁原子性，但导致 SQL 极难阅读且 `changes === 0` 时难以定位具体失败原因 | `backend/src/services/collaboration.ts:133,178`<br>`backend/src/services/admin-ai-retries.ts:72-129` | **已证实（可维护性痛点）** | **严禁将原子 WHERE 守卫拆成非原子的“先 SELECT 后裸 UPDATE”（会引入 TOCTOU 竞态）**；应采用“前置只读诊断 + 写入语句保留紧凑原子断言”并优化 SQL 构造器。 |
| **F-11** | 前端目录与客户端重复 | `frontend/src/pages/` 平铺 236 个文件；`auth.ts` 的 `adminRequest()` 与 `client.ts` 重复；存在三套弹窗机制；`frontend/public/plugins/` 跟踪了两个版本的 `.tgz` | `frontend/src/pages/`<br>`frontend/src/auth.ts:33-64`<br>`frontend/src/dialogs/`<br>`frontend/public/plugins/` | **已证实（工程组织债）** | 属于长期整洁度演进，应在核心数据流与性能问题稳定后分批整理。 |

---

## 三、 必须坚守的架构安全不变量（Guardrails）

在执行下文任何阶段的重构时，实施者与审查者必须逐条核对以下不变量未被削弱：

1. **数据库写操作的 TOCTOU 免疫**：在 Cloudflare D1 无交互式跨请求事务的模型下，所有涉及权限、成员身份、项目状态（`active`）、来源生命周期（`lifecycle_version`）和实体修订号（`revision`）的变更，最终落库的 `UPDATE / INSERT ... SELECT ... WHERE` 或 `DB.batch()` **必须包含原子条件断言**。
2. **外部付费 AI 调用的防重放保护**：Workflows 保持 `retries: { limit: 0 }`；任何已发出但结果未知（`request_uncertain` / `pendingDispatch`）的付费模型请求，不得由后台定时任务自动重放，必须保留并发/配额占用直至人工核对或明确恢复。
3. **存储与 AI 配额的全覆盖硬闸**：所有 R2 写入（无论用户上传还是系统生成的 AI 调用快照、检查点）均须受控于配额账本；生产环境未完成存储盘点（`storage_inventory_state.ready = 1`）前拒绝新增写入。
4. **多账号与项目撤权的本机隔离**：前端切换账号、退出清除或收到项目 403/404 撤权响应时，必须通过 `accountEpochs` / `projectEpoch` 屏障阻止在途迟到响应污染 IndexedDB 快照，并立即隔离失权项目的离线操作（标记为 `blocked` 且不自动重放）。
5. **已发布迁移的不可变性**：`backend/migrations/` 下已纳入 `scripts/migrations-baseline.json` 的 0001～0077 迁移文件严禁修改或删除；任何表结构或触发器调整必须通过新增 `0078_*.sql` 递增迁移完成，并通过 `npm run check:migrations`。

---

## 四、 分阶段实施计划（Plan → Execute → Verify）

根据“先量化与止损、再治理写放大与刷新放大、后收敛重复组件与长期架构”的工程顺序，将改进工作划分为四个阶段：

### 第一阶段（Phase 1）：查询成本量化与数据完整性修复（P1 · 优先实施）

#### 任务 1.1：修复前端离线队列 `replaceLocalIds()` 的结构化替换
- **目标**：消除 `frontend/src/offline/queue.ts:108-115` 中 `JSON.stringify(row.body).replaceAll(from, to)` 可能误伤用户正文文本（如任务详情、评论内容、提交正文恰好包含相同字符串）的风险。
- **实施方案**：
  1. 在 `frontend/src/offline/queue.ts` 中编写结构化 ID 替换函数 `replaceOperationIds(operation: PendingOperation, from: string, to: string)`。
  2. 对 `operation.url`，仅按路径段边界（如 `/tasks/${from}`、`/materials/${from}`）替换。
  3. 对 `operation.body`，按操作路径精确替换目标 ID 字段（如 `taskId`、`targetId`、`dependsOnTaskIds` 数组元素、`materialVersionIds` 数组元素），绝不触碰 `title`、`detail`、`body`、`markdown`、`doc`、`criteria` 等文本载荷字段。
- **验证方法**：
  - 在 `frontend/src/offline/offline.test.ts` 中新增回归测试：构造离线创建任务 A，并在后续待同步的评论/任务详情正文中故意包含任务 A 的 `localId` 字符串，验证同步替换后路由与引用字段更新为真实 ID，而正文中的字符串原样保留。

#### 任务 1.2：建立关键链路 D1 读写行数（`rows_read` / `rows_written`）基线测量
- **目标**：在动手修改触发器或 SQL Guard 之前，用真实 D1 元数据量化各链路成本，避免盲目优化。
- **实施方案**：
  1. 扩展 `backend/scripts/` 下的本地基准脚本（参考 `d1-read-benchmark.md`），针对以下 4 条典型链路采集 `meta.rows_read`、`meta.rows_written` 与执行语句数：
     - 10 / 100 / 500 个任务规模下的单任务状态更新（`UPDATE tasks SET status = 'done'`）与依赖图修改（`replaceTaskDependencies`）；
     - 单次 R2 对象写入与分片上传完成（含 `storage_reservations` / `storage_objects` 触发器）；
     - `collaboration.ts` 中的方案应用（`applyProposal`）与提交裁定（`decideSubmission`）；
     - `project-ai-tools.ts` 中的单步文件读取工具调用。
  2. 将测量基线输出为 JSON 报告，作为后续阶段优化前后的对比依据。

---

### 第二阶段（Phase 2）：数据库写放大治理与前端缓存精确失效（P2 · 重点攻坚）

#### 任务 2.1：通过新迁移优化 `task_readiness` 触发器的全项目写放大
- **目标**：将单任务状态/负责人变更引发的 `task_readiness` 更新范围从 `O(项目总任务数)` 缩小至 `O(当前任务 + 直接下游依赖任务)`，并消除业务层与触发器的重复全表更新。
- **实施方案**：
  1. 新增迁移文件 `backend/migrations/0078_optimize_task_readiness_scope.sql`：
     - `DROP TRIGGER task_readiness_changed;`
     - 重建 `task_readiness_changed` 触发器：当 `tasks` 的 `status` 或 `assignee_id` 更新时，仅更新 `task_id = NEW.id` 以及 `task_id IN (SELECT task_id FROM task_dependencies WHERE depends_on_task_id = NEW.id AND project_id = NEW.project_id)` 的行。
     - **完整保留** `task_readiness_notify` 触发器，确保任何路径（包括测试中直接 `UPDATE tasks`）将任务推入 `ready = 1` 时仍能可靠生成通知并去重。
  2. 检查 `backend/src/services/task-readiness.ts` 中的 `readinessStatements()`：使其仅在**任务依赖边（`task_dependencies`）发生增删**时重算受影响的任务节点，不再对普通任务状态修改做全项目冗余重算。
- **验证方法**：
  - 运行 `backend/test/121-task-messaging.test.ts` 及全量后端测试，验证最后一项前置依赖完成、重新打开、任务转交、静默认领等通知语义 100% 保持一致。
  - 使用第一阶段建立的基准脚本，对比 100 个任务规模下修改单任务状态的 `rows_written` 降幅。

#### 任务 2.2：将前端 `offline-snapshot-updated` 改为按 URL 定向失效 Query
- **目标**：避免任何单个后台快照刷新引发全页面所有 TanStack Query 无差别重拉。
- **实施方案**：
  1. 在 `frontend/src/main.tsx:37-40` 中读取 `CustomEvent<{ accountId: string; url: string }>` 的 `detail.url`。
  2. 建立清晰的 URL 到 `queryKey` 匹配谓词函数（例如 `/api/v1/projects/{id}` 对应项目级查询，`/api/v1/auth/session` 对应 `['session']`，`/api/v1/capabilities` 对应 `['capabilities']`），并在短时间窗口（50ms）内合并同一组失效请求。
  3. 对于无法精确归类的兜底路径，仅失效当前所属 `projectId` 作用域下的查询。
- **验证方法**：
  - 运行 `frontend/src/api/client.etag.test.ts`、`client.offline.test.ts`、`client.project-access.test.ts`，并补充多组件挂载场景下后台快照更新仅触发目标 Query 重刷的单元测试。

#### 任务 2.3：收敛 `project-ai-tools.ts` 单步内的重复查库
- **目标**：消除 `read_project_file` 与 `beforeFetch` / `prepareMessages` 回调中在同一同步/异步紧邻步骤内连续执行 3 次相同 `assertToolAccess` / `guard()` 的冗余查询。
- **实施方案**：
  1. 在确保**每一次真实模型网络请求发出前（`beforeFetch`）**和**每一次工具结果落库前（`retainFiles`）**仍执行完整权限与生命周期校验的前提下，合并同一工具执行函数内部首尾紧邻的重复只读检查。
- **验证方法**：
  - 运行 `backend/test/121-project-tool-contracts.test.ts`、`109-project-reference-guard.test.ts`、`127-standard-conversation-guard.test.ts`，确认模型执行中途撤权、标准变更或来源移入回收站时依然立即阻断。

---

### 第三阶段（Phase 3）：低层公共组件收敛与代码格式化（P2/P3 · 稳步演进）

#### 任务 3.1：修复 `secrets.ts` Base64 转换并提取公共分块加密工具
- **目标**：消除 `String.fromCharCode(...iv, ...bytes)` 的调用栈溢出风险，收敛三处检查点的重复分块代码。
- **实施方案**：
  1. 在 `backend/src/ai/secrets.ts` 中使用安全的字节转二进制字符串循环（或分批处理）替代参数展开 `...bytes`，保持输出密文格式（含 `v2:{purpose}:` 前缀与 AES-GCM IV 布局）100% 兼容。
  2. 提取通用的 `sealChunkedEnvelope(format, idKey, idValue, payload, secret)` 与 `unsealChunkedEnvelope(...)`，供 `draft-preview-checkpoints.ts`、`project-investigation.ts`、`ai-checkpoints.ts` 复用，各自保留原有的 `encrypted-draft-preview-v1`、`encrypted-investigation-v1`、`encrypted-response-v1` 格式标识与元数据校验。
- **验证方法**：
  - 运行 `backend/test/154-purpose-secrets.test.ts`、`106-project-investigation.test.ts`、`108-background-preview.test.ts`，并新增超大载荷（> 256 KB）直接调用 `seal()` / `unseal()` 不抛 `RangeError` 的单元测试。

#### 任务 3.2：引入代码格式化工具，消除“单行压缩体”
- **目标**：将前后端单行超过 1,000 字符的 TSX / TS / CSS 文件恢复为标准多行可读格式。
- **实施方案**：
  1. 统一配置 Prettier（或 Biome），分批次对前端页面（如 `TemplateDraftWorkspace.tsx`、`RecordingIntake.tsx`、`ManualAssessmentEditor.tsx`）和后端服务执行纯格式化，不做任何 AST 逻辑改动。
  2. 将格式化提交哈希记录到仓库根目录的 `.git-blame-ignore-revs` 中，保持 `git blame` 历史可追溯。
- **验证方法**：
  - `npm run typecheck`、`npm run lint`、前后端全量测试与 `npm run verify:reproducible-build` 通过。

#### 任务 3.3：提取双轨上传/解析与前端草稿工作区的底层纯函数/Hook
- **目标**：在不强行合并正式项目与草稿数据库表的前提下，减少重复维护成本。
- **实施方案**：
  1. 后端提取分片长度计数流（`FixedLengthStream` 管道包装）、分块文本切分与 SHA-256 批次摘要校验等纯工具函数，供 `file-multipart.ts`、`document-imports.ts` 与 `draft-documents.ts` 共享。
  2. 前端提取创建草稿的公共状态与轮询 Hook，减少 `CreateProjectPage.tsx` 与 `TemplateDraftWorkspace.tsx` 中的重复状态同步代码；统一 `auth.ts` 的 `adminRequest()` 复用 `client.ts` 的底层超时与错误解析工具。

---

### 第四阶段（Phase 4）：长期架构演进与审慎评估项（P3 · 独立立项验证）

以下事项涉及较深层的契约或状态机边界，不应草率合并，需在完成前三阶段并取得实测收益后，按独立课题立项：

1. **ETag 响应生成方式评估**：
   - 针对 `backend/src/core/snapshot-etag.ts`，先在大型列表响应场景下实测 `response.clone()` 的内存水位。若确需改造，不直接改动同步的 `apiData()` 签名，而是设计专门的只读快照响应辅助函数，在序列化前计算摘要并处理 `If-None-Match`，在小范围路由灰度验证后再替换全局中间件。
2. **R2 存储归属上下文渐进显式化**：
   - 保持入口处 `withManagedStorage(env)` 代理作为兜底防线，逐步为其余 11 个调用 `FILES.put` 的业务模块显式绑定经服务端校验的 `StorageOwner`，使新写入不再触发 `storageOwner()` 的 8 表反查；仅将 `storageOwner()` 留作历史存量 Key 盘点与兜底恢复使用。
3. **AI 执行状态协调层（Execution Coordinator）封装**：
   - 保持 `usage_reservations`、`ai_resource_dispatches`、`ai_executions` 三张表的职责分离，在其上层封装清晰的协调接口（统一处理申请、完成、未知中断暂停、取消与槽位释放的 `DB.batch` 组合），减少业务层对多表内部状态字段的直接感知。
4. **巨型 SQL Guard 的结构化构造与诊断分层**：
   - 保持写入语句中的原子 `WHERE` 约束不变，将长字符串拼接重构为命名清晰的 SQL 谓词构建器，并规范“前置只读快速失败诊断（提供精确业务错误码） + 写入时紧凑原子断言（防御并发竞态）”的双层模式。
