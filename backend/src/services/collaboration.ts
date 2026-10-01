import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, permissionDenied, validationFailed } from '../core/errors';
export interface CollaborationTask {
    id: string;
    project_id: string;
    title: string;
    detail: string;
    status: string;
    assignee_id: string | null;
    revision: number;
    lifecycle_state: string | null;
    criteria: string;
    effort_hours: number;
    parent_task_id: string | null;
    current_submission_id: string | null;
    created_at: string;
    updated_at: string;
}
export const toCollaborationTask = (r: CollaborationTask) => ({ taskId: r.id, title: r.title, detail: r.detail, status: r.status, assigneeId: r.assignee_id, revision: r.revision, lifecycleState: r.lifecycle_state, criteria: r.criteria, effortHours: r.effort_hours, parentTaskId: r.parent_task_id, currentSubmissionId: r.current_submission_id, createdAt: r.created_at, updatedAt: r.updated_at });
export interface Submission {
    id: string;
    project_id: string;
    task_id: string;
    round: number;
    submitted_by: string;
    body: string;
    material_versions_json: string;
    criteria: string;
    task_revision: number;
    status: string;
    ai_decision: string | null;
    ai_feedback: string | null;
    ai_report_json: string | null;
    decision: string | null;
    feedback: string | null;
    evaluation_job_id: string | null;
    evaluation_attempts: number;
    revision: number;
    created_at: string;
    updated_at: string;
}
export const toSubmission = (r: Submission) => ({ submissionId: r.id, taskId: r.task_id, round: r.round, submittedBy: r.submitted_by, body: r.body, materialVersionIds: JSON.parse(r.material_versions_json) as string[], criteria: r.criteria, status: r.status, aiDecision: r.ai_decision, aiFeedback: r.ai_feedback, aiReport: r.ai_report_json ? JSON.parse(r.ai_report_json) : null, decision: r.decision, feedback: r.feedback, evaluationJobId: r.evaluation_job_id, evaluationAttempts: r.evaluation_attempts, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at });
export interface Proposal {
    id: string;
    project_id: string;
    kind: 'decompose' | 'assign';
    payload_json: string;
    settings_revision: number;
    status: string;
    revision: number;
    created_at: string;
    updated_at: string;
}
export const toProposal = (r: Proposal) => ({ proposalId: r.id, kind: r.kind, payload: JSON.parse(r.payload_json), status: r.status, revision: r.revision, createdAt: r.created_at });
export async function owner(env: Env, projectId: string, userId: string) {
    if (!await env.DB.prepare("SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2 AND role='owner'").bind(projectId, userId).first())
        throw permissionDenied('需要项目负责人权限');
}
export function audit(env: Env, projectId: string, userId: string, type: string, id: string, payload: unknown, onlyAfterChange = false) { return env.DB.prepare(`INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) SELECT ?1,?2,'user',?3,?4,'collaboration',?5,?1,?6,?7 ${onlyAfterChange ? 'WHERE changes()=1' : ''}`).bind(newId(), projectId, userId, type, id, JSON.stringify(payload), nowIso()); }
export async function applyProposal(env: Env, projectId: string, proposalId: string, expectedRevision: number, actorId: string, automatic = false, configVersionId?: string): Promise<{
    taskIds: string[];
}> {
    await owner(env, projectId, actorId);
    const p = await env.DB.prepare('SELECT * FROM collaboration_proposals WHERE id=?1 AND project_id=?2').bind(proposalId, projectId).first<Proposal>();
    if (!p)
        throw notFound();
    const payload = JSON.parse(p.payload_json) as {
        brief?: string;
        tasks?: Array<{
            title: string;
            detail: string;
            criteria: string;
            effortHours: number;
            parentTaskId?: string | null;
        }>;
        assignments?: Array<{
            taskId: string;
            assigneeId: string | null;
            expectedRevision: number;
            reason: string;
        }>;
    };
    const nonce = newId();
    const taskIds: string[] = [];
    const batch: D1PreparedStatement[] = [];
    const validProfiles = p.kind === 'assign' ? `AND EXISTS(SELECT 1 FROM jobs j WHERE j.id=collaboration_proposals.job_id AND json_type(j.input_json,'$.profileStamp')='text'
      AND (SELECT COUNT(*) FROM json_each(json_extract(j.input_json,'$.profileStamp')))=(SELECT COUNT(*) FROM project_members WHERE project_id=?2)
      AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(j.input_json,'$.profileStamp')) snap WHERE NOT EXISTS(
        SELECT 1 FROM project_members pm LEFT JOIN personal_profiles pp ON pp.user_id=pm.user_id WHERE pm.project_id=?2 AND pm.id=json_extract(snap.value,'$.id') AND pm.user_id=json_extract(snap.value,'$.user_id') AND COALESCE(pp.revision,0)=json_extract(snap.value,'$.profile_revision')))) AND NOT EXISTS(SELECT 1 FROM jobs j,json_each(j.input_json,'$.members') snapshot WHERE j.id=collaboration_proposals.job_id AND NOT EXISTS(SELECT 1 FROM project_members pm WHERE pm.project_id=?2 AND pm.user_id=json_extract(snapshot.value,'$.userId') AND pm.major=json_extract(snapshot.value,'$.major') AND pm.skills_json=json_extract(snapshot.value,'$.skills') AND pm.hours_per_week IS json_extract(snapshot.value,'$.hoursPerWeek') AND COALESCE((SELECT SUM(effort_hours) FROM tasks WHERE project_id=?2 AND assignee_id=pm.user_id AND status!='done'),0)=json_extract(snapshot.value,'$.loadHours')))` : '';
    const validAssignments = p.kind === 'assign' ? `AND NOT EXISTS (SELECT 1 FROM json_each(payload_json,'$.assignments') a WHERE json_extract(a.value,'$.assigneeId') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tasks t JOIN project_members m ON m.project_id=t.project_id AND m.user_id=json_extract(a.value,'$.assigneeId') WHERE t.project_id=?2 AND t.id=json_extract(a.value,'$.taskId') AND t.revision=json_extract(a.value,'$.expectedRevision') AND t.assignee_id IS NULL AND t.lifecycle_state='open'))` : '';
    batch.push(env.DB.prepare(`UPDATE collaboration_proposals SET status='applied',revision=revision+1,mutation_token=?5,updated_at=?8 WHERE id=?1 AND project_id=?2 AND revision=?3 AND status='pending' AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?4 AND role='owner') AND EXISTS(SELECT 1 FROM projects WHERE id=?2 AND collaboration_revision=collaboration_proposals.settings_revision AND (?6=0 OR assignment_mode='automatic')) AND (?6=0 OR EXISTS(SELECT 1 FROM ai_config_versions WHERE id=?7 AND enabled=1 AND version=(SELECT MAX(version) FROM ai_config_versions))) ${validAssignments} ${validProfiles} AND (?6=0 OR EXISTS(SELECT 1 FROM jobs WHERE id=collaboration_proposals.job_id AND status IN ('queued','running')))`).bind(proposalId, projectId, expectedRevision, actorId, nonce, automatic ? 1 : 0, configVersionId ?? null, nowIso()));
    const gate = `EXISTS(SELECT 1 FROM collaboration_proposals WHERE id=?1 AND status='applied' AND mutation_token=?2)`;
    if (p.kind === 'decompose') {
        if (!payload.tasks?.length || payload.tasks.length > 20)
            throw validationFailed('拆解结果无效');
        const parentId = proposalId;
        batch.push(env.DB.prepare(`INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria,effort_hours) SELECT ?3,?4,?5,?6,'todo',1,?7,?8,?8,'open','全部子任务验收通过后，人工核对整体交付要求',1 WHERE ${gate}`).bind(proposalId, nonce, parentId, projectId, '需求总目标', payload.brief || '拆解任务', actorId, nowIso()));
        for (const t of payload.tasks) {
            if (!t.title || !t.criteria || !Number.isFinite(t.effortHours) || t.effortHours < 0.25 || t.effortHours > 200)
                throw validationFailed('任务内容无效');
            const taskId = newId();
            taskIds.push(taskId);
            batch.push(env.DB.prepare(`INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria,effort_hours,parent_task_id) SELECT ?3,?4,?5,?6,'todo',1,?7,?8,?8,'open',?9,?10,?11 WHERE ${gate}`).bind(proposalId, nonce, taskId, projectId, t.title, t.detail || '', actorId, nowIso(), t.criteria, t.effortHours, parentId));
        }
    }
    else {
        if (!payload.assignments?.length || payload.assignments.length > 20 || new Set(payload.assignments.map(a => a.taskId)).size !== payload.assignments.length)
            throw validationFailed('分工结果无效');
        for (const a of payload.assignments.filter(a => a.assigneeId !== null))
            batch.push(env.DB.prepare(`UPDATE tasks SET assignee_id=?3,lifecycle_state='in_progress',status='doing',revision=revision+1,updated_at=?4 WHERE id=?5 AND project_id=?6 AND revision=?7 AND assignee_id IS NULL AND ${gate}`).bind(proposalId, nonce, a.assigneeId, nowIso(), a.taskId, projectId, a.expectedRevision));
    }
    batch.push(env.DB.prepare(`INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) SELECT ?3,?4,?5,?6,'collaboration.proposal_applied','collaboration',?1,?2,?7,?8 WHERE ${gate}`).bind(proposalId, nonce, newId(), projectId, automatic ? 'ai' : 'user', actorId, p.payload_json, nowIso()));
    const results = await env.DB.batch(batch);
    if (!results[0]!.meta.changes)
        throw invalidState('建议已失效、成员或任务已变化，请重新生成');
    return { taskIds };
}
export async function decideSubmission(env: Env, projectId: string, submissionId: string, expectedRevision: number, decision: 'accept' | 'improve' | 'rework', feedback: string, actorId: string, automatic = false, settingsRevision?: number, configVersionId?: string): Promise<void> {
    if (!automatic)
        await owner(env, projectId, actorId);
    const nonce = newId();
    const result = await env.DB.batch([
        env.DB.prepare(`UPDATE task_submissions SET decision=?4,feedback=?5,status=?4,decided_by=?6,revision=revision+1,mutation_token=?7,updated_at=?11 WHERE id=?1 AND project_id=?2 AND revision=?3 AND status IN ('pending','evaluated') AND EXISTS(SELECT 1 FROM tasks t JOIN project_members m ON m.project_id=t.project_id AND m.user_id=t.assignee_id WHERE t.id=task_submissions.task_id AND t.current_submission_id=?1 AND t.lifecycle_state='submitted' AND t.revision=task_submissions.task_revision AND t.assignee_id=task_submissions.submitted_by) AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?6 AND (role='owner' OR (?8=1 AND user_id=task_submissions.submitted_by))) AND EXISTS(SELECT 1 FROM projects WHERE id=?2 AND (?8=0 OR (evaluation_mode='automatic' AND collaboration_revision=?9))) AND (?8=0 OR ?4!='accept' OR NOT EXISTS(SELECT 1 FROM tasks child WHERE child.parent_task_id=task_submissions.task_id)) AND (?8=0 OR EXISTS(SELECT 1 FROM jobs WHERE id=task_submissions.evaluation_job_id AND status IN ('queued','running'))) AND (?8=0 OR EXISTS(SELECT 1 FROM ai_config_versions WHERE id=?10 AND enabled=1 AND version=(SELECT MAX(version) FROM ai_config_versions)))`).bind(submissionId, projectId, expectedRevision, decision, feedback, actorId, nonce, automatic ? 1 : 0, settingsRevision ?? null, configVersionId ?? null, nowIso()),
        env.DB.prepare(`UPDATE tasks SET lifecycle_state=?3,status=?4,revision=revision+1,updated_at=?5 WHERE project_id=?2 AND current_submission_id=?1 AND EXISTS(SELECT 1 FROM task_submissions WHERE id=?1 AND mutation_token=?6)`).bind(submissionId, projectId, decision === 'accept' ? 'accepted' : decision, decision === 'accept' ? 'done' : 'doing', nowIso(), nonce),
        env.DB.prepare(`INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) SELECT ?3,?2,?4,?5,'collaboration.submission_decided','submission',?1,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM task_submissions WHERE id=?1 AND mutation_token=?6)`).bind(submissionId, projectId, newId(), automatic ? 'ai' : 'user', actorId, nonce, JSON.stringify({ decision, feedback }), nowIso()),
    ]);
    if (!result[0]!.meta.changes)
        throw invalidState('提交、负责人或设置已变化，请刷新');
}
