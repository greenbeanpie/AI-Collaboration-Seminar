CREATE TABLE ai_execution_policy (
 id TEXT PRIMARY KEY CHECK(id='global'),
 version INTEGER NOT NULL DEFAULT 1,
 max_model_calls INTEGER NOT NULL DEFAULT 100 CHECK(max_model_calls BETWEEN 1 AND 10000),
 updated_at TEXT NOT NULL
);
INSERT INTO ai_execution_policy(id,version,max_model_calls,updated_at) VALUES('global',1,100,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE ai_execution_policy_audit (
 id TEXT PRIMARY KEY, actor_id TEXT, version INTEGER NOT NULL UNIQUE,
 max_model_calls INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE ai_executions (
 target_kind TEXT NOT NULL CHECK(target_kind IN ('job','draft_preview')),
 target_id TEXT NOT NULL, draft_id TEXT,
 generation INTEGER NOT NULL DEFAULT 1,
 window_calls INTEGER NOT NULL DEFAULT 0 CHECK(window_calls>=0),
 total_calls INTEGER NOT NULL DEFAULT 0 CHECK(total_calls>=0),
 call_limit INTEGER NOT NULL CHECK(call_limit BETWEEN 1 AND 10000),
 state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('running','paused','finalizing','cancelled','completed')),
 pause_reason TEXT, inflight_token TEXT, inflight_generation INTEGER,
 final_call_used INTEGER NOT NULL DEFAULT 0 CHECK(final_call_used IN (0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(target_kind,target_id)
);
CREATE INDEX ai_executions_state ON ai_executions(state,updated_at);
