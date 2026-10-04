-- Persist successful plans independently from the latest generation attempt.
CREATE TABLE task_assistance_plans (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 markdown TEXT, generated_at TEXT, plan_source_hash TEXT,
 source_hash TEXT NOT NULL, context_stamp TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
 job_id TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE task_agent_auto_checks (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN (0,1)),
 activation_epoch INTEGER NOT NULL DEFAULT 0,
 config_version_id TEXT, updated_at TEXT NOT NULL
);
INSERT INTO task_agent_auto_checks(task_id,updated_at) SELECT id,updated_at FROM tasks WHERE archived_at IS NULL;
CREATE TRIGGER task_agent_check_created AFTER INSERT ON tasks BEGIN
 INSERT INTO task_agent_auto_checks(task_id,updated_at) VALUES(NEW.id,NEW.updated_at);
END;
CREATE TRIGGER task_agent_check_edited AFTER UPDATE OF title,detail,criteria ON tasks
 WHEN OLD.title IS NOT NEW.title OR OLD.detail IS NOT NEW.detail OR OLD.criteria IS NOT NEW.criteria BEGIN
 INSERT INTO task_agent_auto_checks(task_id,pending,updated_at) VALUES(NEW.id,1,NEW.updated_at)
 ON CONFLICT(task_id) DO UPDATE SET pending=1,updated_at=excluded.updated_at;
END;

-- A fresh enable cycle may resume work interrupted by disabling AI, without replay loops.
CREATE TRIGGER task_agent_check_project_reenabled AFTER UPDATE OF ai_collaboration_enabled ON projects
 WHEN OLD.ai_collaboration_enabled=0 AND NEW.ai_collaboration_enabled=1 BEGIN
 UPDATE task_agent_auto_checks SET pending=1,activation_epoch=activation_epoch+1,updated_at=NEW.updated_at
 WHERE task_id IN (SELECT id FROM tasks WHERE project_id=NEW.id AND archived_at IS NULL);
END;
CREATE TRIGGER task_agent_check_global_reenabled AFTER UPDATE OF enabled ON ai_config_versions
 WHEN OLD.enabled=0 AND NEW.enabled=1 AND NEW.version=(SELECT MAX(version) FROM ai_config_versions) BEGIN
 UPDATE task_agent_auto_checks SET pending=1,activation_epoch=activation_epoch+1,updated_at=NEW.created_at
 WHERE task_id IN (SELECT id FROM tasks WHERE archived_at IS NULL);
END;
