-- Additive device capabilities; no browser session or model credential is stored here.
CREATE TABLE agent_bridge_devices (
 id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE, device_name TEXT NOT NULL,
 bridge_version TEXT NOT NULL, dsh_version TEXT NOT NULL, owner_id TEXT REFERENCES users(id),
 pairing_expires_at TEXT NOT NULL, revoked_at TEXT, last_seen_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE agent_bridge_scopes (
 device_id TEXT NOT NULL REFERENCES agent_bridge_devices(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 workspace_label TEXT, PRIMARY KEY(device_id,project_id)
);
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
CREATE UNIQUE INDEX agent_bridge_one_active ON agent_bridge_handoffs(device_id)
 WHERE state IN ('claimed','running','waiting_input','uploading','cancel_requested','dispatch_uncertain');
CREATE UNIQUE INDEX agent_bridge_one_task ON agent_bridge_handoffs(task_id)
 WHERE state IN ('checking','waiting_device','claimed','running','waiting_input','uploading','cancel_requested','dispatch_uncertain');
CREATE INDEX agent_bridge_queue ON agent_bridge_handoffs(device_id,state,created_at);
CREATE TABLE agent_bridge_events (
 handoff_id TEXT NOT NULL REFERENCES agent_bridge_handoffs(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(handoff_id,sequence)
);
CREATE TABLE agent_bridge_artifacts (
 handoff_id TEXT NOT NULL REFERENCES agent_bridge_handoffs(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL, file_id TEXT NOT NULL REFERENCES files(id), name TEXT NOT NULL,
 size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, stored INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(handoff_id,artifact_id), UNIQUE(file_id)
);
