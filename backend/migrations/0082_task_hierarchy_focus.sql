-- Additive hierarchy and per-user focus; existing dependencies remain manual.
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id);
CREATE INDEX idx_tasks_parent ON tasks(project_id,parent_task_id);
ALTER TABLE task_dependencies ADD COLUMN manual_origin INTEGER NOT NULL DEFAULT 1 CHECK(manual_origin IN (0,1));
ALTER TABLE task_dependencies ADD COLUMN hierarchy_origin INTEGER NOT NULL DEFAULT 0 CHECK(hierarchy_origin IN (0,1));
CREATE TABLE task_pins (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL,
 PRIMARY KEY(project_id,user_id,task_id)
);
CREATE TRIGGER task_parent_insert AFTER INSERT ON tasks WHEN NEW.parent_task_id IS NOT NULL BEGIN
 INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,created_at,manual_origin,hierarchy_origin)
 VALUES(NEW.project_id,NEW.parent_task_id,NEW.id,NEW.updated_at,0,1)
 ON CONFLICT(task_id,depends_on_task_id) DO UPDATE SET hierarchy_origin=1;
END;
CREATE TRIGGER task_parent_update AFTER UPDATE OF parent_task_id ON tasks WHEN OLD.parent_task_id IS NOT NEW.parent_task_id BEGIN
 DELETE FROM task_dependencies WHERE project_id=NEW.project_id AND task_id=OLD.parent_task_id AND depends_on_task_id=NEW.id AND manual_origin=0;
 UPDATE task_dependencies SET hierarchy_origin=0 WHERE project_id=NEW.project_id AND task_id=OLD.parent_task_id AND depends_on_task_id=NEW.id;
 INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,created_at,manual_origin,hierarchy_origin)
 SELECT NEW.project_id,NEW.parent_task_id,NEW.id,NEW.updated_at,0,1 WHERE NEW.parent_task_id IS NOT NULL
 ON CONFLICT(task_id,depends_on_task_id) DO UPDATE SET hierarchy_origin=1;
END;
