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
CREATE UNIQUE INDEX rehearsal_voice_active ON rehearsal_voice_sessions(rehearsal_id) WHERE status IN ('reserved','connecting','open');
CREATE INDEX rehearsal_voice_expiry ON rehearsal_voice_sessions(status,expires_at);
CREATE UNIQUE INDEX rehearsal_voice_retry_number ON rehearsal_voice_sessions(root_session_id,retry_number);
