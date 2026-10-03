import { projectPermissionSql, projectAccess } from './project-permissions';
import { loadAiConfig } from '../ai/config';
import { aiUnavailable } from '../core/errors';
import type { Env } from '../env';
import { invalidState, notFound, permissionDenied } from '../core/errors';
import { withReservedAiJob } from './budget';
import { createJobAndDispatch } from './jobs';
import type { Submission } from './collaboration';
import { snapshotEvaluationRubric } from './collaboration-ai';
/** One separately reserved evaluation per submission. The successful submission remains durable on failure. */
export async function enqueueEvaluation(env: Env, projectId: string, submissionId: string, userId: string): Promise<string> {
    const config = await loadAiConfig(env.DB);
    if (!config?.enabled)
        throw aiUnavailable('AI 未启用，可由负责人手动验收');
    const row = await env.DB.prepare('SELECT * FROM task_submissions WHERE id=?1 AND project_id=?2').bind(submissionId, projectId).first<Submission>();
    if (!row)
        throw notFound();
    const member = await projectAccess(env,projectId,userId);
    if (!member || (row.submitted_by !== userId && !member.permissions.taskManage))
        throw permissionDenied();
    const settings = await env.DB.prepare('SELECT collaboration_revision,ai_collaboration_enabled,status FROM projects WHERE id=?1').bind(projectId).first<{
        collaboration_revision: number;
        ai_collaboration_enabled: number;
        status: string;
    }>();
    if (!settings)
        throw notFound();
    if (settings.ai_collaboration_enabled !== 1 || settings.status !== 'active')
        throw aiUnavailable('此项目的 AI 项目助理未启用，可由负责人手动验收');
    if (row.evaluation_attempts !== 0 || row.evaluation_job_id !== null)
        throw invalidState('本轮提交已启动过AI评价，请负责人验收或提交新的成果轮次');
    const rubricSnapshot = await snapshotEvaluationRubric(env, projectId);
    return withReservedAiJob(env, { projectId, purpose: 'review_run' }, async (jobId, configVersionId) => {
        const claim = await env.DB.prepare(`UPDATE task_submissions SET evaluation_job_id=?3,evaluation_attempts=1 WHERE id=?1 AND project_id=?2 AND status='pending' AND evaluation_attempts=0 AND evaluation_job_id IS NULL AND EXISTS(SELECT 1 FROM tasks t JOIN project_members m ON m.project_id=t.project_id AND m.user_id=t.assignee_id WHERE t.current_submission_id=?1 AND t.lifecycle_state='submitted' AND t.revision=task_submissions.task_revision AND t.assignee_id=task_submissions.submitted_by) AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?4 AND (user_id=task_submissions.submitted_by OR ${projectPermissionSql('project_members.project_id','project_members.user_id','taskManage')})) AND EXISTS(SELECT 1 FROM projects WHERE id=?2 AND collaboration_revision=?5 AND ai_collaboration_enabled=1 AND status='active')`).bind(submissionId, projectId, jobId, userId, settings.collaboration_revision).run();
        if (!claim.meta.changes)
            throw invalidState('本轮提交已启动过AI评价或提交已变化');
        try {
            await createJobAndDispatch(env, { projectId, kind: 'agent_run', jobId, createdBy: userId, input: { operation: 'collaboration.evaluate', projectId, submissionId, requestedBy: userId, settingsRevision: settings.collaboration_revision, configVersionId, rubricSnapshot } });
        }
        catch (error) {
            await env.DB.prepare('UPDATE task_submissions SET evaluation_job_id=NULL WHERE id=?1 AND evaluation_job_id=?2 AND NOT EXISTS(SELECT 1 FROM jobs WHERE id=?2)').bind(submissionId, jobId).run();
            throw error;
        }
        return jobId;
    });
}
