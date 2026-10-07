# 数据库完整结构字典

本附录由 `backend/migrations/*.sql` 在空的 SQLite 内存数据库重放后提取。按完整文件名排序，仅跳过演示数据 `0002_seed.sql`，包含退役账本迁移 `0033_remove_manual_ledger.sql`；当前参考含 121 张业务表。它不能替代生产数据库实际应用记录。列约束、外键与索引均源自 SQLite 元数据；完整 CHECK 表达式保留在每表 DDL。

当前参考结构包含 `0043_remove_task_parent.sql`，移除了历史任务父子关系；任务平级保存，主目标和前置依赖分别维护。下方结构描述的是代码中迁移完成后的目标结构，不表示生产数据库已应用该变更。

数据库迁移历史中保留的 AI 金额字段仅用于兼容既有结构和数据；当前应用不读取、不写入，也不提供项目金额预算或费用核算功能。

[返回技术说明](/app/help?doc=technical)。每张表可从章节目录直接定位，也可按字段名搜索。

约定：多数 ID 为 TEXT UUID，日期和时间为 TEXT；时间戳使用 ISO-8601 UTC，日历日期使用日期字符串。SQLite 中 NULL 允许性以 NOT NULL 声明列为准；TEXT PRIMARY KEY 在 SQLite 上不等同于额外声明 NOT NULL，应用仍须提供合法 ID。JSON TEXT 的结构由 TypeScript 契约及服务校验，多数没有数据库层 JSON CHECK。

## `account_invitations`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `code_hash` | TEXT | 是 | 无 | 否 |
| `created_by` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `used_at` | TEXT | 否 | 无 | 否 |
| `used_by` | TEXT | 否 | 无 | 否 |

外键：
- `used_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `created_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_account_invitations_2`：`code_hash`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_account_invitations_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE account_invitations (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES users(id)
);
```

## `account_role_audit`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `target_id` | TEXT | 是 | 无 | 否 |
| `previous_role` | TEXT | 是 | 无 | 否 |
| `new_role` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `target_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `actor_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_account_role_audit_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE account_role_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  target_id TEXT NOT NULL REFERENCES users(id),
  previous_role TEXT NOT NULL,
  new_role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

## `admin_ai_retry_batches`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `idempotency_key` | TEXT | 是 | 无 | 否 |
| `requested_by` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'queued' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
无。

索引：
- `admin_ai_retry_one_active`：`None`；唯一；来源 c；部分索引。
- `sqlite_autoindex_admin_ai_retry_batches_2`：`idempotency_key`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_admin_ai_retry_batches_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE admin_ai_retry_batches (
 id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, requested_by TEXT,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX admin_ai_retry_one_active ON admin_ai_retry_batches((1)) WHERE status IN ('queued','running');
```

## `admin_ai_retry_items`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `batch_id` | TEXT | 是 | 无 | 否 |
| `target_type` | TEXT | 是 | 无 | 否 |
| `target_id` | TEXT | 是 | 无 | 否 |
| `failed_at` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `reason` | TEXT | 否 | 无 | 否 |
| `retry_job_id` | TEXT | 否 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `batch_id` → `admin_ai_retry_batches.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `admin_ai_retry_due`：`status`, `updated_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_admin_ai_retry_items_2`：`batch_id`, `target_type`, `target_id`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_admin_ai_retry_items_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE admin_ai_retry_items (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES admin_ai_retry_batches(id),
 target_type TEXT NOT NULL CHECK(target_type IN ('job','draft')), target_id TEXT NOT NULL,
 failed_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','queued','skipped')),
 reason TEXT, retry_job_id TEXT, updated_at TEXT NOT NULL,
 UNIQUE(batch_id,target_type,target_id)
);
CREATE INDEX admin_ai_retry_due ON admin_ai_retry_items(status,updated_at);
```

## `admin_ai_retry_links`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `parent_job_id` | TEXT | 否 | 无 | 1 |
| `retry_job_id` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `retry_job_id` → `jobs.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `parent_job_id` → `jobs.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_admin_ai_retry_links_2`：`retry_job_id`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_admin_ai_retry_links_1`：`parent_job_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE admin_ai_retry_links (
 parent_job_id TEXT PRIMARY KEY REFERENCES jobs(id), retry_job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), created_at TEXT NOT NULL
);
```

## `agent_bridge_artifacts`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `handoff_id` | TEXT | 是 | 无 | 1 |
| `artifact_id` | TEXT | 是 | 无 | 2 |
| `file_id` | TEXT | 是 | 无 | 否 |
| `name` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 是 | 无 | 否 |
| `sha256` | TEXT | 是 | 无 | 否 |
| `stored` | INTEGER | 是 | 0 | 否 |

外键：
- `file_id` → `files.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `handoff_id` → `agent_bridge_handoffs.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_agent_bridge_artifacts_2`：`file_id`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_agent_bridge_artifacts_1`：`handoff_id`, `artifact_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE agent_bridge_artifacts (
 handoff_id TEXT NOT NULL REFERENCES agent_bridge_handoffs(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL, file_id TEXT NOT NULL REFERENCES files(id), name TEXT NOT NULL,
 size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, stored INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(handoff_id,artifact_id), UNIQUE(file_id)
);
```

## `agent_bridge_devices`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `credential_hash` | TEXT | 是 | 无 | 否 |
| `device_name` | TEXT | 是 | 无 | 否 |
| `bridge_version` | TEXT | 是 | 无 | 否 |
| `dsh_version` | TEXT | 是 | 无 | 否 |
| `owner_id` | TEXT | 否 | 无 | 否 |
| `pairing_expires_at` | TEXT | 是 | 无 | 否 |
| `revoked_at` | TEXT | 否 | 无 | 否 |
| `last_seen_at` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `owner_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_agent_bridge_devices_2`：`credential_hash`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_agent_bridge_devices_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE agent_bridge_devices (
 id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE, device_name TEXT NOT NULL,
 bridge_version TEXT NOT NULL, dsh_version TEXT NOT NULL, owner_id TEXT REFERENCES users(id),
 pairing_expires_at TEXT NOT NULL, revoked_at TEXT, last_seen_at TEXT, created_at TEXT NOT NULL
);
```

## `agent_bridge_events`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `handoff_id` | TEXT | 是 | 无 | 1 |
| `sequence` | INTEGER | 是 | 无 | 2 |
| `payload_json` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `handoff_id` → `agent_bridge_handoffs.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_agent_bridge_events_1`：`handoff_id`, `sequence`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE agent_bridge_events (
 handoff_id TEXT NOT NULL REFERENCES agent_bridge_handoffs(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(handoff_id,sequence)
);
```

## `agent_bridge_handoffs`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `task_id` | TEXT | 是 | 无 | 否 |
| `task_revision` | INTEGER | 是 | 无 | 否 |
| `device_id` | TEXT | 是 | 无 | 否 |
| `requested_by` | TEXT | 是 | 无 | 否 |
| `idempotency_key` | TEXT | 是 | 无 | 否 |
| `request_hash` | TEXT | 是 | 无 | 否 |
| `state` | TEXT | 是 | 无 | 否 |
| `reason` | TEXT | 否 | 无 | 否 |
| `snapshot_hash` | TEXT | 否 | 无 | 否 |
| `snapshot_key` | TEXT | 否 | 无 | 否 |
| `context_hash` | TEXT | 否 | 无 | 否 |
| `context_stamp` | TEXT | 否 | 无 | 否 |
| `eligibility_hash` | TEXT | 否 | 无 | 否 |
| `session_id` | TEXT | 否 | 无 | 否 |
| `last_sequence` | INTEGER | 是 | 0 | 否 |
| `result_json` | TEXT | 否 | 无 | 否 |
| `stale` | INTEGER | 是 | 0 | 否 |
| `adopted_submission_id` | TEXT | 否 | 无 | 否 |
| `adoption_token` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |

外键：
- `requested_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `device_id` → `agent_bridge_devices.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `task_id` → `tasks.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。
- `project_id` → `projects.id`；ON DELETE NO ACTION；复合关系编号 3，顺序 0。

索引：
- `agent_bridge_queue`：`device_id`, `state`, `created_at`；非唯一；来源 c；非部分索引。
- `agent_bridge_one_task`：`task_id`；唯一；来源 c；部分索引。
- `agent_bridge_one_active`：`device_id`；唯一；来源 c；部分索引。
- `sqlite_autoindex_agent_bridge_handoffs_2`：`requested_by`, `idempotency_key`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_agent_bridge_handoffs_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE agent_bridge_handoffs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 task_revision INTEGER NOT NULL, device_id TEXT NOT NULL REFERENCES agent_bridge_devices(id),
 requested_by TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('checking','waiting_device','claimed','running','waiting_input','uploading','ready_for_review','blocked','failed','cancel_requested','cancelled','dispatch_uncertain')),
 reason TEXT, snapshot_hash TEXT, snapshot_key TEXT, context_hash TEXT, context_stamp TEXT, eligibility_hash TEXT,
 session_id TEXT, last_sequence INTEGER NOT NULL DEFAULT 0, result_json TEXT,
 stale INTEGER NOT NULL DEFAULT 0, adopted_submission_id TEXT, adoption_token TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 UNIQUE(requested_by,idempotency_key)
);
CREATE INDEX agent_bridge_queue ON agent_bridge_handoffs(device_id,state,created_at);
CREATE UNIQUE INDEX agent_bridge_one_task ON agent_bridge_handoffs(task_id)
 WHERE state IN ('checking','waiting_device','claimed','running','waiting_input','uploading','cancel_requested','dispatch_uncertain');
CREATE UNIQUE INDEX agent_bridge_one_active ON agent_bridge_handoffs(device_id)
 WHERE state IN ('claimed','running','waiting_input','uploading','cancel_requested','dispatch_uncertain');
```

## `agent_bridge_scopes`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `device_id` | TEXT | 是 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 2 |
| `workspace_label` | TEXT | 否 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。
- `device_id` → `agent_bridge_devices.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_agent_bridge_scopes_1`：`device_id`, `project_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE agent_bridge_scopes (
 device_id TEXT NOT NULL REFERENCES agent_bridge_devices(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 workspace_label TEXT, PRIMARY KEY(device_id,project_id)
);
```

## `agent_runs`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `session_id` | TEXT | 否 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `capability` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `mode` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'running' | 否 |
| `inputs_json` | TEXT | 是 | '{}' | 否 |
| `output_json` | TEXT | 否 | 无 | 否 |
| `prompt_version` | TEXT | 是 | '' | 否 |
| `ai_config_version_id` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `adopted_at` | TEXT | 否 | 无 | 否 |
| `adoption_material_version_id` | TEXT | 否 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。
- `session_id` → `agent_sessions.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `idx_agent_runs_project`：`project_id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_agent_runs_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  job_id TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'adopted')),
  inputs_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  prompt_version TEXT NOT NULL DEFAULT '',
  ai_config_version_id TEXT,
  created_at TEXT NOT NULL,
  adopted_at TEXT,
  adoption_material_version_id TEXT
);
CREATE INDEX idx_agent_runs_project ON agent_runs (project_id);
```

## `agent_sessions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `capability` | TEXT | 是 | 无 | 否 |
| `title` | TEXT | 是 | '' | 否 |
| `task_id` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'active' | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `created_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `task_id` → `tasks.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 2，顺序 0。

索引：
- `idx_agent_sessions_project`：`project_id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_agent_sessions_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN ('do', 'guide', 'review_only')),
  title TEXT NOT NULL DEFAULT '',
  task_id TEXT REFERENCES tasks(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_sessions_project ON agent_sessions (project_id);
```

## `agent_turns`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `session_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `sequence` | INTEGER | 是 | 无 | 否 |
| `role` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `run_id` | TEXT | 否 | 无 | 否 |
| `payload_json` | TEXT | 是 | '{}' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。
- `session_id` → `agent_sessions.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_agent_turns_2`：`session_id`, `sequence`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_agent_turns_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE agent_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  kind TEXT NOT NULL CHECK (kind IN ('instruction', 'answer', 'draft', 'question', 'review_result')),
  run_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (session_id, sequence)
);
```

## `ai_activity_events`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `target_id` | TEXT | 是 | 无 | 否 |
| `code` | TEXT | 是 | 无 | 否 |
| `state` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `progress_json` | TEXT | 否 | 无 | 否 |

外键：
- `target_id` → `ai_task_activities.target_id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `ai_activity_events_target`：`target_id`, `id`；非唯一；来源 c；非部分索引。

```sql
CREATE TABLE ai_activity_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 target_id TEXT NOT NULL REFERENCES ai_task_activities(target_id),
 code TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('started','completed','failed','resumed')),
 created_at TEXT NOT NULL,
 progress_json TEXT
);
CREATE INDEX ai_activity_events_target ON ai_activity_events(target_id,id);
```

## `ai_automatic_retries`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `target_kind` | TEXT | 是 | 无 | 否 |
| `target_id` | TEXT | 是 | 无 | 否 |
| `draft_id` | TEXT | 否 | 无 | 否 |
| `attempts` | INTEGER | 是 | 0 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `next_attempt_at` | TEXT | 是 | 无 | 否 |
| `lease_token` | TEXT | 否 | 无 | 否 |
| `lease_until` | TEXT | 否 | 无 | 否 |
| `last_error` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
无。

索引：
- `ai_automatic_retries_target`：`target_kind`, `target_id`；非唯一；来源 c；非部分索引。
- `ai_automatic_retries_due`：`status`, `next_attempt_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_ai_automatic_retries_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE ai_automatic_retries (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('job','draft_preview')),
  target_id TEXT NOT NULL,
  draft_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  status TEXT NOT NULL CHECK(status IN ('pending','dispatching','dispatched','exhausted','cancelled','complete')),
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ai_automatic_retries_target ON ai_automatic_retries(target_kind,target_id);
CREATE INDEX ai_automatic_retries_due ON ai_automatic_retries(status,next_attempt_at);
```

## `ai_calls`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 否 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `run_id` | TEXT | 否 | 无 | 否 |
| `purpose` | TEXT | 是 | 无 | 否 |
| `config_version_id` | TEXT | 否 | 无 | 否 |
| `prompt_version` | TEXT | 是 | '' | 否 |
| `model` | TEXT | 是 | 无 | 否 |
| `input_r2_key` | TEXT | 否 | 无 | 否 |
| `output_r2_key` | TEXT | 否 | 无 | 否 |
| `prompt_tokens` | INTEGER | 否 | 无 | 否 |
| `completion_tokens` | INTEGER | 否 | 无 | 否 |
| `cost_usd` | REAL | 否 | 无 | 否 |
| `cost_status` | TEXT | 是 | 'unknown' | 否 |
| `status` | TEXT | 是 | 'ok' | 否 |
| `latency_ms` | INTEGER | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `reservation_id` | TEXT | 否 | 无 | 否 |
| `draft_id` | TEXT | 否 | 无 | 否 |
| `search_usage_json` | TEXT | 否 | 无 | 否 |

