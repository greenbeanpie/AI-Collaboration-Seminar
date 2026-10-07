-- Product-safe activity metadata; raw model results remain in private encrypted R2 checkpoints.
CREATE TABLE ai_task_activities (
 target_id TEXT PRIMARY KEY,
 code TEXT NOT NULL DEFAULT 'preparing',
 updated_at TEXT NOT NULL,
 last_response_at TEXT,
 progress_json TEXT,
 uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1))
);
CREATE TABLE ai_activity_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 target_id TEXT NOT NULL REFERENCES ai_task_activities(target_id),
 code TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('started','completed','failed','resumed')),
 created_at TEXT NOT NULL,
 progress_json TEXT
);
CREATE INDEX ai_activity_events_target ON ai_activity_events(target_id,id);
-- Capture every creation path, including transactional retries and legacy direct inserts.
CREATE TRIGGER ai_activity_job_created AFTER INSERT ON jobs BEGIN
 INSERT OR IGNORE INTO ai_task_activities(target_id,code,updated_at) VALUES(NEW.id,'preparing',NEW.created_at);
 INSERT INTO ai_activity_events(target_id,code,state,created_at) VALUES(NEW.id,'preparing','started',NEW.created_at);
END;
CREATE TRIGGER ai_activity_job_status AFTER UPDATE OF status ON jobs WHEN NEW.status != OLD.status BEGIN
 INSERT OR IGNORE INTO ai_task_activities(target_id,code,updated_at) VALUES(NEW.id,'preparing',NEW.updated_at);
 UPDATE ai_task_activities SET code=CASE NEW.status WHEN 'succeeded' THEN 'completed' WHEN 'waiting_input' THEN 'waiting_input' WHEN 'cancelled' THEN 'cancelled' WHEN 'queued' THEN 'retrying' ELSE code END, updated_at=NEW.updated_at WHERE target_id=NEW.id;
 INSERT INTO ai_activity_events(target_id,code,state,created_at,progress_json) SELECT NEW.id,code,CASE NEW.status WHEN 'failed' THEN 'failed' WHEN 'succeeded' THEN 'completed' WHEN 'queued' THEN 'resumed' ELSE 'started' END,NEW.updated_at,progress_json FROM ai_task_activities WHERE target_id=NEW.id;
END;
