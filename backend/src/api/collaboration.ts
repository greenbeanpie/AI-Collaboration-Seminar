import { loadAiConfig } from '../ai/config';
import { aiUnavailable } from '../core/errors';
import { enqueueEvaluation } from '../services/collaboration-evaluation';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { requireProjectMember, requireUser } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { newId, nowIso } from '../core/db';
import { parsePaging, nextCursor } from '../core/pagination';
import { invalidState, notFound, permissionDenied, validationFailed } from '../core/errors';
import { withIdempotency } from '../services/idempotency';
import { withReservedAiJob } from '../services/budget';
import { createJobAndDispatch } from '../services/jobs';
import { applyProposal, audit, decideSubmission, owner, toCollaborationTask, toProposal, toSubmission, type CollaborationTask, type Proposal, type Submission } from '../services/collaboration';
import { projectParams } from './projects';
const revision = z.number().int().positive();
const mode = z.enum(['manual', 'automatic']);
const taskInput = z.object({ title: z.string().min(1).max(200), detail: z.string().max(4000).default(''), criteria: z.string().min(1).max(4000), effortHours: z.number().min(.25).max(200).default(1), parentTaskId: z.string().uuid().nullable().default(null) });
const settingsSchema = z.object({ assignmentMode: mode, evaluationMode: mode, revision });
const taskSchema = z.object({ taskId: z.string().uuid(), title: z.string(), detail: z.string(), status: z.enum(['todo', 'doing', 'blocked', 'done']), assigneeId: z.string().uuid().nullable(), revision, lifecycleState: z.enum(['open', 'in_progress', 'submitted', 'accepted', 'improve', 'rework']), criteria: z.string(), effortHours: z.number(), parentTaskId: z.string().uuid().nullable(), currentSubmissionId: z.string().uuid().nullable(), createdAt: z.string(), updatedAt: z.string() });
const decisionSchema = z.enum(['accept', 'improve', 'rework']);
const reportSchema = z.object({ decision: decisionSchema, feedback: z.string(), evidence: z.array(z.object({ materialVersionId: z.string().uuid(), quote: z.string() })), limitations: z.array(z.string()), coverage: z.enum(['complete', 'needs_human']), manualReviewReason: z.string().optional() });
const submissionSchema = z.object({ submissionId: z.string().uuid(), taskId: z.string().uuid(), round: z.number(), submittedBy: z.string().uuid(), body: z.string(), materialVersionIds: z.array(z.string().uuid()), materialVersions: z.array(z.object({ versionId: z.string().uuid(), materialId: z.string().uuid(), title: z.string(), revision: z.number() })).optional(), criteria: z.string(), status: z.enum(['pending', 'evaluated', 'accept', 'improve', 'rework']), aiDecision: decisionSchema.nullable(), aiFeedback: z.string().nullable(), aiReport: reportSchema.nullable(), decision: decisionSchema.nullable(), feedback: z.string().nullable(), evaluationJobId: z.string().uuid().nullable(), evaluationAttempts: z.number(), evaluationError: z.string().optional(), revision, createdAt: z.string(), updatedAt: z.string() });
const proposalSchema = z.object({ proposalId: z.string().uuid(), kind: z.enum(['decompose', 'assign']), payload: z.object({ brief: z.string().optional(), tasks: z.array(taskInput).optional(), assignments: z.array(z.object({ taskId: z.string().uuid(), assigneeId: z.string().uuid().nullable(), expectedRevision: revision, reason: z.string() })).optional(), considerations: z.array(z.string()).optional() }), status: z.enum(['pending', 'applied', 'stale']), revision, createdAt: z.string() });
function route(app: OpenAPIHono<AppEnv>, method: 'get' | 'post' | 'patch', path: string, body: z.ZodType | undefined, handler: (c: Context<AppEnv>) => Promise<Response>, status: 200 | 201 | 202 = 200) {
    const extras: Record<string, z.ZodString> = {};
    for (const match of path.matchAll(/\{(\w+)\}/g))
        extras[match[1]!] = z.string().uuid();
    const [out, name] = path === '/settings' ? [settingsSchema, 'CollaborationSettingsResponse'] : status === 202 ? [z.object({ jobId: z.string().uuid() }), 'CollaborationJobResponse'] : path.endsWith('/apply') ? [z.object({ applied: z.boolean() }), 'CollaborationApplyResponse'] : path === '/proposals' ? [z.object({ items: z.array(proposalSchema), nextCursor: z.string().nullable() }), 'CollaborationProposalListResponse'] : path.includes('submissions') ? [method === 'get' ? z.object({ items: z.array(submissionSchema) }) : submissionSchema, method === 'get' ? 'CollaborationSubmissionListResponse' : 'CollaborationSubmissionResponse'] : path === '/tasks' && method === 'get' ? [z.object({ items: z.array(taskSchema), nextCursor: z.string().nullable() }), 'CollaborationTaskListResponse'] : [taskSchema, 'CollaborationTaskResponse'];
    const r = createRoute({ method, path: '/api/v1/projects/{projectId}/collaboration' + path, tags: ['collaboration'], summary: '协作流程 ' + path, request: { params: projectParams.extend(extras), ...(method === 'get' && (path === '/tasks' || path === '/proposals') ? { query: z.object({ cursor: z.string().optional(), limit: z.string().optional() }) } : {}), ...(body ? { body: { required: true, content: { 'application/json': { schema: body } } } } : {}) }, responses: { [status]: { description: '成功', content: { 'application/json': { schema: apiEnvelope(out as z.ZodType, name as string) } } } } });
    app.openapi(r, (async (c: Context<AppEnv>) => {
        if (method === 'post' && path === '/tasks') {
            const idem = await withIdempotency(c.env, { key: c.req.header('idempotency-key'), userId: c.get('user')!.id, operation: 'collaboration.createTask', rawBody: JSON.stringify({ projectId: c.req.param('projectId'), body: await c.req.json() }) }, async () => {
                const response = await handler(c);
                const json = await response.json() as {
                    data: unknown;
                };
                return { status: response.status, body: json.data };
            });
            return c.json(apiData(c, idem.body), idem.status as 201);
        }
        return handler(c);
    }) as never);
}
async function settings(c: Context<AppEnv>) {
    const r = await c.env.DB.prepare('SELECT assignment_mode,evaluation_mode,collaboration_revision FROM projects WHERE id=?1').bind(c.req.param('projectId')).first<{
        assignment_mode: string;
        evaluation_mode: string;
        collaboration_revision: number;
    }>();
    if (!r)
        throw notFound();
    return { assignmentMode: r.assignment_mode, evaluationMode: r.evaluation_mode, revision: r.collaboration_revision };
}
const ids = (c: Context<AppEnv>) => ({ projectId: c.req.param('projectId')!, userId: c.get('user')!.id });
async function task(c: Context<AppEnv>) {
    const r = await c.env.DB.prepare('SELECT * FROM tasks WHERE id=?1 AND project_id=?2 AND lifecycle_state IS NOT NULL').bind(c.req.param('taskId'), c.req.param('projectId')).first<CollaborationTask>();
    if (!r)
        throw notFound('协作任务不存在');
    return r;
}
export function registerCollaborationRoutes(app: OpenAPIHono<AppEnv>): void {
    app.use('/api/v1/projects/:projectId/collaboration/*', requireUser, requireProjectMember());
    route(app, 'get', '/settings', undefined, async (c) => c.json(apiData(c, await settings(c))));
    route(app, 'patch', '/settings', z.object({ expectedRevision: revision, assignmentMode: mode.optional(), evaluationMode: mode.optional() }), async (c) => {
        const { projectId, userId } = ids(c);
        await owner(c.env, projectId, userId);
        const b = await c.req.json();
        const mark = newId();
        const results = await c.env.DB.batch([c.env.DB.prepare(`UPDATE projects SET assignment_mode=COALESCE(?3,assignment_mode),evaluation_mode=COALESCE(?4,evaluation_mode),collaboration_revision=collaboration_revision+1,collaboration_mutation_token=?5,updated_at=?7 WHERE id=?1 AND collaboration_revision=?2 AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?6 AND role='owner')`).bind(projectId, b.expectedRevision, b.assignmentMode ?? null, b.evaluationMode ?? null, mark, userId, nowIso()), c.env.DB.prepare(`INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) SELECT ?6,?2,'user',?3,'collaboration.settings_changed','project',?2,?1,?4,?5 WHERE EXISTS(SELECT 1 FROM projects WHERE id=?2 AND collaboration_mutation_token=?1)`).bind(mark, projectId, userId, JSON.stringify(b), nowIso(), newId())]);
        if (!results[0]!.meta.changes)
            throw invalidState('设置已变化');
        return c.json(apiData(c, await settings(c)));
    });
    route(app, 'get', '/tasks', undefined, async (c) => {
        const paging = parsePaging(c.req.query());
        const cursor = paging.cursor;
        const rows = await c.env.DB.prepare(`SELECT * FROM tasks WHERE project_id=?1 AND lifecycle_state IS NOT NULL
            AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3))
            ORDER BY created_at DESC,id DESC LIMIT ?4`)
            .bind(ids(c).projectId, cursor?.createdAt ?? null, cursor?.id ?? null, paging.limit + 1).all<CollaborationTask>();
        const page = rows.results.slice(0, paging.limit);
        const last = page.at(-1);
        return c.json(apiData(c, { items: page.map(toCollaborationTask), nextCursor: nextCursor(rows.results.length > paging.limit, last ? { createdAt: last.created_at, id: last.id } : undefined) ?? null }));
    });
    route(app, 'post', '/tasks', taskInput, async (c) => {
        const { projectId, userId } = ids(c);
        await owner(c.env, projectId, userId);
        const b = taskInput.parse(await c.req.json());
        const id = newId();
        const now = nowIso();
        const result = await c.env.DB.batch([c.env.DB.prepare(`INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria,effort_hours,parent_task_id) SELECT ?1,?2,?3,?4,'todo',1,?5,?6,?6,'open',?7,?8,?9 WHERE EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?5 AND role='owner') AND (?9 IS NULL OR EXISTS(SELECT 1 FROM tasks WHERE id=?9 AND project_id=?2 AND lifecycle_state IS NOT NULL))`).bind(id, projectId, b.title, b.detail, userId, now, b.criteria, b.effortHours, b.parentTaskId), audit(c.env, projectId, userId, 'collaboration.task_created', id, { title: b.title }, true)]);
        if (!result[0]!.meta.changes)
            throw validationFailed('父任务无效或权限已变化');
        const row = await c.env.DB.prepare('SELECT * FROM tasks WHERE id=?1').bind(id).first<CollaborationTask>();
        return c.json(apiData(c, toCollaborationTask(row!)), 201);
    }, 201);
    route(app, 'patch', '/tasks/{taskId}', z.object({ expectedRevision: revision, title: z.string().min(1).max(200).optional(), detail: z.string().max(4000).optional(), criteria: z.string().min(1).max(4000).optional(), effortHours: z.number().min(.25).max(200).optional() }).strict(), async (c) => {
        const { projectId, userId } = ids(c);
        await owner(c.env, projectId, userId);
        const b = await c.req.json();
        const results = await c.env.DB.batch([c.env.DB.prepare(`UPDATE tasks SET title=COALESCE(?4,title),detail=COALESCE(?5,detail),criteria=COALESCE(?6,criteria),effort_hours=COALESCE(?7,effort_hours),revision=revision+1,updated_at=?8 WHERE id=?1 AND project_id=?2 AND revision=?3 AND lifecycle_state IN ('open','in_progress','improve','rework') AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?9 AND role='owner')`).bind(c.req.param('taskId'), projectId, b.expectedRevision, b.title ?? null, b.detail ?? null, b.criteria ?? null, b.effortHours ?? null, nowIso(), userId), audit(c.env, projectId, userId, 'collaboration.task_edited', c.req.param('taskId')!, b, true)]);
        if (!results[0]!.meta.changes)
            throw invalidState('任务已提交、已验收或版本已变化');
        return c.json(apiData(c, toCollaborationTask(await task(c))));
    });
    for (const action of ['claim', 'assign'] as const)
        route(app, 'post', '/tasks/{taskId}/' + action, action === 'claim' ? z.object({ expectedRevision: revision }) : z.object({ expectedRevision: revision, assigneeId: z.string().uuid(), reason: z.string().min(1).max(2000) }), async (c) => {
            const { projectId, userId } = ids(c);
            const b = await c.req.json();
            if (action === 'assign')
                await owner(c.env, projectId, userId);
            const assignee = action === 'claim' ? userId : b.assigneeId;
            const condition = action === 'claim' ? "lifecycle_state='open' AND assignee_id IS NULL" : "lifecycle_state IN ('open','in_progress','improve','rework','submitted')";
            const result = await c.env.DB.batch([c.env.DB.prepare(`UPDATE tasks SET assignee_id=?3,current_submission_id=NULL,status='doing',lifecycle_state='in_progress',revision=revision+1,updated_at=?4 WHERE id=?1 AND project_id=?2 AND revision=?5 AND ${condition} AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?3) AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?6 AND (?7=0 OR role='owner'))`).bind(c.req.param('taskId'), projectId, assignee, nowIso(), b.expectedRevision, userId, action === 'assign' ? 1 : 0), audit(c.env, projectId, userId, 'collaboration.' + action, c.req.param('taskId')!, b, true)]);
            if (!result[0]!.meta.changes)
                throw invalidState('任务已被领取、成员或版本已变化');
            return c.json(apiData(c, toCollaborationTask(await task(c))));
        });
    route(app, 'get', '/tasks/{taskId}/submissions', undefined, async (c) => { await task(c); const rows = await c.env.DB.prepare('SELECT * FROM task_submissions WHERE task_id=?1 AND project_id=?2 ORDER BY round DESC').bind(c.req.param('taskId'), ids(c).projectId).all<Submission>(); const items = await Promise.all(rows.results.map(async (row) => { const versions = await c.env.DB.prepare('SELECT v.id AS versionId,m.id AS materialId,m.title,v.revision FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE m.project_id=?1 AND v.id IN(SELECT value FROM json_each(?2))').bind(ids(c).projectId, row.material_versions_json).all(); return { ...toSubmission(row), materialVersions: versions.results }; })); return c.json(apiData(c, { items })); });
    route(app, 'post', '/tasks/{taskId}/submissions', z.object({ expectedRevision: revision, body: z.string().min(1).max(30000), materialVersionIds: z.array(z.string().uuid()).max(10).default([]) }), async (c) => {
        const { projectId, userId } = ids(c);
        const b = await c.req.json();
        const t = await task(c);
        if (t.assignee_id !== userId)
            throw permissionDenied('仅当前负责人可提交');
        const versions: string[] = b.materialVersionIds ?? [];
        if (new Set(versions).size !== versions.length)
            throw validationFailed('版本不可重复');
        const id = newId();
        const now = nowIso();
        const results = await c.env.DB.batch([c.env.DB.prepare(`INSERT INTO task_submissions(id,project_id,task_id,round,submitted_by,body,material_versions_json,criteria,task_revision,created_at,updated_at) SELECT ?1,?2,id,1+COALESCE((SELECT MAX(round) FROM task_submissions WHERE task_id=?3),0),?4,?5,?6,criteria,revision+1,?7,?7 FROM tasks WHERE id=?3 AND project_id=?2 AND assignee_id=?4 AND revision=?8 AND lifecycle_state IN ('in_progress','improve','rework') AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?4) AND NOT EXISTS(SELECT 1 FROM json_each(?6) j WHERE NOT EXISTS(SELECT 1 FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.id=j.value AND m.project_id=?2)) AND (SELECT COUNT(*) FROM task_submissions WHERE task_id=?3)<20`).bind(id, projectId, t.id, userId, b.body, JSON.stringify(versions), now, b.expectedRevision), c.env.DB.prepare(`UPDATE tasks SET lifecycle_state='submitted',current_submission_id=?1,revision=revision+1,updated_at=?2 WHERE id=?3 AND EXISTS(SELECT 1 FROM task_submissions WHERE id=?1)`).bind(id, now, t.id), audit(c.env, projectId, userId, 'collaboration.submitted', id, { taskId: t.id }, true)]);
        if (!results[0]!.meta.changes)
            throw invalidState('任务已变化、材料不属于本项目或已达20轮上限');
        let evaluationError: string | undefined;
        try {
            await enqueueEvaluation(c.env, projectId, id, userId);
        }
        catch (error) {
            evaluationError = error instanceof Error ? error.message : 'AI评价暂不可用，可手动重试或请负责人验收';
        }
        const row = await c.env.DB.prepare('SELECT * FROM task_submissions WHERE id=?1').bind(id).first<Submission>();
        return c.json(apiData(c, { ...toSubmission(row!), ...(evaluationError ? { evaluationError } : {}) }), 201);
    }, 201);
    route(app, 'post', '/submissions/{submissionId}/decide', z.object({ expectedRevision: revision, decision: z.enum(['accept', 'improve', 'rework']), feedback: z.string().min(1).max(5000) }), async (c) => { const { projectId, userId } = ids(c); const b = await c.req.json(); await decideSubmission(c.env, projectId, c.req.param('submissionId')!, b.expectedRevision, b.decision, b.feedback, userId); const row = await c.env.DB.prepare('SELECT * FROM task_submissions WHERE id=?1').bind(c.req.param('submissionId')).first<Submission>(); return c.json(apiData(c, toSubmission(row!))); });
    route(app, 'get', '/proposals', undefined, async (c) => {
        const paging = parsePaging(c.req.query());
        const cursor = paging.cursor;
        const rows = await c.env.DB.prepare(`SELECT * FROM collaboration_proposals WHERE project_id=?1
            AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3))
            ORDER BY created_at DESC,id DESC LIMIT ?4`)
            .bind(ids(c).projectId, cursor?.createdAt ?? null, cursor?.id ?? null, paging.limit + 1).all<Proposal>();
        const page = rows.results.slice(0, paging.limit);
        const last = page.at(-1);
        return c.json(apiData(c, { items: page.map(toProposal), nextCursor: nextCursor(rows.results.length > paging.limit, last ? { createdAt: last.created_at, id: last.id } : undefined) ?? null }));
    });
    route(app, 'post', '/proposals/{proposalId}/apply', z.object({ expectedRevision: revision }), async (c) => { const { projectId, userId } = ids(c); const b = await c.req.json(); await applyProposal(c.env, projectId, c.req.param('proposalId')!, b.expectedRevision, userId); return c.json(apiData(c, { applied: true })); });
    for (const operation of ['decompose', 'assign', 'evaluate'] as const) {
        const path = operation === 'evaluate' ? '/submissions/{submissionId}/evaluate' : '/' + operation;
        const schema = operation === 'decompose' ? z.object({ brief: z.string().min(1).max(12000) }) : operation === 'assign' ? z.object({ taskIds: z.array(z.string().uuid()).min(1).max(20) }) : z.object({});
        route(app, 'post', path, schema, async (c) => {
            const { projectId, userId } = ids(c);
            const b = schema.parse(await c.req.json()) as Record<string, unknown>;
            if (operation !== 'evaluate')
                await owner(c.env, projectId, userId);
            const idem = await withIdempotency(c.env, { key: c.req.header('idempotency-key'), userId, operation: 'collaboration.' + operation, rawBody: JSON.stringify({ projectId, submissionId: c.req.param('submissionId'), ...b }) }, async () => {
                const config = await loadAiConfig(c.env.DB);
                if (!config?.enabled)
                    throw aiUnavailable('AI 未启用');
                const s = await settings(c);
                const input: Record<string, unknown> = { operation: 'collaboration.' + operation, projectId, requestedBy: userId, settingsRevision: s.revision, ...b };
                if (operation === 'assign') {
                    const tasks = await c.env.DB.prepare(`SELECT * FROM tasks WHERE project_id=?1 AND id IN(SELECT value FROM json_each(?2)) AND lifecycle_state='open' AND assignee_id IS NULL`).bind(projectId, JSON.stringify(b.taskIds)).all<CollaborationTask>();
                    if (tasks.results.length !== (b.taskIds as string[]).length)
                        throw invalidState('请选择未领取的协作任务');
                    input.tasks = tasks.results.map(t => ({ taskId: t.id, title: t.title, detail: t.detail, criteria: t.criteria, effortHours: t.effort_hours, revision: t.revision }));
                    const members = await c.env.DB.prepare(`SELECT pm.user_id,pm.major,pm.skills_json,pm.hours_per_week,COALESCE((SELECT SUM(effort_hours) FROM tasks WHERE project_id=pm.project_id AND assignee_id=pm.user_id AND status!='done'),0) load_hours FROM project_members pm WHERE pm.project_id=?1`).bind(projectId).all<{
                        user_id: string;
                        major: string;
                        skills_json: string;
                        hours_per_week: number | null;
                        load_hours: number;
                    }>();
                    input.members = members.results.map(m => ({ userId: m.user_id, major: m.major, skills: JSON.parse(m.skills_json), hoursPerWeek: m.hours_per_week, loadHours: m.load_hours }));
                }
                if (operation === 'evaluate')
                    return { status: 202 as const, body: { jobId: await enqueueEvaluation(c.env, projectId, c.req.param('submissionId')!, userId) } };
                return withReservedAiJob(c.env, { projectId, purpose: 'assignment_suggest' }, async (jobId, configVersionId) => {
                    try {
                        await createJobAndDispatch(c.env, { projectId, kind: 'agent_run', jobId, createdBy: userId, input: { ...input, configVersionId } });
                    }
                    catch (error) {
                        throw error;
                    }
                    return { status: 202 as const, body: { jobId } };
                });
            });
            return c.json(apiData(c, idem.body), idem.status);
        }, 202);
    }
}