外键：
- `draft_id` → `project_creation_drafts.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `reservation_id` → `usage_reservations.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `config_version_id` → `ai_config_versions.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 3，顺序 0。

索引：
- `idx_ai_calls_reservation`：`reservation_id`；非唯一；来源 c；非部分索引。
- `idx_ai_calls_project`：`project_id`, `created_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_ai_calls_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE ai_calls (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  job_id TEXT,
  run_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('textEconomy', 'visionEconomy', 'review')),
  config_version_id TEXT REFERENCES ai_config_versions(id),
  prompt_version TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  input_r2_key TEXT,
  output_r2_key TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  cost_status TEXT NOT NULL DEFAULT 'unknown' CHECK (cost_status IN ('known', 'unknown')),
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'repaired', 'invalid', 'failed', 'timeout')),
  latency_ms INTEGER,
  created_at TEXT NOT NULL
, reservation_id TEXT REFERENCES usage_reservations(id), draft_id TEXT REFERENCES project_creation_drafts(id), search_usage_json TEXT);
CREATE INDEX idx_ai_calls_reservation ON ai_calls(reservation_id);
CREATE INDEX idx_ai_calls_project ON ai_calls (project_id, created_at);
```

## `ai_clarifications`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 否 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `draft_id` | TEXT | 否 | 无 | 否 |
| `owner_id` | TEXT | 是 | 无 | 否 |
| `attempt_id` | TEXT | 是 | 无 | 否 |
| `context_revision` | INTEGER | 否 | 无 | 否 |
| `tool_call_id` | TEXT | 是 | 无 | 否 |
| `question_json` | TEXT | 是 | 无 | 否 |
| `answer_json` | TEXT | 否 | 无 | 否 |
| `transition_token` | TEXT | 否 | 无 | 否 |
| `round` | INTEGER | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `owner_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `draft_id` → `project_creation_drafts.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `job_id` → `jobs.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。
- `project_id` → `projects.id`；ON DELETE NO ACTION；复合关系编号 3，顺序 0。

索引：
- `idx_ai_clarifications_one_pending`：`attempt_id`；唯一；来源 c；部分索引。
- `idx_ai_clarifications_draft`：`draft_id`, `attempt_id`, `created_at`；非唯一；来源 c；非部分索引。
- `idx_ai_clarifications_job`：`job_id`, `owner_id`, `status`, `created_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_ai_clarifications_2`：`attempt_id`, `tool_call_id`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_ai_clarifications_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE ai_clarifications (
 id TEXT PRIMARY KEY,
 project_id TEXT REFERENCES projects(id),
 job_id TEXT REFERENCES jobs(id),
 draft_id TEXT REFERENCES project_creation_drafts(id),
 owner_id TEXT NOT NULL REFERENCES users(id),
 attempt_id TEXT NOT NULL,
 context_revision INTEGER,
 tool_call_id TEXT NOT NULL,
 question_json TEXT NOT NULL,
 answer_json TEXT,
 transition_token TEXT,
 round INTEGER NOT NULL CHECK(round BETWEEN 1 AND 3),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','cancelled')),
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK((job_id IS NOT NULL AND project_id IS NOT NULL AND draft_id IS NULL) OR (draft_id IS NOT NULL AND job_id IS NULL AND project_id IS NULL)),
 UNIQUE(attempt_id,tool_call_id)
);
CREATE UNIQUE INDEX idx_ai_clarifications_one_pending ON ai_clarifications(attempt_id) WHERE status='pending';
CREATE INDEX idx_ai_clarifications_draft ON ai_clarifications(draft_id,attempt_id,created_at);
CREATE INDEX idx_ai_clarifications_job ON ai_clarifications(job_id,owner_id,status,created_at);
```

## `ai_config_versions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `version` | INTEGER | 是 | 无 | 否 |
| `config_json` | TEXT | 是 | 无 | 否 |
| `enabled` | INTEGER | 是 | 0 | 否 |
| `notes` | TEXT | 否 | 无 | 否 |
| `created_by` | TEXT | 是 | 'system' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
无。

索引：
- `sqlite_autoindex_ai_config_versions_2`：`version`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_ai_config_versions_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE ai_config_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);
```

## `ai_diagnostics`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `entry_json` | TEXT | 是 | 无 | 否 |
| `byte_size` | INTEGER | 是 | 无 | 否 |

外键：
无。

索引：
无。

```sql
CREATE TABLE ai_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_json TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size = length(CAST(entry_json AS BLOB)) + 1)
);
```

## `ai_execution_slices`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `job_id` | TEXT | 是 | 无 | 1 |
| `slice` | INTEGER | 是 | 无 | 2 |
| `instance_id` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `attempts` | INTEGER | 是 | 0 | 否 |
| `last_error` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `job_id` → `jobs.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `ai_execution_slices_pending`：`status`, `updated_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_ai_execution_slices_2`：`job_id`, `slice`；唯一；来源 pk；非部分索引。
- `sqlite_autoindex_ai_execution_slices_1`：`instance_id`；唯一；来源 u；非部分索引。

```sql
CREATE TABLE ai_execution_slices (
 job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 slice INTEGER NOT NULL CHECK(slice >= 0 AND slice < 512),
 instance_id TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('pending','dispatched','running','continued','complete')),
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(job_id,slice)
);
CREATE INDEX ai_execution_slices_pending ON ai_execution_slices(status,updated_at);
```

## `ai_investigations`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `requested_by` | TEXT | 是 | 无 | 否 |
| `prompt_version` | TEXT | 是 | 无 | 否 |
| `checkpoint_key` | TEXT | 是 | 无 | 否 |
| `phase` | TEXT | 是 | 'read' | 否 |
| `step` | INTEGER | 是 | 0 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `requested_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `job_id` → `jobs.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `project_id` → `projects.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。

索引：
- `idx_ai_investigations_job`：`job_id`, `prompt_version`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_ai_investigations_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE ai_investigations (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 job_id TEXT REFERENCES jobs(id), requested_by TEXT NOT NULL REFERENCES users(id),
 prompt_version TEXT NOT NULL, checkpoint_key TEXT NOT NULL,
 phase TEXT NOT NULL DEFAULT 'read', step INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL
);
CREATE INDEX idx_ai_investigations_job ON ai_investigations(job_id,prompt_version);
```

## `ai_probes`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `config_version_id` | TEXT | 是 | 无 | 1 |
| `purpose` | TEXT | 是 | 无 | 2 |
| `passed` | INTEGER | 是 | 0 | 否 |
| `report_json` | TEXT | 是 | 无 | 否 |
| `tested_at` | TEXT | 是 | 无 | 否 |

外键：
- `config_version_id` → `ai_config_versions.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_ai_probes_1`：`config_version_id`, `purpose`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE ai_probes (
 config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
 purpose TEXT NOT NULL,
 passed INTEGER NOT NULL DEFAULT 0,
 report_json TEXT NOT NULL,
 tested_at TEXT NOT NULL,
 PRIMARY KEY (config_version_id, purpose)
);
```

## `ai_task_activities`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `target_id` | TEXT | 否 | 无 | 1 |
| `code` | TEXT | 是 | 'preparing' | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `last_response_at` | TEXT | 否 | 无 | 否 |
| `progress_json` | TEXT | 否 | 无 | 否 |
| `uncertain` | INTEGER | 是 | 0 | 否 |

外键：
无。

索引：
- `sqlite_autoindex_ai_task_activities_1`：`target_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE ai_task_activities (
 target_id TEXT PRIMARY KEY,
 code TEXT NOT NULL DEFAULT 'preparing',
 updated_at TEXT NOT NULL,
 last_response_at TEXT,
 progress_json TEXT,
 uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1))
);
```

## `ai_tool_calls`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `requested_by` | TEXT | 是 | 无 | 否 |
| `name` | TEXT | 是 | 无 | 否 |
| `args_json` | TEXT | 是 | 无 | 否 |
| `result_json` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `requested_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `job_id` → `jobs.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `project_id` → `projects.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。

索引：
- `idx_ai_tool_calls_job`：`project_id`, `job_id`, `created_at`, `id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_ai_tool_calls_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE ai_tool_calls (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 job_id TEXT REFERENCES jobs(id),
 requested_by TEXT NOT NULL REFERENCES users(id),
 name TEXT NOT NULL,
 args_json TEXT NOT NULL,
 result_json TEXT,
 status TEXT NOT NULL CHECK(status IN ('ok','failed')),
 created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_tool_calls_job ON ai_tool_calls(project_id,job_id,created_at,id);
```

## `app_config`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `key` | TEXT | 否 | 无 | 1 |
| `value_json` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
无。

索引：
- `sqlite_autoindex_app_config_1`：`key`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## `assessment_corrections`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `assessment_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `revision` | INTEGER | 是 | 无 | 否 |
| `reason` | TEXT | 是 | 无 | 否 |
| `previous_report_json` | TEXT | 否 | 无 | 否 |
| `report_json` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `actor_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `assessment_id` → `assessments.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。

索引：
- `sqlite_autoindex_assessment_corrections_2`：`assessment_id`, `revision`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_assessment_corrections_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE assessment_corrections (
 id TEXT PRIMARY KEY,
 assessment_id TEXT NOT NULL REFERENCES assessments(id),
 project_id TEXT NOT NULL REFERENCES projects(id),
 actor_id TEXT NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL,
 reason TEXT NOT NULL,
 previous_report_json TEXT,
 report_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(assessment_id,revision)
);
```

## `assessments`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `entity_id` | TEXT | 否 | 无 | 否 |
| `goal_revision` | INTEGER | 是 | 无 | 否 |
| `standards_version_id` | TEXT | 是 | 无 | 否 |
| `inputs_json` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `report_json` | TEXT | 否 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `origin` | TEXT | 是 | 'ai' | 否 |
| `ai_report_json` | TEXT | 否 | 无 | 否 |

外键：
- `created_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `standards_version_id` → `standards_versions.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 2，顺序 0。

索引：
- `idx_assessments_project`：`project_id`, `created_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_assessments_2`：`entity_id`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_assessments_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE assessments (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('material_review','rehearsal')), entity_id TEXT UNIQUE,
 goal_revision INTEGER NOT NULL, standards_version_id TEXT NOT NULL REFERENCES standards_versions(id),
 inputs_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','succeeded','failed')),
 report_json TEXT, job_id TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
, revision INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT 'ai', ai_report_json TEXT);
CREATE INDEX idx_assessments_project ON assessments(project_id,created_at);
```

## `audio_pipeline`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `job_id` | TEXT | 否 | 无 | 1 |
| `phase` | TEXT | 是 | 'pending' | 否 |
| `transcript_r2_key` | TEXT | 否 | 无 | 否 |
| `quality_json` | TEXT | 是 | '[]' | 否 |
| `chunks_json` | TEXT | 是 | '[]' | 否 |
| `final_summary_json` | TEXT | 否 | 无 | 否 |
| `summaries_json` | TEXT | 是 | '[]' | 否 |
| `config_version_id` | TEXT | 是 | 无 | 否 |
| `fallback_config_version_id` | TEXT | 否 | 无 | 否 |
| `error` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `fallback_config_version_id` → `ai_config_versions.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `config_version_id` → `ai_config_versions.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `job_id` → `jobs.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。

索引：
- `audio_pipeline_phase`：`phase`, `updated_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_audio_pipeline_1`：`job_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE audio_pipeline (
 job_id TEXT PRIMARY KEY REFERENCES jobs(id),
 phase TEXT NOT NULL DEFAULT 'pending',
 transcript_r2_key TEXT,
 quality_json TEXT NOT NULL DEFAULT '[]',
 chunks_json TEXT NOT NULL DEFAULT '[]',
 final_summary_json TEXT,
 summaries_json TEXT NOT NULL DEFAULT '[]',
 config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
 fallback_config_version_id TEXT REFERENCES ai_config_versions(id),
 error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX audio_pipeline_phase ON audio_pipeline(phase,updated_at);
```

## `audio_pipeline_calls`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `stage` | TEXT | 是 | 无 | 否 |
| `block_index` | INTEGER | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'started' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `job_id` → `jobs.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_audio_pipeline_calls_2`：`job_id`, `stage`, `block_index`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_audio_pipeline_calls_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE audio_pipeline_calls (
 id TEXT PRIMARY KEY,
 job_id TEXT NOT NULL REFERENCES jobs(id),
 stage TEXT NOT NULL,
 block_index INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','ok','invalid','unknown')),
 created_at TEXT NOT NULL,
 UNIQUE(job_id,stage,block_index)
);
```

## `auth_accounts`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `user_id` | TEXT | 否 | 无 | 1 |
| `username` | TEXT | 否 | 无 | 否 |
| `username_norm` | TEXT | 否 | 无 | 否 |
| `contact_email` | TEXT | 否 | 无 | 否 |
| `contact_email_norm` | TEXT | 否 | 无 | 否 |
| `email_verified` | INTEGER | 是 | 0 | 否 |
| `password_hash` | TEXT | 否 | 无 | 否 |
| `is_admin` | INTEGER | 是 | 0 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `account_role` | TEXT | 否 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_auth_accounts_3`：`contact_email_norm`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_auth_accounts_2`：`username_norm`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_auth_accounts_1`：`user_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE auth_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username TEXT,
  username_norm TEXT UNIQUE,
  contact_email TEXT,
  contact_email_norm TEXT UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created_at TEXT NOT NULL
, account_role TEXT CHECK (account_role IN ('super_admin', 'admin', 'user')));
```

## `auth_challenges`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `email` | TEXT | 是 | 无 | 否 |
| `code_hmac` | TEXT | 是 | 无 | 否 |
| `attempts` | INTEGER | 是 | 0 | 否 |
| `ip` | TEXT | 否 | 无 | 否 |
| `requested_at` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |
| `consumed_at` | TEXT | 否 | 无 | 否 |

外键：
无。

索引：
- `idx_auth_challenges_email`：`email`, `requested_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_auth_challenges_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hmac TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX idx_auth_challenges_email ON auth_challenges (email, requested_at);
```

## `auth_email_daily_usage`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `day` | TEXT | 否 | 无 | 1 |
| `sends` | INTEGER | 是 | 0 | 否 |

外键：
无。

索引：
- `sqlite_autoindex_auth_email_daily_usage_1`：`day`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE auth_email_daily_usage (
  day TEXT PRIMARY KEY,
  sends INTEGER NOT NULL DEFAULT 0 CHECK (sends >= 0)
);
```

## `auth_email_ip_attempts`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `ip_hash` | TEXT | 是 | 无 | 否 |
| `attempted_at` | TEXT | 是 | 无 | 否 |

外键：
无。

索引：
- `idx_auth_email_ip_attempts`：`ip_hash`, `attempted_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_auth_email_ip_attempts_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE auth_email_ip_attempts (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX idx_auth_email_ip_attempts ON auth_email_ip_attempts(ip_hash, attempted_at);
```

## `auth_email_recipient_usage`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `day` | TEXT | 是 | 无 | 1 |
| `email_hash` | TEXT | 是 | 无 | 2 |
| `sends` | INTEGER | 是 | 0 | 否 |

外键：
无。

索引：
- `sqlite_autoindex_auth_email_recipient_usage_1`：`day`, `email_hash`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE auth_email_recipient_usage (
  day TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  sends INTEGER NOT NULL DEFAULT 0 CHECK (sends >= 0),
  PRIMARY KEY (day, email_hash)
);
```

## `auth_password_rate_limits`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `bucket_key` | TEXT | 否 | 无 | 1 |
| `attempts` | INTEGER | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |

外键：
无。

索引：
- `sqlite_autoindex_auth_password_rate_limits_1`：`bucket_key`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE auth_password_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
```

