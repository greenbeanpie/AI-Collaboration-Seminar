-- Baseline existing tasks without replaying historical notifications.
CREATE TABLE task_readiness (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 assignee_id TEXT REFERENCES users(id), ready INTEGER NOT NULL CHECK(ready IN (0,1)), generation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE task_completion_people (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 user_id TEXT REFERENCES users(id), completed_at TEXT NOT NULL
);
CREATE VIEW task_readiness_current AS
 SELECT t.id task_id,t.project_id,t.assignee_id,
 CASE WHEN t.status!='done' AND t.assignee_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=t.project_id AND m.user_id=t.assignee_id)
 AND EXISTS(SELECT 1 FROM task_dependencies d WHERE d.task_id=t.id)
 AND NOT EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks upstream ON upstream.id=d.depends_on_task_id WHERE d.task_id=t.id AND upstream.status!='done')
 THEN 1 ELSE 0 END ready FROM tasks t;
INSERT INTO task_readiness(task_id,assignee_id,ready) SELECT task_id,assignee_id,ready FROM task_readiness_current;
CREATE TRIGGER task_readiness_created AFTER INSERT ON tasks BEGIN
 INSERT INTO task_readiness(task_id,assignee_id,ready) SELECT task_id,assignee_id,ready FROM task_readiness_current WHERE task_id=NEW.id;
END;
CREATE TRIGGER task_readiness_changed AFTER UPDATE OF status,assignee_id ON tasks BEGIN
 -- Changing who owns a task establishes a new baseline, without notifying on claim.
 UPDATE task_readiness SET assignee_id=NEW.assignee_id,ready=(SELECT ready FROM task_readiness_current WHERE task_id=NEW.id),generation=generation+1
 WHERE task_id=NEW.id AND assignee_id IS NOT NEW.assignee_id;
 UPDATE task_readiness SET ready=(SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id),
 generation=generation+CASE WHEN ready=0 AND (SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id)=1 THEN 1 ELSE 0 END
 WHERE task_id IN(SELECT id FROM tasks WHERE project_id=NEW.project_id);
END;
CREATE TRIGGER task_completed_person AFTER UPDATE OF status ON tasks WHEN OLD.status!='done' AND NEW.status='done' BEGIN
 INSERT INTO task_completion_people(task_id,user_id,completed_at)
 VALUES(NEW.id,COALESCE((SELECT submitted_by FROM task_submissions WHERE id=NEW.current_submission_id AND status='accept'),OLD.assignee_id),NEW.updated_at)
 ON CONFLICT(task_id) DO UPDATE SET user_id=excluded.user_id,completed_at=excluded.completed_at;
END;
CREATE TRIGGER task_readiness_notify AFTER UPDATE OF ready ON task_readiness
 WHEN OLD.ready=0 AND NEW.ready=1 AND OLD.assignee_id IS NEW.assignee_id BEGIN
 INSERT OR IGNORE INTO notification_events(id,event_key,kind,scope,resource_id,actor_id,title,body,url,created_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),'task_ready:'||NEW.task_id||':'||NEW.generation,'task_ready','project',t.project_id,NULL,
 '领取的任务可以开始了','你领取的任务「'||t.title||'」的所有前置任务均已完成。',
 '/app/projects/'||t.project_id||'/tasks?task='||t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=NEW.task_id;
 INSERT OR IGNORE INTO notification_inbox(event_id,user_id)
 SELECT e.id,NEW.assignee_id FROM notification_events e JOIN auth_accounts a ON a.user_id=NEW.assignee_id
 WHERE e.event_key='task_ready:'||NEW.task_id||':'||NEW.generation AND a.password_hash IS NOT NULL;
 INSERT OR IGNORE INTO notification_push_outbox(event_id,subscription_id,available_at,created_at,updated_at)
 SELECT e.id,s.id,e.created_at,e.created_at,e.created_at FROM notification_events e
 JOIN notification_inbox n ON n.event_id=e.id JOIN push_subscriptions s ON s.user_id=n.user_id
 LEFT JOIN notification_settings p ON p.user_id=s.user_id
 WHERE e.event_key='task_ready:'||NEW.task_id||':'||NEW.generation AND s.disabled_at IS NULL AND s.created_at<=e.created_at AND COALESCE(p.push_enabled,1)=1;
END;
CREATE TRIGGER task_readiness_member_left AFTER DELETE ON project_members BEGIN
 UPDATE task_readiness SET ready=0 WHERE assignee_id=OLD.user_id AND task_id IN(SELECT id FROM tasks WHERE project_id=OLD.project_id);
END;
