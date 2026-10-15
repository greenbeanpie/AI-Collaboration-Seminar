-- Scope task_readiness updates to the modified task and its direct downstream dependents.
CREATE INDEX IF NOT EXISTS idx_task_dependencies_upstream ON task_dependencies(project_id, depends_on_task_id, task_id);
DROP TRIGGER task_readiness_changed;
CREATE TRIGGER task_readiness_changed AFTER UPDATE OF status,assignee_id ON tasks BEGIN
 -- Changing who owns a task establishes a new baseline, without notifying on claim.
 UPDATE task_readiness SET assignee_id=NEW.assignee_id,ready=(SELECT ready FROM task_readiness_current WHERE task_id=NEW.id),generation=generation+1
 WHERE task_id=NEW.id AND assignee_id IS NOT NEW.assignee_id;
 UPDATE task_readiness SET ready=(SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id),
 generation=generation+CASE WHEN ready=0 AND (SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id)=1 THEN 1 ELSE 0 END
 WHERE task_id=NEW.id OR task_id IN(SELECT task_id FROM task_dependencies WHERE depends_on_task_id=NEW.id AND project_id=NEW.project_id);
END;