## `collaboration_proposal_revisions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `proposal_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `revision` | INTEGER | 是 | 无 | 否 |
| `payload_json` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `reason` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `proposal_id` → `collaboration_proposals.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_collaboration_proposal_revisions_2`：`proposal_id`, `revision`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_collaboration_proposal_revisions_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE collaboration_proposal_revisions (
 id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES collaboration_proposals(id),
 project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
 payload_json TEXT NOT NULL, status TEXT NOT NULL, actor_id TEXT NOT NULL,
 reason TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(proposal_id,revision)
);
```

## `collaboration_proposals`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `payload_json` | TEXT | 是 | 无 | 否 |
| `settings_revision` | INTEGER | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `mutation_token` | TEXT | 否 | 无 | 否 |

外键：
- `job_id` → `jobs.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `idx_collaboration_proposals`：`project_id`, `status`, `created_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_collaboration_proposals_2`：`job_id`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_collaboration_proposals_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE collaboration_proposals (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('decompose','assign')), job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
 payload_json TEXT NOT NULL, settings_revision INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','stale')),
 revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
, mutation_token TEXT);
CREATE INDEX idx_collaboration_proposals ON collaboration_proposals(project_id,status,created_at);
```

## `comments`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `target_type` | TEXT | 是 | 无 | 否 |
| `target_id` | TEXT | 是 | 无 | 否 |
| `author_id` | TEXT | 是 | 无 | 否 |
| `body` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `author_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `idx_comments_target`：`target_type`, `target_id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_comments_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_comments_target ON comments (target_type, target_id);
```

## `creation_draft_files`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `draft_id` | TEXT | 是 | 无 | 否 |
| `name` | TEXT | 是 | 无 | 否 |
| `ext` | TEXT | 是 | 无 | 否 |
| `r2_key` | TEXT | 是 | 无 | 否 |
| `sha256` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 是 | 无 | 否 |
| `mime` | TEXT | 是 | 无 | 否 |
| `pages_json` | TEXT | 是 | '[]' | 否 |
| `text_error` | TEXT | 否 | 无 | 否 |
| `removed` | INTEGER | 是 | 0 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `draft_id` → `project_creation_drafts.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `idx_creation_draft_files_draft`：`draft_id`, `removed`, `created_at`, `id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_creation_draft_files_2`：`r2_key`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_creation_draft_files_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE creation_draft_files (
 id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES project_creation_drafts(id),
 name TEXT NOT NULL,
 ext TEXT NOT NULL,
 r2_key TEXT NOT NULL UNIQUE,
 sha256 TEXT NOT NULL,
 size_bytes INTEGER NOT NULL,
 mime TEXT NOT NULL,
 pages_json TEXT NOT NULL DEFAULT '[]',
 text_error TEXT,
 removed INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE INDEX idx_creation_draft_files_draft ON creation_draft_files(draft_id,removed,created_at,id);
```

## `document_parse_batches`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `session_id` | TEXT | 是 | 无 | 1 |
| `batch_number` | INTEGER | 是 | 无 | 2 |
| `digest` | TEXT | 是 | 无 | 否 |

外键：
- `session_id` → `document_parse_sessions.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_document_parse_batches_1`：`session_id`, `batch_number`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE document_parse_batches (
 session_id TEXT NOT NULL REFERENCES document_parse_sessions(id), batch_number INTEGER NOT NULL,
 digest TEXT NOT NULL, PRIMARY KEY(session_id,batch_number)
);
```

## `document_parse_pages`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `session_id` | TEXT | 是 | 无 | 1 |
| `page_number` | INTEGER | 是 | 无 | 2 |

外键：
- `session_id` → `document_parse_sessions.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_document_parse_pages_1`：`session_id`, `page_number`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE document_parse_pages (
 session_id TEXT NOT NULL REFERENCES document_parse_sessions(id), page_number INTEGER NOT NULL,
 PRIMARY KEY(session_id,page_number)
);
```

## `document_parse_sessions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `source_version_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `lifecycle_version` | INTEGER | 是 | 无 | 否 |
| `method` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'processing' | 否 |
| `next_batch` | INTEGER | 是 | 0 | 否 |
| `next_seq` | INTEGER | 是 | 1 | 否 |
| `warnings_json` | TEXT | 是 | '[]' | 否 |
| `total_pages` | INTEGER | 否 | 无 | 否 |
| `processed_pages` | INTEGER | 是 | 0 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `actor_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `source_version_id` → `source_versions.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。

索引：
- `document_parse_active`：`source_version_id`, `lifecycle_version`；唯一；来源 c；部分索引。
- `sqlite_autoindex_document_parse_sessions_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE document_parse_sessions (
 id TEXT PRIMARY KEY, source_version_id TEXT NOT NULL REFERENCES source_versions(id), project_id TEXT NOT NULL REFERENCES projects(id),
 actor_id TEXT NOT NULL REFERENCES users(id), lifecycle_version INTEGER NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('browser-pdf','browser-docx')), status TEXT NOT NULL DEFAULT 'processing',
 next_batch INTEGER NOT NULL DEFAULT 0, next_seq INTEGER NOT NULL DEFAULT 1,
 warnings_json TEXT NOT NULL DEFAULT '[]', total_pages INTEGER, processed_pages INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX document_parse_active ON document_parse_sessions(source_version_id,lifecycle_version) WHERE status IN ('processing','finalizing');
```

## `draft_document_blocks`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `draft_id` | TEXT | 是 | 无 | 否 |
| `file_id` | TEXT | 是 | 无 | 否 |
| `seq` | INTEGER | 是 | 无 | 否 |
| `page_number` | INTEGER | 否 | 无 | 否 |
| `content` | TEXT | 是 | 无 | 否 |
| `heading_json` | TEXT | 是 | '[]' | 否 |

外键：
- `file_id` → `creation_draft_files.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。
- `draft_id` → `project_creation_drafts.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_draft_document_blocks_2`：`file_id`, `seq`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_draft_document_blocks_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE draft_document_blocks(
 id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES project_creation_drafts(id) ON DELETE CASCADE,
 file_id TEXT NOT NULL REFERENCES creation_draft_files(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL,
 page_number INTEGER,
 content TEXT NOT NULL,
 heading_json TEXT NOT NULL DEFAULT '[]',
 UNIQUE(file_id,seq)
);
```

## `draft_document_imports`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `file_id` | TEXT | 否 | 无 | 1 |
| `draft_id` | TEXT | 是 | 无 | 否 |
| `revision` | INTEGER | 是 | 无 | 否 |
| `interrupted` | INTEGER | 是 | 0 | 否 |
| `status` | TEXT | 是 | 'importing' | 否 |
| `warnings_json` | TEXT | 是 | '[]' | 否 |

外键：
- `file_id` → `creation_draft_files.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_draft_document_imports_1`：`file_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE draft_document_imports(
 file_id TEXT PRIMARY KEY REFERENCES creation_draft_files(id) ON DELETE CASCADE,
 draft_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 interrupted INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'importing' CHECK(status IN ('importing','complete','partial')),
 warnings_json TEXT NOT NULL DEFAULT '[]'
);
```

## `draft_document_part_leases`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `file_id` | TEXT | 是 | 无 | 1 |
| `part_number` | INTEGER | 是 | 无 | 2 |
| `lease_owner` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |

外键：
- `file_id` → `draft_document_uploads.file_id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_draft_document_part_leases_1`：`file_id`, `part_number`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE draft_document_part_leases(
 file_id TEXT NOT NULL REFERENCES draft_document_uploads(file_id) ON DELETE CASCADE,
 part_number INTEGER NOT NULL,
 lease_owner TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 PRIMARY KEY(file_id,part_number)
);
```

## `draft_document_parts`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `file_id` | TEXT | 是 | 无 | 1 |
| `part_number` | INTEGER | 是 | 无 | 2 |
| `etag` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 是 | 无 | 否 |

外键：
- `file_id` → `draft_document_uploads.file_id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_draft_document_parts_1`：`file_id`, `part_number`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE draft_document_parts(
 file_id TEXT NOT NULL REFERENCES draft_document_uploads(file_id) ON DELETE CASCADE,
 part_number INTEGER NOT NULL,
 etag TEXT NOT NULL,
 size_bytes INTEGER NOT NULL,
 PRIMARY KEY(file_id,part_number)
);
```

## `draft_document_uploads`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `file_id` | TEXT | 否 | 无 | 1 |
| `draft_id` | TEXT | 是 | 无 | 否 |
| `upload_id` | TEXT | 是 | 无 | 否 |
| `r2_key` | TEXT | 是 | 无 | 否 |
| `name` | TEXT | 是 | 无 | 否 |
| `ext` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 是 | 无 | 否 |
| `revision` | INTEGER | 是 | 无 | 否 |
| `operation_token` | TEXT | 否 | 无 | 否 |
| `operation_expires_at` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'uploading' | 否 |

外键：
- `draft_id` → `project_creation_drafts.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_draft_document_uploads_1`：`file_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE draft_document_uploads(
 file_id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES project_creation_drafts(id) ON DELETE CASCADE,
 upload_id TEXT NOT NULL,
 r2_key TEXT NOT NULL,
 name TEXT NOT NULL,
 ext TEXT NOT NULL,
 size_bytes INTEGER NOT NULL,
 revision INTEGER NOT NULL,
 operation_token TEXT,
 operation_expires_at TEXT,
 status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','completing','aborting','complete','cancelled'))
);
```

## `draft_preview_dispatches`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `instance_id` | TEXT | 否 | 无 | 1 |
| `draft_id` | TEXT | 是 | 无 | 否 |
| `attempt_id` | TEXT | 是 | 无 | 否 |
| `context_revision` | INTEGER | 是 | 无 | 否 |
| `question_id` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `question_id` → `ai_clarifications.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `draft_id` → `project_creation_drafts.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。

索引：
- `idx_draft_preview_dispatches_pending`：`status`, `updated_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_draft_preview_dispatches_1`：`instance_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE draft_preview_dispatches (
 instance_id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES project_creation_drafts(id),
 attempt_id TEXT NOT NULL,
 context_revision INTEGER NOT NULL,
 question_id TEXT REFERENCES ai_clarifications(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','cancelled')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX idx_draft_preview_dispatches_pending ON draft_preview_dispatches(status,updated_at);
```

## `events`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `actor_type` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | '' | 否 |
| `type` | TEXT | 是 | 无 | 否 |
| `entity_type` | TEXT | 是 | 无 | 否 |
| `entity_id` | TEXT | 是 | '' | 否 |
| `dedup_key` | TEXT | 是 | '' | 否 |
| `payload_json` | TEXT | 是 | '{}' | 否 |
| `occurred_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `idx_events_project_time`：`project_id`, `occurred_at`；非唯一；来源 c；非部分索引。
- `uq_events_dedup`：`project_id`, `type`, `entity_type`, `entity_id`, `dedup_key`；唯一；来源 c；非部分索引。
- `sqlite_autoindex_events_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'ai', 'system')),
  actor_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  dedup_key TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_events_project_time ON events (project_id, occurred_at);
CREATE UNIQUE INDEX uq_events_dedup ON events (project_id, type, entity_type, entity_id, dedup_key);
```

## `file_contributors`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `file_id` | TEXT | 是 | 无 | 1 |
| `user_id` | TEXT | 是 | 无 | 2 |
| `display_name` | TEXT | 是 | 无 | 否 |

外键：
- `file_id` → `files.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_file_contributors_1`：`file_id`, `user_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE file_contributors (
 file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL,
 display_name TEXT NOT NULL,
 PRIMARY KEY (file_id, user_id)
);
```

## `file_upload_part_leases`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `session_id` | TEXT | 是 | 无 | 1 |
| `part_number` | INTEGER | 是 | 无 | 2 |
| `lease_owner` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |

外键：
- `session_id` → `file_upload_sessions.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_file_upload_part_leases_1`：`session_id`, `part_number`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE file_upload_part_leases (
 session_id TEXT NOT NULL REFERENCES file_upload_sessions(id), part_number INTEGER NOT NULL,
 lease_owner TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(session_id,part_number)
);
```

## `file_upload_parts`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `session_id` | TEXT | 是 | 无 | 1 |
| `part_number` | INTEGER | 是 | 无 | 2 |
| `etag` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 是 | 无 | 否 |

外键：
- `session_id` → `file_upload_sessions.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_file_upload_parts_1`：`session_id`, `part_number`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE file_upload_parts (
 session_id TEXT NOT NULL REFERENCES file_upload_sessions(id), part_number INTEGER NOT NULL,
 etag TEXT NOT NULL, size_bytes INTEGER NOT NULL, PRIMARY KEY(session_id,part_number)
);
```

## `file_upload_sessions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `file_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `lifecycle_version` | INTEGER | 是 | 无 | 否 |
| `upload_id` | TEXT | 是 | 无 | 否 |
| `r2_key` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 是 | 无 | 否 |
| `part_bytes` | INTEGER | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'uploading' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `operation_token` | TEXT | 否 | 无 | 否 |
| `operation_expires_at` | TEXT | 否 | 无 | 否 |

外键：
- `actor_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `file_id` → `files.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。

索引：
- `file_upload_active`：`file_id`, `lifecycle_version`；唯一；来源 c；部分索引。
- `sqlite_autoindex_file_upload_sessions_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE file_upload_sessions (
 id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id), project_id TEXT NOT NULL REFERENCES projects(id),
 actor_id TEXT NOT NULL REFERENCES users(id), lifecycle_version INTEGER NOT NULL, upload_id TEXT NOT NULL,
 r2_key TEXT NOT NULL, size_bytes INTEGER NOT NULL, part_bytes INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','completing','complete','aborting','aborted')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
, operation_token TEXT, operation_expires_at TEXT);
CREATE UNIQUE INDEX file_upload_active ON file_upload_sessions(file_id,lifecycle_version) WHERE status IN ('uploading','completing','aborting');
```

## `files`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `uploader_user_id` | TEXT | 是 | 无 | 否 |
| `r2_key` | TEXT | 是 | 无 | 否 |
| `mime_declared` | TEXT | 否 | 无 | 否 |
| `mime_detected` | TEXT | 否 | 无 | 否 |
| `ext` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 否 | 无 | 否 |
| `sha256` | TEXT | 否 | 无 | 否 |
| `page_count` | INTEGER | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `gc_after` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `original_name` | TEXT | 是 | '' | 否 |
| `deleted_at` | TEXT | 否 | 无 | 否 |
| `deleted_by` | TEXT | 否 | 无 | 否 |
| `lifecycle_version` | INTEGER | 是 | 1 | 否 |
| `lifecycle_change_id` | TEXT | 否 | 无 | 否 |
| `archived_at` | TEXT | 否 | 无 | 否 |

外键：
- `deleted_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `uploader_user_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 2，顺序 0。

索引：
- `idx_files_recycle`：`project_id`, `deleted_at`, `created_at`, `id`；非唯一；来源 c；非部分索引。
- `idx_files_project_sha`：`project_id`, `sha256`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_files_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploader_user_id TEXT NOT NULL REFERENCES users(id),
  r2_key TEXT NOT NULL,
  mime_declared TEXT,
  mime_detected TEXT,
  ext TEXT NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT,
  page_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'available', 'quarantined', 'discarded')),
  gc_after TEXT,
  created_at TEXT NOT NULL
, original_name TEXT NOT NULL DEFAULT '', deleted_at TEXT, deleted_by TEXT REFERENCES users(id), lifecycle_version INTEGER NOT NULL DEFAULT 1, lifecycle_change_id TEXT, archived_at TEXT);
CREATE INDEX idx_files_recycle ON files(project_id, deleted_at, created_at, id);
CREATE INDEX idx_files_project_sha ON files (project_id, sha256);
```

