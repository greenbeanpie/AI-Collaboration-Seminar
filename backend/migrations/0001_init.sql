-- 0001_init.sql —— 全量初始 schema（backend_plan.md 第 5 节）
-- 约定：主键 TEXT(UUID)；时间戳 TEXT ISO-8601 UTC；JSON 以 TEXT 存储；
-- 历史快照表（source_versions / material_versions / rubric_versions 等）不可变。

-- ========== 身份 ==========
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

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

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

-- ========== 项目 ==========
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
);

CREATE TABLE project_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  skills_json TEXT NOT NULL DEFAULT '[]',
  hours_per_week REAL,
  joined_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_project_members ON project_members (project_id, user_id);

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

-- ========== 来源 ==========
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
);
CREATE INDEX idx_files_project_sha ON files (project_id, sha256);

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
);
CREATE INDEX idx_sources_project ON sources (project_id);

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
  created_at TEXT NOT NULL,
  UNIQUE (source_id, revision)
);

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

CREATE TABLE source_fragments (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_number INTEGER,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'ocr', 'web', 'paste')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source_version_id, seq)
);
CREATE INDEX idx_source_fragments_page ON source_fragments (source_version_id, page_number);

-- ========== 要求与评分 ==========
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

-- ========== 任务 ==========
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
);
CREATE INDEX idx_tasks_project ON tasks (project_id, status);

CREATE TABLE task_links (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('requirement', 'material', 'source_version', 'file')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, kind, target_id)
);

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

-- ========== 材料 ==========
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
);
CREATE INDEX idx_materials_project ON materials (project_id);

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
  created_at TEXT NOT NULL,
  UNIQUE (material_id, revision)
);

-- ========== AI ==========
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

-- 内部表（支撑 /agent-runs/{id}/adopt，不进入对外契约）
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

-- ========== 预审答辩 ==========
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
);

CREATE TABLE rehearsal_turns (
  id TEXT PRIMARY KEY,
  rehearsal_id TEXT NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('question', 'answer', 'followup', 'summary')),
  content_json TEXT NOT NULL DEFAULT '{}',
  run_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (rehearsal_id, sequence)
);

-- ========== 证据（过程账本） ==========
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
CREATE UNIQUE INDEX uq_events_dedup ON events (project_id, type, entity_type, entity_id, dedup_key);
CREATE INDEX idx_events_project_time ON events (project_id, occurred_at);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  made_by TEXT NOT NULL REFERENCES users(id),
  decided_at TEXT NOT NULL,
  related_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE contributions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'manual',
  description TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_contributions_project ON contributions (project_id, user_id);

CREATE TABLE resource_references (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('url', 'file', 'model', 'other')),
  title TEXT NOT NULL,
  url TEXT,
  file_id TEXT REFERENCES files(id),
  meta_json TEXT NOT NULL DEFAULT '{}',
  declared_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

-- ========== 基础设施 ==========
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
CREATE INDEX idx_jobs_status_lease ON jobs (status, lease_until);
CREATE INDEX idx_jobs_project_time ON jobs (project_id, created_at);

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

CREATE TABLE ai_config_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);

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
);
CREATE INDEX idx_ai_calls_project ON ai_calls (project_id, created_at);

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
);
CREATE INDEX idx_reservations_project_status ON usage_reservations (project_id, status);

CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
