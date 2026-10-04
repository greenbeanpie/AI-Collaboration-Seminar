-- A retry chain retains its original failed request and never resets automatically.
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
CREATE INDEX ai_automatic_retries_due ON ai_automatic_retries(status,next_attempt_at);
CREATE INDEX ai_automatic_retries_target ON ai_automatic_retries(target_kind,target_id);