## `idempotency_records`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `idempotency_key` | TEXT | 是 | 无 | 否 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `operation` | TEXT | 是 | 无 | 否 |
| `request_hash` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'processing' | 否 |
| `response_status` | INTEGER | 否 | 无 | 否 |
| `response_body` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_idempotency_records_1`：`idempotency_key`, `user_id`, `operation`；唯一；来源 u；非部分索引。

```sql
CREATE TABLE idempotency_records (
  idempotency_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  response_status INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (idempotency_key, user_id, operation)
);
```

## `invitations`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `code_hash` | TEXT | 是 | 无 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |
| `max_uses` | INTEGER | 否 | 无 | 否 |
| `used_count` | INTEGER | 是 | 0 | 否 |
| `revoked_at` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `created_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `idx_invitations_project`：`project_id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_invitations_2`：`code_hash`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_invitations_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_invitations_project ON invitations (project_id);
```

## `job_outbox`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `available_at` | TEXT | 是 | 无 | 否 |
| `lease_until` | TEXT | 否 | 无 | 否 |
| `attempts` | INTEGER | 是 | 0 | 否 |
| `last_error` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `job_id` → `jobs.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `idx_outbox_status`：`status`, `available_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_job_outbox_2`：`job_id`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_job_outbox_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE job_outbox (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'done', 'failed')),
  available_at TEXT NOT NULL,
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_outbox_status ON job_outbox (status, available_at);
```

## `jobs`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 否 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'queued' | 否 |
| `input_json` | TEXT | 是 | '{}' | 否 |
| `input_r2_key` | TEXT | 否 | 无 | 否 |
| `result_json` | TEXT | 否 | 无 | 否 |
| `error_json` | TEXT | 否 | 无 | 否 |
| `attempts` | INTEGER | 是 | 0 | 否 |
| `lease_until` | TEXT | 否 | 无 | 否 |
| `created_by` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `finished_at` | TEXT | 否 | 无 | 否 |

外键：
- `created_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `idx_jobs_project_time`：`project_id`, `created_at`；非唯一；来源 c；非部分索引。
- `idx_jobs_status_lease`：`status`, `lease_until`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_jobs_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('parse_source', 'ocr_pages', 'requirement_extract', 'assignment_suggest', 'agent_run', 'review_run', 'rehearsal_turn', 'web_fetch', 'gc')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled')),
  input_json TEXT NOT NULL DEFAULT '{}',
  input_r2_key TEXT,
  result_json TEXT,
  error_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_jobs_project_time ON jobs (project_id, created_at);
CREATE INDEX idx_jobs_status_lease ON jobs (status, lease_until);
```

## `material_versions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `material_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `revision` | INTEGER | 是 | 无 | 否 |
| `doc_json` | TEXT | 是 | 无 | 否 |
| `markdown` | TEXT | 是 | '' | 否 |
| `origin` | TEXT | 是 | 无 | 否 |
| `ai_run_id` | TEXT | 否 | 无 | 否 |
| `author_id` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `attachments_json` | TEXT | 是 | '[]' | 否 |

外键：
- `author_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。
- `material_id` → `materials.id`；ON DELETE CASCADE；复合关系编号 2，顺序 0。

索引：
- `sqlite_autoindex_material_versions_2`：`material_id`, `revision`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_material_versions_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE material_versions (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  doc_json TEXT NOT NULL,
  markdown TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'ai_adoption')),
  ai_run_id TEXT,
  author_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (material_id, revision)
);
```

## `materials`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `title` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 'document' | 否 |
| `current_version_id` | TEXT | 否 | 无 | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `purpose` | TEXT | 是 | 'output' | 否 |
| `is_default_background` | INTEGER | 是 | 0 | 否 |
| `system_managed` | INTEGER | 是 | 0 | 否 |
| `task_id` | TEXT | 否 | 无 | 否 |
| `archived_at` | TEXT | 否 | 无 | 否 |

外键：
- `task_id` → `tasks.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `created_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 2，顺序 0。

索引：
- `idx_materials_task`：`project_id`, `task_id`；非唯一；来源 c；非部分索引。
- `uq_project_system_background`：`project_id`；唯一；来源 c；部分索引。
- `uq_project_default_background`：`project_id`；唯一；来源 c；部分索引。
- `idx_materials_project`：`project_id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_materials_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE materials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'document',
  current_version_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, purpose TEXT NOT NULL DEFAULT 'output'
  CHECK (purpose IN ('background','reference','output')), is_default_background INTEGER NOT NULL DEFAULT 0 CHECK(is_default_background IN (0,1)), system_managed INTEGER NOT NULL DEFAULT 0 CHECK(system_managed IN (0,1)), task_id TEXT REFERENCES tasks(id), archived_at TEXT);
CREATE INDEX idx_materials_task ON materials(project_id,task_id);
CREATE UNIQUE INDEX uq_project_system_background ON materials(project_id) WHERE system_managed=1;
CREATE UNIQUE INDEX uq_project_default_background ON materials(project_id) WHERE is_default_background=1;
CREATE INDEX idx_materials_project ON materials (project_id);
```

## `media_calls`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `config_version_id` | TEXT | 是 | 无 | 否 |
| `model` | TEXT | 是 | 无 | 否 |
| `window_start` | REAL | 是 | 无 | 否 |
| `window_end` | REAL | 否 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `prompt_tokens` | INTEGER | 否 | 无 | 否 |
| `completion_tokens` | INTEGER | 否 | 无 | 否 |
| `cost_usd` | REAL | 否 | 无 | 否 |
| `cost_status` | TEXT | 是 | 'unknown' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `provider` | TEXT | 是 | 'gemini' | 否 |
| `cached_tokens` | INTEGER | 否 | 无 | 否 |
| `audio_tokens` | INTEGER | 否 | 无 | 否 |
| `video_tokens` | INTEGER | 否 | 无 | 否 |

外键：
- `config_version_id` → `ai_config_versions.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `job_id` → `jobs.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_media_calls_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE media_calls (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
  model TEXT NOT NULL,
  window_start REAL NOT NULL,
  window_end REAL,
  status TEXT NOT NULL CHECK(status IN ('started','ok','failed','unknown')),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  cost_status TEXT NOT NULL DEFAULT 'unknown' CHECK(cost_status IN ('known','unknown')),
  created_at TEXT NOT NULL
, provider TEXT NOT NULL DEFAULT 'gemini' CHECK(provider IN ('gemini','mimo')), cached_tokens INTEGER, audio_tokens INTEGER, video_tokens INTEGER);
```

## `media_processing`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `source_version_id` | TEXT | 否 | 无 | 否 |
| `draft_file_id` | TEXT | 否 | 无 | 否 |
| `config_version_id` | TEXT | 是 | 无 | 否 |
| `stage` | TEXT | 是 | 'pending' | 否 |
| `provider_name` | TEXT | 否 | 无 | 否 |
| `provider_uri` | TEXT | 否 | 无 | 否 |
| `duration_seconds` | REAL | 否 | 无 | 否 |
| `windows_json` | TEXT | 是 | '[]' | 否 |
| `summary_json` | TEXT | 否 | 无 | 否 |
| `error` | TEXT | 否 | 无 | 否 |
| `lease_token` | TEXT | 否 | 无 | 否 |
| `lease_expires_at` | TEXT | 否 | 无 | 否 |
| `cleanup_pending` | INTEGER | 是 | 0 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `provider` | TEXT | 是 | 'gemini' | 否 |

外键：
- `config_version_id` → `ai_config_versions.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `draft_file_id` → `creation_draft_files.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `source_version_id` → `source_versions.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。
- `job_id` → `jobs.id`；ON DELETE NO ACTION；复合关系编号 3，顺序 0。

索引：
- `media_cleanup`：`cleanup_pending`, `updated_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_media_processing_2`：`job_id`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_media_processing_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE media_processing (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  source_version_id TEXT REFERENCES source_versions(id),
  draft_file_id TEXT REFERENCES creation_draft_files(id),
  config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
  stage TEXT NOT NULL DEFAULT 'pending' CHECK(stage IN ('pending','uploading','processing','generating','ready','failed')),
  provider_name TEXT,
  provider_uri TEXT,
  duration_seconds REAL,
  windows_json TEXT NOT NULL DEFAULT '[]',
  summary_json TEXT,
  error TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  cleanup_pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'gemini' CHECK(provider IN ('gemini','mimo')),
  CHECK ((source_version_id IS NULL) != (draft_file_id IS NULL))
);
CREATE INDEX media_cleanup ON media_processing(cleanup_pending,updated_at);
```

## `notification_events`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `event_key` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `scope` | TEXT | 是 | 无 | 否 |
| `resource_id` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 否 | 无 | 否 |
| `title` | TEXT | 是 | 无 | 否 |
| `body` | TEXT | 是 | 无 | 否 |
| `url` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `actor_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `notification_events_created`：`created_at`, `id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_notification_events_2`：`event_key`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_notification_events_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE notification_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project','ticket')),
  resource_id TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX notification_events_created ON notification_events(created_at DESC,id DESC);
```

## `notification_inbox`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `event_id` | TEXT | 是 | 无 | 1 |
| `user_id` | TEXT | 是 | 无 | 2 |
| `read_at` | TEXT | 否 | 无 | 否 |
| `dismissed_at` | TEXT | 否 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `event_id` → `notification_events.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。

索引：
- `notification_inbox_user`：`user_id`, `event_id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_notification_inbox_1`：`event_id`, `user_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE notification_inbox (
  event_id TEXT NOT NULL REFERENCES notification_events(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  read_at TEXT,
  dismissed_at TEXT,
  PRIMARY KEY (event_id,user_id)
);
CREATE INDEX notification_inbox_user ON notification_inbox(user_id,event_id);
```

## `notification_push_outbox`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `event_id` | TEXT | 是 | 无 | 1 |
| `subscription_id` | TEXT | 是 | 无 | 2 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `attempts` | INTEGER | 是 | 0 | 否 |
| `available_at` | TEXT | 是 | 无 | 否 |
| `lease_until` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `subscription_id` → `push_subscriptions.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `event_id` → `notification_events.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。

索引：
- `notification_push_due`：`status`, `available_at`, `lease_until`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_notification_push_outbox_1`：`event_id`, `subscription_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE notification_push_outbox (
  event_id TEXT NOT NULL REFERENCES notification_events(id),
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','cancelled','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(event_id,subscription_id)
);
CREATE INDEX notification_push_due ON notification_push_outbox(status,available_at,lease_until);
```

## `notification_settings`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `user_id` | TEXT | 否 | 无 | 1 |
| `in_app_enabled` | INTEGER | 是 | 1 | 否 |
| `push_enabled` | INTEGER | 是 | 1 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_notification_settings_1`：`user_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE notification_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  in_app_enabled INTEGER NOT NULL DEFAULT 1 CHECK (in_app_enabled IN (0,1)),
  push_enabled INTEGER NOT NULL DEFAULT 1 CHECK (push_enabled IN (0,1)),
  updated_at TEXT NOT NULL
);
```

## `ocr_model_capabilities`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `endpoint_model_hash` | TEXT | 否 | 无 | 1 |
| `single_image_only` | INTEGER | 是 | 1 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
无。

索引：
- `sqlite_autoindex_ocr_model_capabilities_1`：`endpoint_model_hash`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE ocr_model_capabilities (
  endpoint_model_hash TEXT PRIMARY KEY,
  single_image_only INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
```

## `personal_profile_import_candidates`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `source_project_id` | TEXT | 是 | 无 | 否 |
| `source_project_name` | TEXT | 是 | 无 | 否 |
| `major` | TEXT | 是 | 无 | 否 |
| `skills_json` | TEXT | 是 | 无 | 否 |
| `hours_per_week` | REAL | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `imported_at` | TEXT | 否 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `idx_profile_import_owner`：`user_id`, `created_at`, `id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_personal_profile_import_candidates_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE personal_profile_import_candidates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_project_id TEXT NOT NULL,
  source_project_name TEXT NOT NULL,
  major TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  hours_per_week REAL,
  created_at TEXT NOT NULL,
  imported_at TEXT
);
CREATE INDEX idx_profile_import_owner ON personal_profile_import_candidates(user_id,created_at,id);
```

## `personal_profiles`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `user_id` | TEXT | 否 | 无 | 1 |
| `searchable` | INTEGER | 是 | 0 | 否 |
| `bio` | TEXT | 是 | '' | 否 |
| `major` | TEXT | 是 | '' | 否 |
| `specialties` | TEXT | 是 | '' | 否 |
| `preferred_roles` | TEXT | 是 | '' | 否 |
| `bio_public` | INTEGER | 是 | 0 | 否 |
| `major_public` | INTEGER | 是 | 0 | 否 |
| `specialties_public` | INTEGER | 是 | 0 | 否 |
| `preferred_roles_public` | INTEGER | 是 | 0 | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `ai_use_allowed` | INTEGER | 是 | 0 | 否 |
| `weekly_available_hours` | REAL | 否 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_personal_profiles_1`：`user_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE personal_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  searchable INTEGER NOT NULL DEFAULT 0 CHECK(searchable IN (0,1)),
  bio TEXT NOT NULL DEFAULT '',
  major TEXT NOT NULL DEFAULT '',
  specialties TEXT NOT NULL DEFAULT '',
  preferred_roles TEXT NOT NULL DEFAULT '',
  bio_public INTEGER NOT NULL DEFAULT 0 CHECK(bio_public IN (0,1)),
  major_public INTEGER NOT NULL DEFAULT 0 CHECK(major_public IN (0,1)),
  specialties_public INTEGER NOT NULL DEFAULT 0 CHECK(specialties_public IN (0,1)),
  preferred_roles_public INTEGER NOT NULL DEFAULT 0 CHECK(preferred_roles_public IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
, ai_use_allowed INTEGER NOT NULL DEFAULT 0 CHECK(ai_use_allowed IN (0,1)), weekly_available_hours REAL
  CHECK (weekly_available_hours IS NULL OR (weekly_available_hours >= 0 AND weekly_available_hours <= 168)));
```

## `project_admin_feedback`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `target_type` | TEXT | 是 | 无 | 否 |
| `target_id` | TEXT | 否 | 无 | 否 |
| `feedback` | TEXT | 是 | 无 | 否 |
| `request_ai_redo` | INTEGER | 是 | 0 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `actor_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。

索引：
- `idx_project_admin_feedback_project`：`project_id`, `created_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_project_admin_feedback_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE project_admin_feedback (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 actor_id TEXT NOT NULL REFERENCES users(id), target_type TEXT NOT NULL,
 target_id TEXT, feedback TEXT NOT NULL, request_ai_redo INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE INDEX idx_project_admin_feedback_project ON project_admin_feedback(project_id,created_at);
```

