CREATE TABLE admin_ai_retry_batches (
 id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, requested_by TEXT,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX admin_ai_retry_one_active ON admin_ai_retry_batches((1)) WHERE status IN ('queued','running');
CREATE TABLE admin_ai_retry_items (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES admin_ai_retry_batches(id),
 target_type TEXT NOT NULL CHECK(target_type IN ('job','draft')), target_id TEXT NOT NULL,
 failed_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','queued','skipped')),
 reason TEXT, retry_job_id TEXT, updated_at TEXT NOT NULL,
 UNIQUE(batch_id,target_type,target_id)
);
CREATE INDEX admin_ai_retry_due ON admin_ai_retry_items(status,updated_at);
CREATE TABLE admin_ai_retry_links (
 parent_job_id TEXT PRIMARY KEY REFERENCES jobs(id), retry_job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), created_at TEXT NOT NULL
);
