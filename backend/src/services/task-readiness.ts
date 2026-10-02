import type { Env } from '../env';
/** Append after a complete dependency graph mutation, in its existing transaction. */
export function readinessStatements(env: Env, projectId: string, newlyCreatedTaskIds: string[] = []): D1PreparedStatement[] {
 const statements:D1PreparedStatement[]=[];
 // New tasks with already-completed dependencies start silently at their actual baseline.
 if(newlyCreatedTaskIds.length)statements.push(env.DB.prepare(`INSERT OR REPLACE INTO task_readiness(task_id,assignee_id,ready,generation) SELECT task_id,assignee_id,ready,COALESCE((SELECT generation FROM task_readiness r WHERE r.task_id=c.task_id),0)+1 FROM task_readiness_current c WHERE project_id=?1 AND task_id IN(SELECT value FROM json_each(?2))`).bind(projectId,JSON.stringify(newlyCreatedTaskIds)));
 statements.push(env.DB.prepare(`UPDATE task_readiness SET ready=(SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id),generation=generation+CASE WHEN ready=0 AND (SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id)=1 THEN 1 ELSE 0 END WHERE task_id IN(SELECT id FROM tasks WHERE project_id=?1)`).bind(projectId));
 return statements;
}
