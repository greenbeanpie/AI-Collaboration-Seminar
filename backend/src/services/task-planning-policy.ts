import type { Env } from '../env';
import { invalidState } from '../core/errors';
export function pristineTasksSql(project: string): string {
 return `NOT EXISTS(SELECT 1 FROM tasks policy_task WHERE policy_task.project_id=${project} AND policy_task.archived_at IS NULL AND (policy_task.started_at IS NOT NULL OR policy_task.assignee_id IS NOT NULL OR policy_task.status!='todo' OR COALESCE(policy_task.lifecycle_state,'open')!='open' OR EXISTS(SELECT 1 FROM task_submissions s WHERE s.task_id=policy_task.id)))`;
}
export async function assertCanRegenerate(env: Env, projectId: string) {
 if (!await env.DB.prepare(`SELECT 1 WHERE ${pristineTasksSql('?1')}`).bind(projectId).first()) throw invalidState('已有任务曾被认领或开始，只能提出调整或补充建议并请项目负责人或拥有任务管理权限的成员确认');
}