## `project_creation_drafts`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `owner_id` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'active' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `payload_json` | TEXT | 是 | 无 | 否 |
| `preview_json` | TEXT | 否 | 无 | 否 |
| `preview_revision` | INTEGER | 否 | 无 | 否 |
| `preview_state` | TEXT | 是 | 'none' | 否 |
| `preview_attempt_id` | TEXT | 否 | 无 | 否 |
| `preview_error` | TEXT | 否 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `commit_token` | TEXT | 否 | 无 | 否 |
| `result_encrypted` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `preview_waiting_id` | TEXT | 否 | 无 | 否 |
| `preview_config_version_id` | TEXT | 否 | 无 | 否 |

外键：
- `preview_config_version_id` → `ai_config_versions.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `owner_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。

索引：
- `idx_creation_drafts_owner`：`owner_id`, `updated_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_project_creation_drafts_2`：`project_id`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_project_creation_drafts_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE project_creation_drafts (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','committed')),
 revision INTEGER NOT NULL DEFAULT 1,
 payload_json TEXT NOT NULL,
 preview_json TEXT,
 preview_revision INTEGER,
 preview_state TEXT NOT NULL DEFAULT 'none' CHECK(preview_state IN ('none','running','ready','failed')),
 preview_attempt_id TEXT,
 preview_error TEXT,
 project_id TEXT NOT NULL UNIQUE,
 commit_token TEXT,
 result_encrypted TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
, preview_waiting_id TEXT, preview_config_version_id TEXT REFERENCES ai_config_versions(id));
CREATE INDEX idx_creation_drafts_owner ON project_creation_drafts(owner_id,updated_at);
```

## `project_feedback_versions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `version` | INTEGER | 是 | 无 | 否 |
| `feedback` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `actor_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_project_feedback_versions_2`：`project_id`, `version`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_project_feedback_versions_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE project_feedback_versions (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 version INTEGER NOT NULL,
 feedback TEXT NOT NULL,
 actor_id TEXT REFERENCES users(id),
 created_at TEXT NOT NULL,
 UNIQUE(project_id,version)
);
```

## `project_goals`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `project_id` | TEXT | 否 | 无 | 1 |
| `title` | TEXT | 是 | 无 | 否 |
| `detail` | TEXT | 是 | '' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `graph_revision` | INTEGER | 是 | 1 | 否 |
| `graph_token` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_project_goals_1`：`project_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE project_goals (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 1, graph_revision INTEGER NOT NULL DEFAULT 1,
 graph_token TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

## `project_invitation_requests`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `requested_by` | TEXT | 是 | 无 | 否 |
| `username` | TEXT | 是 | 无 | 否 |
| `expires_in_days` | INTEGER | 是 | 7 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `decided_by` | TEXT | 否 | 无 | 否 |
| `invitation_id` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `decided_at` | TEXT | 否 | 无 | 否 |

外键：
- `decided_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `requested_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `project_id` → `projects.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。

索引：
- `invitation_request_pending`：`project_id`, `requested_by`, `username`；唯一；来源 c；部分索引。
- `sqlite_autoindex_project_invitation_requests_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE project_invitation_requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),requested_by TEXT NOT NULL REFERENCES users(id),username TEXT NOT NULL,expires_in_days INTEGER NOT NULL DEFAULT 7,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),revision INTEGER NOT NULL DEFAULT 1,decided_by TEXT REFERENCES users(id),invitation_id TEXT,created_at TEXT NOT NULL,decided_at TEXT);
CREATE UNIQUE INDEX invitation_request_pending ON project_invitation_requests(project_id,requested_by,username) WHERE status='pending';
```

## `project_members`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `role` | TEXT | 是 | 无 | 否 |
| `skills_json` | TEXT | 是 | '[]' | 否 |
| `hours_per_week` | REAL | 否 | 无 | 否 |
| `joined_at` | TEXT | 是 | 无 | 否 |
| `major` | TEXT | 是 | '' | 否 |
| `permissions_json` | TEXT | 是 | '{"teamManage":false,"taskManage":false,"resourceManage":false,"scoreInitiate":true}' | 否 |
| `permissions_revision` | INTEGER | 是 | 1 | 否 |

外键：
- `user_id` → `users.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `uq_project_members`：`project_id`, `user_id`；唯一；来源 c；非部分索引。
- `sqlite_autoindex_project_members_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE project_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  skills_json TEXT NOT NULL DEFAULT '[]',
  hours_per_week REAL,
  joined_at TEXT NOT NULL
, major TEXT NOT NULL DEFAULT '', permissions_json TEXT NOT NULL DEFAULT '{"teamManage":false,"taskManage":false,"resourceManage":false,"scoreInitiate":true}' CHECK(json_valid(permissions_json)), permissions_revision INTEGER NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX uq_project_members ON project_members (project_id, user_id);
```

## `project_progression`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `project_id` | TEXT | 否 | 无 | 1 |
| `observed_event_at` | TEXT | 是 | '' | 否 |
| `observed_event_id` | TEXT | 是 | '' | 否 |
| `pending_job_id` | TEXT | 否 | 无 | 否 |
| `pending_event_at` | TEXT | 否 | 无 | 否 |
| `pending_event_id` | TEXT | 否 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_project_progression_1`：`project_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE project_progression (
 project_id TEXT PRIMARY KEY REFERENCES projects(id),
 observed_event_at TEXT NOT NULL DEFAULT '',
 observed_event_id TEXT NOT NULL DEFAULT '',
 pending_job_id TEXT,
 pending_event_at TEXT, pending_event_id TEXT,
 updated_at TEXT NOT NULL
);
```

## `project_username_invitations`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `recipient_id` | TEXT | 是 | 无 | 否 |
| `username` | TEXT | 是 | 无 | 否 |
| `invited_by` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |
| `handled_at` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `invited_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `recipient_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `project_id` → `projects.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。

索引：
- `idx_username_invite_recipient`：`recipient_id`, `created_at`；非唯一；来源 c；非部分索引。
- `idx_pending_username_invite`：`project_id`, `recipient_id`；唯一；来源 c；部分索引。
- `sqlite_autoindex_project_username_invitations_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE project_username_invitations (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 recipient_id TEXT NOT NULL REFERENCES users(id),
 username TEXT NOT NULL,
 invited_by TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','revoked','expired')),
 expires_at TEXT NOT NULL,
 handled_at TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX idx_username_invite_recipient ON project_username_invitations(recipient_id,created_at);
CREATE UNIQUE INDEX idx_pending_username_invite ON project_username_invitations(project_id,recipient_id) WHERE status='pending';
```

## `projects`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `name` | TEXT | 是 | 无 | 否 |
| `description` | TEXT | 是 | '' | 否 |
| `competition_deadline_date` | TEXT | 否 | 无 | 否 |
| `deadline_precision` | TEXT | 是 | 'unknown' | 否 |
| `team_size_limit` | INTEGER | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'active' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `ai_budget_usd` | REAL | 否 | 无 | 否 |
| `assignment_mode` | TEXT | 是 | 'manual' | 否 |
| `evaluation_mode` | TEXT | 是 | 'manual' | 否 |
| `collaboration_revision` | INTEGER | 是 | 1 | 否 |
| `collaboration_mutation_token` | TEXT | 否 | 无 | 否 |
| `ai_collaboration_enabled` | INTEGER | 是 | 0 | 否 |
| `planning_mode` | TEXT | 是 | 'manual' | 否 |
| `progression_mode` | TEXT | 是 | 'manual' | 否 |

外键：
- `created_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_projects_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  competition_deadline_date TEXT,
  deadline_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (deadline_precision IN ('date', 'datetime', 'unknown')),
  team_size_limit INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, ai_budget_usd REAL, assignment_mode TEXT NOT NULL DEFAULT 'manual' CHECK (assignment_mode IN ('manual','automatic')), evaluation_mode TEXT NOT NULL DEFAULT 'manual' CHECK (evaluation_mode IN ('manual','automatic')), collaboration_revision INTEGER NOT NULL DEFAULT 1, collaboration_mutation_token TEXT, ai_collaboration_enabled INTEGER NOT NULL DEFAULT 0 CHECK(ai_collaboration_enabled IN (0,1)), planning_mode TEXT NOT NULL DEFAULT 'manual' CHECK(planning_mode IN ('manual','automatic')), progression_mode TEXT NOT NULL DEFAULT 'manual' CHECK(progression_mode IN ('manual','automatic')));
```

## `push_subscriptions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `session_hash` | TEXT | 是 | 无 | 否 |
| `endpoint` | TEXT | 是 | 无 | 否 |
| `p256dh` | TEXT | 是 | 无 | 否 |
| `auth` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `disabled_at` | TEXT | 否 | 无 | 否 |
| `disabled_reason` | TEXT | 否 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `push_subscriptions_user`：`user_id`, `disabled_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_push_subscriptions_2`：`endpoint`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_push_subscriptions_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  disabled_reason TEXT
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id,disabled_at);
```

## `rehearsal_speech`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `rehearsal_id` | TEXT | 是 | 无 | 否 |
| `turn_id` | TEXT | 是 | 无 | 否 |
| `sequence` | INTEGER | 是 | 无 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `content_hash` | TEXT | 是 | 无 | 否 |
| `config_version_id` | TEXT | 是 | 无 | 否 |
| `model` | TEXT | 是 | 无 | 否 |
| `voice` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `lease_token` | TEXT | 否 | 无 | 否 |
| `lease_expires_at` | TEXT | 否 | 无 | 否 |
| `dispatched_at` | TEXT | 否 | 无 | 否 |
| `r2_key` | TEXT | 否 | 无 | 否 |
| `mime` | TEXT | 否 | 无 | 否 |
| `duration_seconds` | REAL | 否 | 无 | 否 |
| `error` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `config_version_id` → `ai_config_versions.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `created_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `turn_id` → `rehearsal_turns.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。
- `rehearsal_id` → `rehearsals.id`；ON DELETE NO ACTION；复合关系编号 3，顺序 0。
- `project_id` → `projects.id`；ON DELETE NO ACTION；复合关系编号 4，顺序 0。

索引：
- `rehearsal_speech_job`：`job_id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_rehearsal_speech_2`：`turn_id`, `content_hash`, `config_version_id`, `model`, `voice`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_rehearsal_speech_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE rehearsal_speech (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 rehearsal_id TEXT NOT NULL REFERENCES rehearsals(id),
 turn_id TEXT NOT NULL REFERENCES rehearsal_turns(id),
 sequence INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 content_hash TEXT NOT NULL,
 config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
 model TEXT NOT NULL,
 voice TEXT NOT NULL,
 -- Mutable retry pointer. A row is inserted before its job/outbox batch.
 job_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
 lease_token TEXT,
 lease_expires_at TEXT,
 dispatched_at TEXT,
 r2_key TEXT,
 mime TEXT,
 duration_seconds REAL,
 error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(turn_id,content_hash,config_version_id,model,voice)
);
CREATE INDEX rehearsal_speech_job ON rehearsal_speech(job_id);
```

## `rehearsal_turns`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `rehearsal_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `sequence` | INTEGER | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `content_json` | TEXT | 是 | '{}' | 否 |
| `run_id` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `author_id` | TEXT | 否 | 无 | 否 |

外键：
- `author_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。
- `rehearsal_id` → `rehearsals.id`；ON DELETE CASCADE；复合关系编号 2，顺序 0。

索引：
- `sqlite_autoindex_rehearsal_turns_2`：`rehearsal_id`, `sequence`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_rehearsal_turns_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE rehearsal_turns (
  id TEXT PRIMARY KEY,
  rehearsal_id TEXT NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('question', 'answer', 'followup', 'summary')),
  content_json TEXT NOT NULL DEFAULT '{}',
  run_id TEXT,
  created_at TEXT NOT NULL, author_id TEXT REFERENCES users(id),
  UNIQUE (rehearsal_id, sequence)
);
```

## `rehearsal_voice_sessions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `rehearsal_id` | TEXT | 是 | 无 | 否 |
| `question_sequence` | INTEGER | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `config_version_id` | TEXT | 是 | 无 | 否 |
| `model` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `cost_status` | TEXT | 是 | 'unknown' | 否 |
| `cost_usd` | REAL | 否 | 无 | 否 |
| `root_session_id` | TEXT | 是 | 无 | 否 |
| `retry_number` | INTEGER | 是 | 0 | 否 |
| `transcript_text` | TEXT | 是 | '' | 否 |
| `audio_bytes` | INTEGER | 是 | 0 | 否 |
| `audio_frames` | INTEGER | 是 | 0 | 否 |
| `event_sequence` | INTEGER | 是 | 0 | 否 |
| `duration_seconds` | REAL | 否 | 无 | 否 |
| `started_at` | TEXT | 否 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |
| `finished_at` | TEXT | 否 | 无 | 否 |
| `error_code` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `rehearsal_id` → `rehearsal_turns.rehearsal_id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `question_sequence` → `rehearsal_turns.sequence`；ON DELETE NO ACTION；复合关系编号 0，顺序 1。
- `config_version_id` → `ai_config_versions.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `actor_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。
- `rehearsal_id` → `rehearsals.id`；ON DELETE CASCADE；复合关系编号 3，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 4，顺序 0。

索引：
- `rehearsal_voice_retry_number`：`root_session_id`, `retry_number`；唯一；来源 c；非部分索引。
- `rehearsal_voice_expiry`：`status`, `expires_at`；非唯一；来源 c；非部分索引。
- `rehearsal_voice_active`：`rehearsal_id`；唯一；来源 c；部分索引。
- `sqlite_autoindex_rehearsal_voice_sessions_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE rehearsal_voice_sessions (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 rehearsal_id TEXT NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
 question_sequence INTEGER NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id),
 config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
 model TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','connecting','open','succeeded','failed','closed','expired')),
 cost_status TEXT NOT NULL DEFAULT 'unknown' CHECK(cost_status='unknown'),
 cost_usd REAL,
 root_session_id TEXT NOT NULL,
 retry_number INTEGER NOT NULL DEFAULT 0 CHECK(retry_number BETWEEN 0 AND 3),
 transcript_text TEXT NOT NULL DEFAULT '',
 audio_bytes INTEGER NOT NULL DEFAULT 0,
 audio_frames INTEGER NOT NULL DEFAULT 0,
 event_sequence INTEGER NOT NULL DEFAULT 0,
 duration_seconds REAL,
 started_at TEXT,
 expires_at TEXT NOT NULL,
 finished_at TEXT,
 error_code TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(rehearsal_id,question_sequence) REFERENCES rehearsal_turns(rehearsal_id,sequence),
 CHECK(cost_usd IS NULL)
);
CREATE UNIQUE INDEX rehearsal_voice_retry_number ON rehearsal_voice_sessions(root_session_id,retry_number);
CREATE INDEX rehearsal_voice_expiry ON rehearsal_voice_sessions(status,expires_at);
CREATE UNIQUE INDEX rehearsal_voice_active ON rehearsal_voice_sessions(rehearsal_id) WHERE status IN ('reserved','connecting','open');
```

## `rehearsals`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `scope` | TEXT | 是 | 无 | 否 |
| `member_id` | TEXT | 否 | 无 | 否 |
| `material_version_ids_json` | TEXT | 是 | '[]' | 否 |
| `status` | TEXT | 是 | 'active' | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `finished_at` | TEXT | 否 | 无 | 否 |
| `finish_job_id` | TEXT | 否 | 无 | 否 |
| `finish_snapshot_json` | TEXT | 否 | 无 | 否 |
| `processing_job_id` | TEXT | 否 | 无 | 否 |
| `reference_inputs_json` | TEXT | 是 | '{}' | 否 |

外键：
- `created_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `member_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 2，顺序 0。

索引：
- `sqlite_autoindex_rehearsals_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE rehearsals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('all', 'member')),
  member_id TEXT REFERENCES users(id),
  material_version_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  finished_at TEXT
