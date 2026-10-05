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
