import { loadAiConfig } from '../ai/config';
import { aiUnavailable } from '../core/errors';
import type { Env } from '../env';
import { invalidState, notFound, permissionDenied } from '../core/errors';
import { withReservedAiJob } from './budget';
import { createJobAndDispatch } from './jobs';
import type { Submission } from './collaboration';
/** Bounded, separately reserved evaluation. The successful submission remains durable on failure. */
export async function enqueueEvaluation(env: Env, projectId: string, submissionId: string, userId: string): Promise<string> {
    const config = await loadAiConfig(env.DB);
    if (!config?.enabled)
        throw aiUnavailable('AI 未启用，可由负责人手动验收');
    const row = await env.DB.prepare('SELECT * FROM task_submissions WHERE id=?1 AND project_id=?2').bind(submissionId, projectId).first<Submission>();
    if (!row)
        throw notFound();
    const member = await env.DB.prepare('SELECT role FROM project_members WHERE project_id=?1 AND user_id=?2').bind(projectId, userId).first<{
        role: string;
    }>();
    if (!member || (row.submitted_by !== userId && member.role !== 'owner'))
        throw permissionDenied();
    const settings = await env.DB.prepare('SELECT collaboration_revision FROM projects WHERE id=?1').bind(projectId).first<{
        collaboration_revision: number;
    }>();
    if (!settings)
        throw notFound();
    return withReservedAiJob(env, { projectId, purpose: 'review_run' }, async (jobId, configVersionId) => {
        const claim = await env.DB.prepare(`UPDATE task_submissions SET evaluation_job_id=?3,evaluation_attempts=evaluation_attempts+1 WHERE id=?1 AND project_id=?2 AND status='pending' AND evaluation_attempts<3 AND (evaluation_job_id IS NULL OR EXISTS(SELECT 1 FROM jobs WHERE id=evaluation_job_id AND status IN ('failed','cancelled'))) AND EXISTS(SELECT 1 FROM tasks t JOIN project_members m ON m.project_id=t.project_id AND m.user_id=t.assignee_id WHERE t.current_submission_id=?1 AND t.lifecycle_state='submitted' AND t.revision=task_submissions.task_revision AND t.assignee_id=task_submissions.submitted_by) AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?4 AND (user_id=task_submissions.submitted_by OR role='owner')) AND EXISTS(SELECT 1 FROM projects WHERE id=?2 AND collaboration_revision=?5)`).bind(submissionId, projectId, jobId, userId, settings.collaboration_revision).run();
        if (!claim.meta.changes)
            throw invalidState('评价正在进行、提交已变化或已达3次上限');
        try {
            await createJobAndDispatch(env, { projectId, kind: 'agent_run', jobId, createdBy: userId, input: { operation: 'collaboration.evaluate', projectId, submissionId, requestedBy: userId, settingsRevision: settings.collaboration_revision, configVersionId } });
        }
        catch (error) {
            await env.DB.prepare('UPDATE task_submissions SET evaluation_job_id=NULL WHERE id=?1 AND evaluation_job_id=?2 AND NOT EXISTS(SELECT 1 FROM jobs WHERE id=?2)').bind(submissionId, jobId).run();
            throw error;
        }
        return jobId;
    });
}