, finish_job_id TEXT, finish_snapshot_json TEXT, processing_job_id TEXT, reference_inputs_json TEXT NOT NULL DEFAULT '{}');
```

## `requirement_sets`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `source_version_id` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'draft' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `confirmed_by` | TEXT | 否 | 无 | 否 |
| `confirmed_at` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `confirmed_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `source_version_id` → `source_versions.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 2，顺序 0。

索引：
- `idx_requirement_sets_project`：`project_id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_requirement_sets_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE requirement_sets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_version_id TEXT REFERENCES source_versions(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  revision INTEGER NOT NULL DEFAULT 1,
  confirmed_by TEXT REFERENCES users(id),
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_requirement_sets_project ON requirement_sets (project_id);
```

## `requirements`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `requirement_set_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `seq` | INTEGER | 是 | 无 | 否 |
| `category` | TEXT | 是 | 无 | 否 |
| `title` | TEXT | 是 | 无 | 否 |
| `detail` | TEXT | 是 | '' | 否 |
| `due_date` | TEXT | 否 | 无 | 否 |
| `due_precision` | TEXT | 是 | 'unknown' | 否 |
| `citations_json` | TEXT | 是 | '[]' | 否 |
| `field_state` | TEXT | 是 | 'ai_suggestion' | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。
- `requirement_set_id` → `requirement_sets.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_requirements_2`：`requirement_set_id`, `seq`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_requirements_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE requirements (
  id TEXT PRIMARY KEY,
  requirement_set_id TEXT NOT NULL REFERENCES requirement_sets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('deadline', 'deliverable', 'format', 'scoring', 'team', 'other')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  due_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (due_precision IN ('date', 'datetime', 'unknown')),
  citations_json TEXT NOT NULL DEFAULT '[]',
  field_state TEXT NOT NULL DEFAULT 'ai_suggestion' CHECK (field_state IN ('ai_suggestion', 'edited', 'confirmed')),
  updated_at TEXT NOT NULL,
  UNIQUE (requirement_set_id, seq)
);
```

## `resource_index_blocks`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `resource_type` | TEXT | 是 | 无 | 否 |
| `version_id` | TEXT | 是 | 无 | 否 |
| `seq` | INTEGER | 是 | 无 | 否 |
| `fragment_id` | TEXT | 否 | 无 | 否 |
| `page_number` | INTEGER | 否 | 无 | 否 |
| `heading` | TEXT | 是 | '' | 否 |
| `start_offset` | INTEGER | 是 | 无 | 否 |
| `end_offset` | INTEGER | 是 | 无 | 否 |
| `content` | TEXT | 是 | 无 | 否 |
| `search_content` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `idx_resource_blocks_version`：`project_id`, `resource_type`, `version_id`, `seq`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_resource_index_blocks_2`：`project_id`, `resource_type`, `version_id`, `seq`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_resource_index_blocks_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE resource_index_blocks (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 resource_type TEXT NOT NULL,
 version_id TEXT NOT NULL,
 seq INTEGER NOT NULL,
 fragment_id TEXT,
 page_number INTEGER,
 heading TEXT NOT NULL DEFAULT '',
 start_offset INTEGER NOT NULL,
 end_offset INTEGER NOT NULL,
 content TEXT NOT NULL,
 search_content TEXT NOT NULL,
 UNIQUE(project_id,resource_type,version_id,seq)
);
CREATE INDEX idx_resource_blocks_version ON resource_index_blocks(project_id,resource_type,version_id,seq);
```

## `resource_index_fts`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `content` |  | 否 | 无 | 否 |
| `block_id` |  | 否 | 无 | 否 |

外键：
无。

索引：
无。

```sql
CREATE VIRTUAL TABLE resource_index_fts USING fts5(content, block_id UNINDEXED, tokenize='trigram');
```

## `resource_index_fts_config`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `k` |  | 是 | 无 | 1 |
| `v` |  | 否 | 无 | 否 |

外键：
无。

索引：
- `sqlite_autoindex_resource_index_fts_config_1`：`k`；唯一；来源 pk；非部分索引。

本表由 FTS5 虚拟表自动创建和维护，不单独执行 DDL。

## `resource_index_fts_content`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `c0` |  | 否 | 无 | 否 |
| `c1` |  | 否 | 无 | 否 |

外键：
无。

索引：
无。

本表由 FTS5 虚拟表自动创建和维护，不单独执行 DDL。

## `resource_index_fts_data`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `block` | BLOB | 否 | 无 | 否 |

外键：
无。

索引：
无。

本表由 FTS5 虚拟表自动创建和维护，不单独执行 DDL。

## `resource_index_fts_docsize`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `sz` | BLOB | 否 | 无 | 否 |

外键：
无。

索引：
无。

本表由 FTS5 虚拟表自动创建和维护，不单独执行 DDL。

## `resource_index_fts_idx`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `segid` |  | 是 | 无 | 1 |
| `term` |  | 是 | 无 | 2 |
| `pgno` |  | 否 | 无 | 否 |

外键：
无。

索引：
- `sqlite_autoindex_resource_index_fts_idx_1`：`segid`, `term`；唯一；来源 pk；非部分索引。

本表由 FTS5 虚拟表自动创建和维护，不单独执行 DDL。

## `resource_index_state`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `project_id` | TEXT | 是 | 无 | 1 |
| `resource_type` | TEXT | 是 | 无 | 2 |
| `version_id` | TEXT | 是 | 无 | 3 |
| `cursor` | INTEGER | 是 | 0 | 否 |
| `source_seq` | INTEGER | 是 | 0 | 否 |
| `source_offset` | INTEGER | 是 | 0 | 否 |
| `next_seq` | INTEGER | 是 | 0 | 否 |
| `heading` | TEXT | 是 | '' | 否 |
| `status` | TEXT | 是 | 'building' | 否 |

外键：
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_resource_index_state_1`：`project_id`, `resource_type`, `version_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE resource_index_state (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 resource_type TEXT NOT NULL CHECK(resource_type IN ('source','material')),
 version_id TEXT NOT NULL,
 cursor INTEGER NOT NULL DEFAULT 0,
 source_seq INTEGER NOT NULL DEFAULT 0,
 source_offset INTEGER NOT NULL DEFAULT 0,
 next_seq INTEGER NOT NULL DEFAULT 0,
 heading TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'building' CHECK(status IN ('building','ready')),
 PRIMARY KEY(project_id,resource_type,version_id)
);
```

## `reviews`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `requirement_set_id` | TEXT | 是 | 无 | 否 |
| `rubric_version_id` | TEXT | 是 | 无 | 否 |
| `material_version_ids_json` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `report_json` | TEXT | 否 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `created_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `rubric_version_id` → `rubric_versions.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `requirement_set_id` → `requirement_sets.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 3，顺序 0。

索引：
- `idx_reviews_project`：`project_id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_reviews_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_set_id TEXT NOT NULL REFERENCES requirement_sets(id),
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  material_version_ids_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  report_json TEXT,
  job_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_reviews_project ON reviews (project_id);
```

## `rubric_versions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `version` | INTEGER | 是 | 无 | 否 |
| `source` | TEXT | 是 | 无 | 否 |
| `weights_json` | TEXT | 是 | 无 | 否 |
| `notes` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'draft' | 否 |
| `confirmed_by` | TEXT | 否 | 无 | 否 |
| `confirmed_at` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `confirmed_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_rubric_versions_2`：`project_id`, `version`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_rubric_versions_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE rubric_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('official', 'custom')),
  weights_json TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  confirmed_by TEXT REFERENCES users(id),
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, version)
);
```

## `sessions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `token_hash` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |
| `revoked_at` | TEXT | 否 | 无 | 否 |
| `last_seen_at` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `auth_method` | TEXT | 是 | 'legacy' | 否 |

外键：
- `user_id` → `users.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `idx_sessions_user`：`user_id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_sessions_2`：`token_hash`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_sessions_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
, auth_method TEXT NOT NULL DEFAULT 'legacy' CHECK (auth_method IN ('legacy', 'password')));
CREATE INDEX idx_sessions_user ON sessions (user_id);
```

## `source_fragments`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `source_version_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `page_number` | INTEGER | 否 | 无 | 否 |
| `seq` | INTEGER | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `content` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `heading_path` | TEXT | 否 | 无 | 否 |
| `extraction_session_id` | TEXT | 否 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。
- `source_version_id` → `source_versions.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `idx_source_fragments_stream`：`source_version_id`, `project_id`, `seq`, `id`；非唯一；来源 c；非部分索引。
- `idx_source_fragments_page`：`source_version_id`, `page_number`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_source_fragments_2`：`source_version_id`, `seq`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_source_fragments_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE source_fragments (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_number INTEGER,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'ocr', 'web', 'paste')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL, heading_path TEXT, extraction_session_id TEXT,
  UNIQUE (source_version_id, seq)
);
CREATE INDEX idx_source_fragments_stream ON source_fragments(source_version_id,project_id,seq,id);
CREATE INDEX idx_source_fragments_page ON source_fragments (source_version_id, page_number);
```

## `source_ocr_batches`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `source_version_id` | TEXT | 是 | 无 | 否 |
| `lifecycle_version` | INTEGER | 是 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `page_numbers_json` | TEXT | 是 | 无 | 否 |
| `model` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `context_chars` | INTEGER | 是 | 0 | 否 |
| `prompt_tokens` | INTEGER | 否 | 无 | 否 |
| `completion_tokens` | INTEGER | 否 | 无 | 否 |
| `error_code` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `job_id` → `jobs.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `source_version_id` → `source_versions.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。

索引：
- `source_ocr_batches_version`：`source_version_id`, `created_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_source_ocr_batches_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE source_ocr_batches (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id),
  lifecycle_version INTEGER NOT NULL,
  job_id TEXT REFERENCES jobs(id),
  page_numbers_json TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('dispatched','ok','partial','failed','rejected')),
  context_chars INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX source_ocr_batches_version ON source_ocr_batches(source_version_id, created_at);
```

## `source_pages`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `source_version_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `page_number` | INTEGER | 是 | 无 | 否 |
| `text_status` | TEXT | 是 | 'none' | 否 |
| `image_file_id` | TEXT | 否 | 无 | 否 |
| `image_status` | TEXT | 是 | 'none' | 否 |
| `ocr_status` | TEXT | 是 | 'none' | 否 |
| `ocr_method` | TEXT | 否 | 无 | 否 |
| `ocr_confidence` | REAL | 否 | 无 | 否 |
| `needs_review` | INTEGER | 是 | 0 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `image_file_id` → `files.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。
- `source_version_id` → `source_versions.id`；ON DELETE CASCADE；复合关系编号 2，顺序 0。

索引：
- `sqlite_autoindex_source_pages_2`：`source_version_id`, `page_number`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_source_pages_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE source_pages (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  text_status TEXT NOT NULL DEFAULT 'none' CHECK (text_status IN ('none', 'extracted', 'empty')),
  image_file_id TEXT REFERENCES files(id),
  image_status TEXT NOT NULL DEFAULT 'none' CHECK (image_status IN ('none', 'uploaded', 'rejected')),
  ocr_status TEXT NOT NULL DEFAULT 'none' CHECK (ocr_status IN ('none', 'pending', 'ok', 'failed')),
  ocr_method TEXT,
  ocr_confidence REAL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (source_version_id, page_number)
);
```

## `source_processing`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `source_version_id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `text_status` | TEXT | 是 | 'pending' | 否 |
| `requirements_status` | TEXT | 是 | 'pending' | 否 |
| `requirements_error` | TEXT | 否 | 无 | 否 |
| `summary_status` | TEXT | 是 | 'pending' | 否 |
| `summary_json` | TEXT | 否 | 无 | 否 |
| `summary_error` | TEXT | 否 | 无 | 否 |
| `summary_job_id` | TEXT | 否 | 无 | 否 |
| `summary_revision` | INTEGER | 是 | 0 | 否 |
| `covered_chars` | INTEGER | 否 | 无 | 否 |
| `total_chars` | INTEGER | 否 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。
- `source_version_id` → `source_versions.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_source_processing_1`：`source_version_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE source_processing (
  source_version_id TEXT PRIMARY KEY REFERENCES source_versions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text_status TEXT NOT NULL DEFAULT 'pending' CHECK (text_status IN ('pending','processing','waiting_input','ready','failed')),
  requirements_status TEXT NOT NULL DEFAULT 'pending' CHECK (requirements_status IN ('pending','processing','ready','failed')),
  requirements_error TEXT,
  summary_status TEXT NOT NULL DEFAULT 'pending' CHECK (summary_status IN ('pending','queued','running','ready','failed','cancelled')),
  summary_json TEXT,
  summary_error TEXT,
  summary_job_id TEXT,
  summary_revision INTEGER NOT NULL DEFAULT 0,
  covered_chars INTEGER,
  total_chars INTEGER,
  updated_at TEXT NOT NULL
);
```

## `source_versions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `source_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `revision` | INTEGER | 是 | 无 | 否 |
| `origin` | TEXT | 是 | 无 | 否 |
| `file_id` | TEXT | 否 | 无 | 否 |
| `url` | TEXT | 否 | 无 | 否 |
| `text_r2_key` | TEXT | 否 | 无 | 否 |
| `char_count` | INTEGER | 否 | 无 | 否 |
| `page_count` | INTEGER | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `parse_error` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `ai_config_version_id` | TEXT | 否 | 无 | 否 |
| `extraction_method` | TEXT | 否 | 无 | 否 |
| `extraction_warnings_json` | TEXT | 是 | '[]' | 否 |
| `extraction_coverage` | TEXT | 否 | 无 | 否 |

外键：
- `ai_config_version_id` → `ai_config_versions.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `file_id` → `files.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 2，顺序 0。
- `source_id` → `sources.id`；ON DELETE CASCADE；复合关系编号 3，顺序 0。

索引：
- `sqlite_autoindex_source_versions_2`：`source_id`, `revision`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_source_versions_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE source_versions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('file', 'web', 'paste')),
  file_id TEXT REFERENCES files(id),
  url TEXT,
  text_r2_key TEXT,
  char_count INTEGER,
  page_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  parse_error TEXT,
  created_at TEXT NOT NULL, ai_config_version_id TEXT REFERENCES ai_config_versions(id), extraction_method TEXT, extraction_warnings_json TEXT NOT NULL DEFAULT '[]', extraction_coverage TEXT,
  UNIQUE (source_id, revision)
);
```

## `sources`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `title` | TEXT | 是 | 无 | 否 |
| `url` | TEXT | 否 | 无 | 否 |
| `current_version_id` | TEXT | 否 | 无 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `deleted_at` | TEXT | 否 | 无 | 否 |
| `deleted_by` | TEXT | 否 | 无 | 否 |
| `deleted_via_file_id` | TEXT | 否 | 无 | 否 |
| `lifecycle_version` | INTEGER | 是 | 1 | 否 |
| `lifecycle_change_id` | TEXT | 否 | 无 | 否 |
| `purpose` | TEXT | 是 | 'reference' | 否 |
| `resource_revision` | INTEGER | 是 | 1 | 否 |

外键：
- `deleted_via_file_id` → `files.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `deleted_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `created_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 3，顺序 0。

索引：
- `idx_sources_recycle`：`project_id`, `deleted_at`, `created_at`, `id`；非唯一；来源 c；非部分索引。
- `idx_sources_project`：`project_id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_sources_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'web', 'paste')),
  title TEXT NOT NULL,
  url TEXT,
  current_version_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, deleted_at TEXT, deleted_by TEXT REFERENCES users(id), deleted_via_file_id TEXT REFERENCES files(id), lifecycle_version INTEGER NOT NULL DEFAULT 1, lifecycle_change_id TEXT, purpose TEXT NOT NULL DEFAULT 'reference'
  CHECK (purpose IN ('background','reference','output')), resource_revision INTEGER NOT NULL DEFAULT 1);
CREATE INDEX idx_sources_recycle ON sources(project_id, deleted_at, created_at, id);
CREATE INDEX idx_sources_project ON sources (project_id);
```

## `standards_versions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `version` | INTEGER | 是 | 无 | 否 |
| `title` | TEXT | 是 | '' | 否 |
| `status` | TEXT | 是 | 'draft' | 否 |
| `requirement_set_ids_json` | TEXT | 是 | '[]' | 否 |
| `rubric_version_id` | TEXT | 是 | 无 | 否 |
| `mappings_json` | TEXT | 是 | '[]' | 否 |
| `snapshot_json` | TEXT | 否 | 无 | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `confirmed_by` | TEXT | 否 | 无 | 否 |
| `confirmed_at` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `confirmed_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `rubric_version_id` → `rubric_versions.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 2，顺序 0。

索引：
- `sqlite_autoindex_standards_versions_2`：`project_id`, `version`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_standards_versions_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE standards_versions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed')),
 requirement_set_ids_json TEXT NOT NULL DEFAULT '[]', rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
 mappings_json TEXT NOT NULL DEFAULT '[]', snapshot_json TEXT,
 revision INTEGER NOT NULL DEFAULT 1, confirmed_by TEXT REFERENCES users(id), confirmed_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,version)
);
```

## `support_ticket_images`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `ticket_id` | TEXT | 是 | 无 | 否 |
| `content_type` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 是 | 无 | 否 |
| `sha256` | TEXT | 是 | 无 | 否 |
| `state` | TEXT | 是 | 'pending' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `ticket_id` → `support_tickets.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `support_ticket_images_ticket`：`ticket_id`, `created_at`, `id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_support_ticket_images_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE support_ticket_images (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready')),
  created_at TEXT NOT NULL
);
CREATE INDEX support_ticket_images_ticket ON support_ticket_images(ticket_id, created_at, id);
```

## `support_ticket_messages`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `ticket_id` | TEXT | 是 | 无 | 否 |
| `author_id` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `body` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `author_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `ticket_id` → `support_tickets.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。

索引：
- `support_ticket_messages_ticket_created`：`ticket_id`, `created_at`, `id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_support_ticket_messages_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE support_ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('reply','status')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  status TEXT CHECK (status IN ('pending','in_progress','waiting_user','resolved','closed')),
  created_at TEXT NOT NULL
);
CREATE INDEX support_ticket_messages_ticket_created ON support_ticket_messages(ticket_id, created_at, id);
```

## `support_tickets`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `owner_id` | TEXT | 是 | 无 | 否 |
| `title` | TEXT | 是 | 无 | 否 |
| `body` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `urgency` | TEXT | 是 | 'normal' | 否 |
| `category` | TEXT | 是 | 'other' | 否 |

外键：
- `owner_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。

索引：
- `support_tickets_created`：`created_at`, `id`；非唯一；来源 c；非部分索引。
- `support_tickets_owner_created`：`owner_id`, `created_at`, `id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_support_tickets_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','waiting_user','resolved','closed')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low','normal','high','urgent')), category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('interface','functionality','account','performance','other')));
CREATE INDEX support_tickets_created ON support_tickets(created_at DESC, id DESC);
CREATE INDEX support_tickets_owner_created ON support_tickets(owner_id, created_at DESC, id DESC);
```

## `task_agent_auto_checks`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `task_id` | TEXT | 否 | 无 | 1 |
| `pending` | INTEGER | 是 | 1 | 否 |
| `activation_epoch` | INTEGER | 是 | 0 | 否 |
| `config_version_id` | TEXT | 否 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `task_id` → `tasks.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `sqlite_autoindex_task_agent_auto_checks_1`：`task_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE task_agent_auto_checks (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN (0,1)),
 activation_epoch INTEGER NOT NULL DEFAULT 0,
 config_version_id TEXT, updated_at TEXT NOT NULL
);
```

## `task_agent_eligibility`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `project_id` | TEXT | 是 | 无 | 1 |
| `task_id` | TEXT | 是 | 无 | 2 |
| `source_hash` | TEXT | 是 | 无 | 3 |
| `status` | TEXT | 是 | 无 | 否 |
| `eligible` | INTEGER | 否 | 无 | 否 |
| `reason` | TEXT | 否 | 无 | 否 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `task_id` → `tasks.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `idx_task_agent_eligibility_job`：`job_id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_task_agent_eligibility_1`：`project_id`, `task_id`, `source_hash`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE task_agent_eligibility (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
  eligible INTEGER CHECK(eligible IN (0,1)),
  reason TEXT,
  job_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,task_id,source_hash)
);
CREATE INDEX idx_task_agent_eligibility_job ON task_agent_eligibility(job_id);
```

## `task_assistance_plans`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `project_id` | TEXT | 是 | 无 | 否 |
| `task_id` | TEXT | 否 | 无 | 1 |
| `markdown` | TEXT | 否 | 无 | 否 |
| `generated_at` | TEXT | 否 | 无 | 否 |
| `plan_source_hash` | TEXT | 否 | 无 | 否 |
| `source_hash` | TEXT | 是 | 无 | 否 |
| `context_stamp` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `error` | TEXT | 否 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `task_id` → `tasks.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_task_assistance_plans_1`：`task_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE task_assistance_plans (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 markdown TEXT, generated_at TEXT, plan_source_hash TEXT,
 source_hash TEXT NOT NULL, context_stamp TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
 job_id TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL
);
```

## `task_completion_people`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `task_id` | TEXT | 否 | 无 | 1 |
| `user_id` | TEXT | 否 | 无 | 否 |
| `completed_at` | TEXT | 是 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `task_id` → `tasks.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_task_completion_people_1`：`task_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE task_completion_people (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 user_id TEXT REFERENCES users(id), completed_at TEXT NOT NULL
);
```

## `task_dependencies`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `project_id` | TEXT | 是 | 无 | 否 |
| `task_id` | TEXT | 是 | 无 | 1 |
| `depends_on_task_id` | TEXT | 是 | 无 | 2 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `tasks.project_id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。
- `depends_on_task_id` → `tasks.id`；ON DELETE CASCADE；复合关系编号 0，顺序 1。
- `project_id` → `tasks.project_id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。
- `task_id` → `tasks.id`；ON DELETE CASCADE；复合关系编号 1，顺序 1。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 2，顺序 0。

索引：
- `idx_task_dependencies_project`：`project_id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_task_dependencies_1`：`task_id`, `depends_on_task_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE task_dependencies (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL, depends_on_task_id TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,depends_on_task_id), CHECK(task_id != depends_on_task_id),
 FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,depends_on_task_id) REFERENCES tasks(project_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_task_dependencies_project ON task_dependencies(project_id);
```

## `task_file_uploads`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `file_id` | TEXT | 否 | 无 | 1 |
| `material_id` | TEXT | 是 | 无 | 否 |

外键：
- `material_id` → `materials.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。
- `file_id` → `files.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。

索引：
- `idx_task_file_uploads_material`：`material_id`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_task_file_uploads_1`：`file_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE task_file_uploads (
  file_id TEXT PRIMARY KEY REFERENCES files(id),
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE
);
CREATE INDEX idx_task_file_uploads_material ON task_file_uploads(material_id);
```

## `task_inquiries`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `task_id` | TEXT | 是 | 无 | 否 |
| `upstream_task_id` | TEXT | 是 | 无 | 否 |
| `requester_id` | TEXT | 是 | 无 | 否 |
| `recipient_id` | TEXT | 是 | 无 | 否 |
| `recipient_source` | TEXT | 是 | 无 | 否 |
| `task_title` | TEXT | 是 | 无 | 否 |
| `upstream_title` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `recipient_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `requester_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `upstream_task_id` → `tasks.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。
- `task_id` → `tasks.id`；ON DELETE NO ACTION；复合关系编号 3，顺序 0。
- `project_id` → `projects.id`；ON DELETE NO ACTION；复合关系编号 4，顺序 0。

索引：
- `task_inquiries_task`：`project_id`, `task_id`, `created_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_task_inquiries_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE task_inquiries (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 task_id TEXT NOT NULL REFERENCES tasks(id), upstream_task_id TEXT NOT NULL REFERENCES tasks(id),
 requester_id TEXT NOT NULL REFERENCES users(id), recipient_id TEXT NOT NULL REFERENCES users(id),
 recipient_source TEXT NOT NULL CHECK(recipient_source IN('submission','completion','substitute')),
 task_title TEXT NOT NULL, upstream_title TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX task_inquiries_task ON task_inquiries(project_id,task_id,created_at);
```

## `task_inquiry_messages`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `inquiry_id` | TEXT | 是 | 无 | 否 |
| `author_id` | TEXT | 是 | 无 | 否 |
| `body` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `author_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `inquiry_id` → `task_inquiries.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。

索引：
- `task_inquiry_messages_thread`：`inquiry_id`, `created_at`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_task_inquiry_messages_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE task_inquiry_messages (
 id TEXT PRIMARY KEY, inquiry_id TEXT NOT NULL REFERENCES task_inquiries(id), author_id TEXT NOT NULL REFERENCES users(id),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), created_at TEXT NOT NULL
);
CREATE INDEX task_inquiry_messages_thread ON task_inquiry_messages(inquiry_id,created_at);
```

## `task_links`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `task_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `target_id` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。
- `task_id` → `tasks.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_task_links_2`：`task_id`, `kind`, `target_id`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_task_links_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE task_links (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('requirement', 'material', 'source_version', 'file')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, kind, target_id)
);
```

## `task_readiness`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `task_id` | TEXT | 否 | 无 | 1 |
| `assignee_id` | TEXT | 否 | 无 | 否 |
| `ready` | INTEGER | 是 | 无 | 否 |
| `generation` | INTEGER | 是 | 0 | 否 |

外键：
- `assignee_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `task_id` → `tasks.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_task_readiness_1`：`task_id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE task_readiness (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 assignee_id TEXT REFERENCES users(id), ready INTEGER NOT NULL CHECK(ready IN (0,1)), generation INTEGER NOT NULL DEFAULT 0
);
```

## `task_submissions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `task_id` | TEXT | 是 | 无 | 否 |
| `round` | INTEGER | 是 | 无 | 否 |
| `submitted_by` | TEXT | 是 | 无 | 否 |
| `body` | TEXT | 是 | 无 | 否 |
| `material_versions_json` | TEXT | 是 | '[]' | 否 |
| `criteria` | TEXT | 是 | 无 | 否 |
| `task_revision` | INTEGER | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `ai_decision` | TEXT | 否 | 无 | 否 |
| `ai_feedback` | TEXT | 否 | 无 | 否 |
| `decision` | TEXT | 否 | 无 | 否 |
| `feedback` | TEXT | 否 | 无 | 否 |
| `decided_by` | TEXT | 否 | 无 | 否 |
| `evaluation_job_id` | TEXT | 否 | 无 | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `evaluation_attempts` | INTEGER | 是 | 0 | 否 |
| `ai_report_json` | TEXT | 否 | 无 | 否 |
| `mutation_token` | TEXT | 否 | 无 | 否 |
| `human_score_override_json` | TEXT | 否 | 无 | 否 |

外键：
- `submitted_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `task_id` → `tasks.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 2，顺序 0。

索引：
- `idx_submissions_task`：`project_id`, `task_id`, `round`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_task_submissions_2`：`task_id`, `round`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_task_submissions_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE task_submissions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, round INTEGER NOT NULL,
 submitted_by TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, material_versions_json TEXT NOT NULL DEFAULT '[]',
 criteria TEXT NOT NULL, task_revision INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','evaluated','accept','improve','rework')),
 ai_decision TEXT CHECK(ai_decision IN ('accept','improve','rework')), ai_feedback TEXT,
 decision TEXT CHECK(decision IN ('accept','improve','rework')), feedback TEXT, decided_by TEXT,
 evaluation_job_id TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, evaluation_attempts INTEGER NOT NULL DEFAULT 0, ai_report_json TEXT, mutation_token TEXT, human_score_override_json TEXT,
 UNIQUE(task_id,round)
);
CREATE INDEX idx_submissions_task ON task_submissions(project_id,task_id,round);
```

## `task_summaries`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `project_id` | TEXT | 是 | 无 | 1 |
| `task_id` | TEXT | 是 | 无 | 2 |
| `source_hash` | TEXT | 是 | 无 | 3 |
| `summary` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `task_id` → `tasks.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 1，顺序 0。

索引：
- `sqlite_autoindex_task_summaries_1`：`project_id`, `task_id`, `source_hash`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE task_summaries (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
  job_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, source_hash)
);
```

## `tasks`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `title` | TEXT | 是 | 无 | 否 |
| `detail` | TEXT | 是 | '' | 否 |
| `assignee_id` | TEXT | 否 | 无 | 否 |
| `due_date` | TEXT | 否 | 无 | 否 |
| `due_precision` | TEXT | 是 | 'unknown' | 否 |
| `status` | TEXT | 是 | 'todo' | 否 |
| `requirement_id` | TEXT | 否 | 无 | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `lifecycle_state` | TEXT | 否 | 无 | 否 |
| `criteria` | TEXT | 是 | '' | 否 |
| `current_submission_id` | TEXT | 否 | 无 | 否 |
| `effort_hours` | REAL | 是 | 1 | 否 |
| `source_citations_json` | TEXT | 是 | '[]' | 否 |
| `plan_proposal_id` | TEXT | 否 | 无 | 否 |
| `started_at` | TEXT | 否 | 无 | 否 |
| `archived_at` | TEXT | 否 | 无 | 否 |

外键：
- `created_by` → `users.id`；ON DELETE NO ACTION；复合关系编号 0，顺序 0。
- `requirement_id` → `requirements.id`；ON DELETE NO ACTION；复合关系编号 1，顺序 0。
- `assignee_id` → `users.id`；ON DELETE NO ACTION；复合关系编号 2，顺序 0。
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 3，顺序 0。

索引：
- `idx_tasks_project_id`：`project_id`, `id`；唯一；来源 c；非部分索引。
- `idx_tasks_project`：`project_id`, `status`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_tasks_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  assignee_id TEXT REFERENCES users(id),
  due_date TEXT,
  due_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (due_precision IN ('date', 'datetime', 'unknown')),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'blocked', 'done')),
  requirement_id TEXT REFERENCES requirements(id),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, lifecycle_state TEXT CHECK (lifecycle_state IN ('open','in_progress','submitted','accepted','improve','rework')), criteria TEXT NOT NULL DEFAULT '', current_submission_id TEXT, effort_hours REAL NOT NULL DEFAULT 1 CHECK(effort_hours > 0 AND effort_hours <= 200), source_citations_json TEXT NOT NULL DEFAULT '[]', plan_proposal_id TEXT, started_at TEXT, archived_at TEXT);
CREATE UNIQUE INDEX idx_tasks_project_id ON tasks(project_id,id);
CREATE INDEX idx_tasks_project ON tasks (project_id, status);
```

## `usage_reservations`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `purpose` | TEXT | 是 | 无 | 否 |
| `estimated_cost` | REAL | 是 | 0 | 否 |
| `status` | TEXT | 是 | 'reserved' | 否 |
| `settled_cost` | REAL | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `settled_at` | TEXT | 否 | 无 | 否 |
| `attempts_started` | INTEGER | 是 | 0 | 否 |
| `max_calls` | INTEGER | 是 | 2 | 否 |

外键：
- `project_id` → `projects.id`；ON DELETE CASCADE；复合关系编号 0，顺序 0。

索引：
- `idx_reservations_project_status`：`project_id`, `status`；非唯一；来源 c；非部分索引。
- `sqlite_autoindex_usage_reservations_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE usage_reservations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id TEXT,
  purpose TEXT NOT NULL,
  estimated_cost REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'settled', 'released', 'pending_reconcile')),
  settled_cost REAL,
  created_at TEXT NOT NULL,
  settled_at TEXT
, attempts_started INTEGER NOT NULL DEFAULT 0, max_calls INTEGER NOT NULL DEFAULT 2);
CREATE INDEX idx_reservations_project_status ON usage_reservations (project_id, status);
```

## `users`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `email` | TEXT | 是 | 无 | 否 |
| `display_name` | TEXT | 是 | '' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `last_login_at` | TEXT | 否 | 无 | 否 |

外键：
无。

索引：
- `sqlite_autoindex_users_2`：`email`；唯一；来源 u；非部分索引。
- `sqlite_autoindex_users_1`：`id`；唯一；来源 pk；非部分索引。

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
```

## 视图与触发器

### `ai_activity_job_created`

```sql
CREATE TRIGGER ai_activity_job_created AFTER INSERT ON jobs BEGIN
 INSERT OR IGNORE INTO ai_task_activities(target_id,code,updated_at) VALUES(NEW.id,'preparing',NEW.created_at);
 INSERT INTO ai_activity_events(target_id,code,state,created_at) VALUES(NEW.id,'preparing','started',NEW.created_at);
END;
```

### `ai_activity_job_status`

```sql
CREATE TRIGGER ai_activity_job_status AFTER UPDATE OF status ON jobs WHEN NEW.status != OLD.status BEGIN
 INSERT OR IGNORE INTO ai_task_activities(target_id,code,updated_at) VALUES(NEW.id,'preparing',NEW.updated_at);
 UPDATE ai_task_activities SET code=CASE NEW.status WHEN 'succeeded' THEN 'completed' WHEN 'waiting_input' THEN 'waiting_input' WHEN 'cancelled' THEN 'cancelled' WHEN 'queued' THEN 'retrying' ELSE code END, updated_at=NEW.updated_at WHERE target_id=NEW.id;
 INSERT INTO ai_activity_events(target_id,code,state,created_at,progress_json) SELECT NEW.id,code,CASE NEW.status WHEN 'failed' THEN 'failed' WHEN 'succeeded' THEN 'completed' WHEN 'queued' THEN 'resumed' ELSE 'started' END,NEW.updated_at,progress_json FROM ai_task_activities WHERE target_id=NEW.id;
END;
```

### `resource_index_delete`

```sql
CREATE TRIGGER resource_index_delete AFTER DELETE ON resource_index_blocks BEGIN
 DELETE FROM resource_index_fts WHERE rowid=old.rowid;
END;
```

### `resource_index_insert`

```sql
CREATE TRIGGER resource_index_insert AFTER INSERT ON resource_index_blocks BEGIN
 INSERT INTO resource_index_fts(rowid,content,block_id) VALUES(new.rowid,new.search_content,new.id);
END;
```

### `system_background_goal_insert`

```sql
CREATE TRIGGER system_background_goal_insert AFTER INSERT ON project_goals BEGIN

 INSERT INTO materials(id,project_id,title,kind,purpose,system_managed,is_default_background,revision,created_by,created_at,updated_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),p.id,'系统背景','background','background',1,
 CASE WHEN EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND is_default_background=1) THEN 0 ELSE 1 END,1,p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id WHERE p.id=NEW.project_id AND NOT EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND system_managed=1);
 INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),m.id,p.id,COALESCE((SELECT MAX(revision) FROM material_versions WHERE material_id=m.id),0)+1,
 json_object('type','doc','content',json_array(json_object('type','paragraph','content',json_array(json_object('type','text','text','项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END))))),
 '项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END,'manual',p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id JOIN materials m ON m.project_id=p.id AND m.system_managed=1
 WHERE p.id=NEW.project_id AND NOT EXISTS(SELECT 1 FROM material_versions WHERE id=m.current_version_id AND markdown=('项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END));
 UPDATE materials SET current_version_id=(SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1),
 revision=(SELECT MAX(revision) FROM material_versions WHERE material_id=materials.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE project_id=NEW.project_id AND system_managed=1 AND current_version_id IS NOT (SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1);
END;
```

### `system_background_goal_update`

```sql
CREATE TRIGGER system_background_goal_update AFTER UPDATE OF title,detail ON project_goals BEGIN

 INSERT INTO materials(id,project_id,title,kind,purpose,system_managed,is_default_background,revision,created_by,created_at,updated_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),p.id,'系统背景','background','background',1,
 CASE WHEN EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND is_default_background=1) THEN 0 ELSE 1 END,1,p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id WHERE p.id=NEW.project_id AND NOT EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND system_managed=1);
 INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),m.id,p.id,COALESCE((SELECT MAX(revision) FROM material_versions WHERE material_id=m.id),0)+1,
 json_object('type','doc','content',json_array(json_object('type','paragraph','content',json_array(json_object('type','text','text','项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END))))),
 '项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END,'manual',p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id JOIN materials m ON m.project_id=p.id AND m.system_managed=1
 WHERE p.id=NEW.project_id AND NOT EXISTS(SELECT 1 FROM material_versions WHERE id=m.current_version_id AND markdown=('项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END));
 UPDATE materials SET current_version_id=(SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1),
 revision=(SELECT MAX(revision) FROM material_versions WHERE material_id=materials.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE project_id=NEW.project_id AND system_managed=1 AND current_version_id IS NOT (SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1);
END;
```

### `system_background_project_update`

```sql
CREATE TRIGGER system_background_project_update AFTER UPDATE OF name,description ON projects BEGIN

 INSERT INTO materials(id,project_id,title,kind,purpose,system_managed,is_default_background,revision,created_by,created_at,updated_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),p.id,'系统背景','background','background',1,
 CASE WHEN EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND is_default_background=1) THEN 0 ELSE 1 END,1,p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id WHERE p.id=NEW.id AND NOT EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND system_managed=1);
 INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),m.id,p.id,COALESCE((SELECT MAX(revision) FROM material_versions WHERE material_id=m.id),0)+1,
 json_object('type','doc','content',json_array(json_object('type','paragraph','content',json_array(json_object('type','text','text','项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END))))),
 '项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END,'manual',p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id JOIN materials m ON m.project_id=p.id AND m.system_managed=1
 WHERE p.id=NEW.id AND NOT EXISTS(SELECT 1 FROM material_versions WHERE id=m.current_version_id AND markdown=('项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END));
 UPDATE materials SET current_version_id=(SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1),
 revision=(SELECT MAX(revision) FROM material_versions WHERE material_id=materials.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE project_id=NEW.id AND system_managed=1 AND current_version_id IS NOT (SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1);
END;
```

### `task_agent_check_created`

```sql
CREATE TRIGGER task_agent_check_created AFTER INSERT ON tasks BEGIN
 INSERT INTO task_agent_auto_checks(task_id,updated_at) VALUES(NEW.id,NEW.updated_at);
END;
```

### `task_agent_check_edited`

```sql
CREATE TRIGGER task_agent_check_edited AFTER UPDATE OF title,detail,criteria ON tasks
 WHEN OLD.title IS NOT NEW.title OR OLD.detail IS NOT NEW.detail OR OLD.criteria IS NOT NEW.criteria BEGIN
 INSERT INTO task_agent_auto_checks(task_id,pending,updated_at) VALUES(NEW.id,1,NEW.updated_at)
 ON CONFLICT(task_id) DO UPDATE SET pending=1,updated_at=excluded.updated_at;
END;
```

### `task_agent_check_global_reenabled`

```sql
CREATE TRIGGER task_agent_check_global_reenabled AFTER UPDATE OF enabled ON ai_config_versions
 WHEN OLD.enabled=0 AND NEW.enabled=1 AND NEW.version=(SELECT MAX(version) FROM ai_config_versions) BEGIN
 UPDATE task_agent_auto_checks SET pending=1,activation_epoch=activation_epoch+1,updated_at=NEW.created_at
 WHERE task_id IN (SELECT id FROM tasks WHERE archived_at IS NULL);
END;
```

### `task_agent_check_project_reenabled`

```sql
CREATE TRIGGER task_agent_check_project_reenabled AFTER UPDATE OF ai_collaboration_enabled ON projects
 WHEN OLD.ai_collaboration_enabled=0 AND NEW.ai_collaboration_enabled=1 BEGIN
 UPDATE task_agent_auto_checks SET pending=1,activation_epoch=activation_epoch+1,updated_at=NEW.updated_at
 WHERE task_id IN (SELECT id FROM tasks WHERE project_id=NEW.id AND archived_at IS NULL);
END;
```

### `task_completed_person`

```sql
CREATE TRIGGER task_completed_person AFTER UPDATE OF status ON tasks WHEN OLD.status!='done' AND NEW.status='done' BEGIN
 INSERT INTO task_completion_people(task_id,user_id,completed_at)
 VALUES(NEW.id,COALESCE((SELECT submitted_by FROM task_submissions WHERE id=NEW.current_submission_id AND status='accept'),OLD.assignee_id),NEW.updated_at)
 ON CONFLICT(task_id) DO UPDATE SET user_id=excluded.user_id,completed_at=excluded.completed_at;
END;
```

### `task_readiness_changed`

```sql
CREATE TRIGGER task_readiness_changed AFTER UPDATE OF status,assignee_id ON tasks BEGIN
 -- Changing who owns a task establishes a new baseline, without notifying on claim.
 UPDATE task_readiness SET assignee_id=NEW.assignee_id,ready=(SELECT ready FROM task_readiness_current WHERE task_id=NEW.id),generation=generation+1
 WHERE task_id=NEW.id AND assignee_id IS NOT NEW.assignee_id;
 UPDATE task_readiness SET ready=(SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id),
 generation=generation+CASE WHEN ready=0 AND (SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id)=1 THEN 1 ELSE 0 END
 WHERE task_id IN(SELECT id FROM tasks WHERE project_id=NEW.project_id);
END;
```

### `task_readiness_created`

```sql
CREATE TRIGGER task_readiness_created AFTER INSERT ON tasks BEGIN
 INSERT INTO task_readiness(task_id,assignee_id,ready) SELECT task_id,assignee_id,ready FROM task_readiness_current WHERE task_id=NEW.id;
END;
```

### `task_readiness_current`

```sql
CREATE VIEW task_readiness_current AS
 SELECT t.id task_id,t.project_id,t.assignee_id,
 CASE WHEN t.status!='done' AND t.assignee_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=t.project_id AND m.user_id=t.assignee_id)
 AND EXISTS(SELECT 1 FROM task_dependencies d WHERE d.task_id=t.id)
 AND NOT EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks upstream ON upstream.id=d.depends_on_task_id WHERE d.task_id=t.id AND upstream.status!='done')
 THEN 1 ELSE 0 END ready FROM tasks t;
```

### `task_readiness_member_left`

```sql
CREATE TRIGGER task_readiness_member_left AFTER DELETE ON project_members BEGIN
 UPDATE task_readiness SET ready=0 WHERE assignee_id=OLD.user_id AND task_id IN(SELECT id FROM tasks WHERE project_id=OLD.project_id);
END;
```

### `task_readiness_notify`

```sql
CREATE TRIGGER task_readiness_notify AFTER UPDATE OF ready ON task_readiness
 WHEN OLD.ready=0 AND NEW.ready=1 AND OLD.assignee_id IS NEW.assignee_id BEGIN
 INSERT OR IGNORE INTO notification_events(id,event_key,kind,scope,resource_id,actor_id,title,body,url,created_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),'task_ready:'||NEW.task_id||':'||NEW.generation,'task_ready','project',t.project_id,NULL,
 '领取的任务可以开始了','你领取的任务「'||t.title||'」的所有前置任务均已完成。',
 '/app/projects/'||t.project_id||'/tasks?task='||t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=NEW.task_id;
 INSERT OR IGNORE INTO notification_inbox(event_id,user_id)
 SELECT e.id,NEW.assignee_id FROM notification_events e JOIN auth_accounts a ON a.user_id=NEW.assignee_id
 WHERE e.event_key='task_ready:'||NEW.task_id||':'||NEW.generation AND a.password_hash IS NOT NULL;
 INSERT OR IGNORE INTO notification_push_outbox(event_id,subscription_id,available_at,created_at,updated_at)
 SELECT e.id,s.id,e.created_at,e.created_at,e.created_at FROM notification_events e
 JOIN notification_inbox n ON n.event_id=e.id JOIN push_subscriptions s ON s.user_id=n.user_id
 LEFT JOIN notification_settings p ON p.user_id=s.user_id
 WHERE e.event_key='task_ready:'||NEW.task_id||':'||NEW.generation AND s.disabled_at IS NULL AND s.created_at<=e.created_at AND COALESCE(p.push_enabled,1)=1;
END;
```

### `tasks_started_insert`

```sql
CREATE TRIGGER tasks_started_insert AFTER INSERT ON tasks WHEN NEW.assignee_id IS NOT NULL OR NEW.status IN ('doing','done') OR NEW.lifecycle_state IN ('in_progress','submitted','improve','rework','accepted') BEGIN UPDATE tasks SET started_at=COALESCE(NEW.started_at,NEW.updated_at) WHERE id=NEW.id; END;
```

### `tasks_started_update`

```sql
CREATE TRIGGER tasks_started_update AFTER UPDATE OF assignee_id,status,lifecycle_state ON tasks WHEN OLD.started_at IS NOT NULL OR NEW.assignee_id IS NOT NULL OR NEW.status IN ('doing','done') OR NEW.lifecycle_state IN ('in_progress','submitted','improve','rework','accepted') BEGIN UPDATE tasks SET started_at=COALESCE(OLD.started_at,NEW.started_at,NEW.updated_at) WHERE id=NEW.id; END;
```
