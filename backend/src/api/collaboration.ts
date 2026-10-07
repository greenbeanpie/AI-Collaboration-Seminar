import { triggerProjectFileProcessing } from '../services/file-processing-triggers';
import { aiActivitySchema, readActivity } from '../services/ai-activity';
import { registerCollaborationReadRoutes } from './collaboration-read';
import { readTaskPage } from '../services/collaboration-read-models';
import { submitCollaborationTask } from '../services/collaboration-submission';
import { currentProjectFeedback, projectFeedbackHistory, saveProjectFeedback } from '../services/project-feedback';
import { assertCanRegenerate } from '../services/task-planning-policy';
import { projectOwnerSql, projectPermissionSql, requireProjectPermission } from '../services/project-permissions';
import { taskSummarySchema, enqueueTaskSummary } from '../services/task-summary';
import { readProjectSourceContext } from '../services/collaboration-context';
import { calculateRubricWeightedTotal, continueConfirmedPlan, projectSourceCitationSchema, rubricScoringSchema } from '../services/collaboration-ai';
import { profileStamp } from '../services/personal-profiles';
import { loadAiConfig } from '../ai/config';
import { aiUnavailable } from '../core/errors';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { requireProjectMember, requireUser } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, permissionDenied, validationFailed } from '../core/errors';
import { withIdempotency } from '../services/idempotency';
import { withReservedAiJob } from '../services/ai-reservations';
import { createJobAndDispatch } from '../services/jobs';
import { applyProposal, reviseProposal, audit, decideSubmission, owner, toCollaborationTask, toProposal, toSubmission, type CollaborationTask, type Proposal, type Submission } from '../services/collaboration';
import { projectParams } from './projects';
import { projectGoal } from '../services/project-simplification';
import { loadResourceVersionText } from '../services/resources';
import { assertEffectiveStandard, effectiveStandardGuardSql } from '../services/effective-standard';
const feedbackSnapshotSchema = z.object({versionId:z.string().nullable(),version:z.number().int().nonnegative(),feedback:z.string(),actorId:z.string().nullable(),createdAt:z.string().nullable()});
const revision = z.number().int().positive();
const mode = z.enum(['manual', 'automatic']);
const taskInput = z.object({ title: z.string().min(1).max(200), detail: z.string().max(4000).default(''), criteria: z.string().min(1).max(4000), effortHours: z.number().min(.25).max(200).default(1) }).strict();
const settingsSchema = z.object({ aiCollaborationEnabled: z.boolean(), assignmentMode: mode, evaluationMode: mode, planningMode:mode, progressionMode:mode, revision });
const citationReferenceSchema = projectSourceCitationSchema.extend({ availability: z.literal('unavailable').optional(), deletedAt: z.string().nullable().optional() });
const taskSchema = z.object({ pendingHumanReview:z.boolean().optional(), startedAt:z.string().nullable().optional(),archivedAt:z.string().nullable().optional(),taskId: z.string().uuid(), title: z.string(), detail: z.string(), status: z.enum(['todo', 'doing', 'blocked', 'done']), assigneeId: z.string().uuid().nullable(), revision, lifecycleState: z.enum(['open', 'in_progress', 'submitted', 'accepted', 'improve', 'rework']), criteria: z.string(), citations: z.array(citationReferenceSchema).optional(), effortHours: z.number(), dueDate: z.string().nullable().optional(), currentSubmissionId: z.string().uuid().nullable(), dependsOnTaskIds:z.array(z.string().uuid()),unfinishedDependencyIds:z.array(z.string().uuid()),createdAt: z.string(), updatedAt: z.string() }).extend(taskSummarySchema.partial().shape);
const decisionSchema = z.enum(['accept', 'improve', 'rework']);
const reportSchema = z.object({ modelCoverage:z.enum(['complete','needs_human']).optional(),humanReview:z.object({status:z.enum(['pending','resolved']),reasonCodes:z.array(z.enum(['unread_attachments','unread_references'])),reasons:z.array(z.string()),decision:z.enum(['accept','improve','rework']).optional(),decidedBy:z.string().uuid().optional(),decidedAt:z.string().optional()}).optional(), references:z.array(z.unknown()).optional(),decisionReferences:z.array(z.unknown()).optional(),decision: decisionSchema, feedback: z.string(), evidence: z.array(z.object({ materialVersionId: z.string().uuid(), quote: z.string() })), limitations: z.array(z.string()), coverage: z.enum(['complete', 'needs_human']), manualReviewReason: z.string().optional(), rubricScoring: rubricScoringSchema.optional() });
export const submissionSchema = z.object({pendingHumanReview:z.boolean().optional(), submissionId: z.string().uuid(), taskId: z.string().uuid(), round: z.number(), submittedBy: z.string().uuid(), body: z.string(), materialVersionIds: z.array(z.string().uuid()), materialVersions: z.array(z.object({ versionId: z.string().uuid(), materialId: z.string().uuid(), title: z.string(), revision: z.number() })).optional(), criteria: z.string(), status: z.enum(['pending', 'evaluated', 'accept', 'improve', 'rework']), aiDecision: decisionSchema.nullable(), aiFeedback: z.string().nullable(), aiReport: reportSchema.nullable(), humanScoreOverride: z.object({ kind: z.literal('assistive'), standardsVersionId:z.string().uuid().optional(), rubricVersionId: z.string().uuid(), rubricVersion: revision, scores: z.array(z.object({ key: z.string(), score: z.number() })), weightedTotal: z.number(), reason: z.string(), decidedBy: z.string().uuid(), decidedAt: z.string() }).nullable().optional(), decision: decisionSchema.nullable(), feedback: z.string().nullable(), evaluationJobId: z.string().uuid().nullable(), evaluationAttempts: z.number(), evaluationError: z.string().optional(), revision, createdAt: z.string(), updatedAt: z.string() });
const proposalSchema = z.object({ proposalId: z.string().uuid(), kind: z.enum(['decompose', 'assign']), payload: z.object({ planningAction:z.enum(['regenerate','adjust']).optional(),references:z.array(z.unknown()).optional(),decisionReferences:z.array(z.unknown()).optional(),causeEventId:z.string().optional(),progression:z.boolean().optional(),goal:z.object({title:z.string(),detail:z.string()}).optional(),brief: z.string().optional(), sourceVersionIds: z.array(z.string().uuid()).optional(), tasks: z.array(taskInput.extend({ key:z.string().optional(),dependsOn:z.array(z.string()).optional(),citations: z.array(projectSourceCitationSchema).optional() })).optional(), updates: z.array(taskInput.extend({ taskId: z.string().uuid(), expectedRevision: revision, citations: z.array(projectSourceCitationSchema).optional() })).optional(), assignments: z.array(z.object({ taskId: z.string().uuid(), assigneeId: z.string().uuid().nullable(), expectedRevision: revision, reason: z.string() })).optional(), considerations: z.array(z.string()).optional() }), status: z.enum(['pending', 'applied', 'stale']), revision, createdAt: z.string() });
function route(app: OpenAPIHono<AppEnv>, method: 'get' | 'post' | 'patch', path: string, body: z.ZodType | undefined, handler: (c: Context<AppEnv>) => Promise<Response>, status: 200 | 201 | 202 = 200) {
    const extras: Record<string, z.ZodString> = {};
    for (const match of path.matchAll(/\{(\w+)\}/g))
        extras[match[1]!] = z.string().uuid();
    const [out, name] = path === '/feedback/current' ? [feedbackSnapshotSchema,'ProjectFeedbackCurrentResponse'] : path === '/feedback/history' ? [z.object({items:z.array(feedbackSnapshotSchema)}),'ProjectFeedbackHistoryResponse'] : path.endsWith('/summary') ? [taskSummarySchema, 'CollaborationTaskSummaryResponse'] : path === '/settings' ? [settingsSchema, 'CollaborationSettingsResponse'] : status === 202 ? [z.object({ jobId: z.string().uuid() }), 'CollaborationJobResponse'] : path.endsWith('/apply') ? [z.object({ applied: z.boolean(),followupJobId:z.string().uuid().nullable().optional(),followupError:z.string().nullable().optional() }), 'CollaborationApplyResponse'] : path === '/feedback' ? [z.object({feedbackId:z.string().uuid(),queued:z.boolean()}),'CollaborationFeedbackResponse'] : path.includes('/proposals/') && method==='patch' ? [proposalSchema,'CollaborationProposalResponse'] : path === '/proposals' ? [z.object({ items: z.array(proposalSchema), nextCursor: z.string().nullable() }), 'CollaborationProposalListResponse'] : path.includes('submissions') ? [method === 'get' ? z.object({ items: z.array(submissionSchema), nextCursor: z.string().nullable() }) : submissionSchema, method === 'get' ? 'CollaborationSubmissionListResponse' : 'CollaborationSubmissionResponse'] : path === '/tasks' && method === 'get' ? [z.object({ items: z.array(taskSchema), nextCursor: z.string().nullable() }), 'CollaborationTaskListResponse'] : [taskSchema, 'CollaborationTaskResponse'];
    const r = createRoute({ method, path: '/api/v1/projects/{projectId}/collaboration' + path, tags: ['collaboration'], summary: '协作流程 ' + path, request: { params: projectParams.extend(extras), ...(method === 'get' && (path === '/tasks' || path === '/proposals' || path.endsWith('/submissions')) ? { query: z.object({ cursor: z.string().optional(), limit: z.string().optional(), q:z.string().max(200).optional(), lifecycleState:z.enum(['open','in_progress','submitted','accepted','improve','rework']).optional(), pendingReview:z.enum(['true','false']).optional() }) } : {}), ...(body ? { body: { required: true, content: { 'application/json': { schema: body } } } } : {}) }, responses: { [status]: { description: '成功', content: { 'application/json': { schema: apiEnvelope(out as z.ZodType, name as string) } } } } });
    const dispatch = (async (c: Context<AppEnv>) => {
        if (method === 'post' && (path === '/tasks' || path === '/tasks/{taskId}/submissions')) {
            const idem = await withIdempotency(c.env, { key: c.req.header('idempotency-key'), userId: c.get('user')!.id, operation: path === '/tasks' ? 'collaboration.createTask' : 'collaboration.submitTask', rawBody: JSON.stringify({ projectId: c.req.param('projectId'), ...(path === '/tasks' ? {} : { taskId: c.req.param('taskId') }), body: await c.req.json() }) }, async () => {
                const response = await handler(c);
                const json = await response.json() as {
                    data: unknown;
                };
                return { status: response.status, body: json.data };
            });
            return c.json(apiData(c, idem.body), idem.status as 201);
        }
        return handler(c);
    }) as never;
    app.openapi(r,dispatch);
    if(path.startsWith('/tasks/'))app.openapi({...r,path:'/api/v1/projects/{projectId}'+path},dispatch);
}
async function settings(c: Context<AppEnv>) {
    const r = await c.env.DB.prepare('SELECT ai_collaboration_enabled,assignment_mode,evaluation_mode,planning_mode,progression_mode,collaboration_revision FROM projects WHERE id=?1').bind(c.req.param('projectId')).first<{
        ai_collaboration_enabled: number;
        assignment_mode: string;
        evaluation_mode: string; planning_mode: string; progression_mode:string;
        collaboration_revision: number;
    }>();
    if (!r)
        throw notFound();
    return { aiCollaborationEnabled: r.ai_collaboration_enabled === 1, assignmentMode: r.assignment_mode, evaluationMode: r.evaluation_mode, planningMode:r.planning_mode??'manual', progressionMode:r.progression_mode??'manual', revision: r.collaboration_revision };
}
const ids = (c: Context<AppEnv>) => ({ projectId: c.req.param('projectId')!, userId: c.get('user')!.id });
async function task(c: Context<AppEnv>) {
    const r = await c.env.DB.prepare('SELECT * FROM tasks WHERE id=?1 AND project_id=?2').bind(c.req.param('taskId'), c.req.param('projectId')).first<CollaborationTask>();
    if (!r || (r as CollaborationTask & {archived_at?:string}).archived_at)
        throw notFound('协作任务不存在或已归档');
    return r;
}
async function taskWithReferences(c: Context<AppEnv>, row: CollaborationTask) {
    return {...toCollaborationTask(row),...(await readTaskPage(c.env,[row])).get(row.id)};
}
export function registerCollaborationRoutes(app: OpenAPIHono<AppEnv>): void {
    app.use('/api/v1/projects/:projectId/collaboration/*', requireUser, requireProjectMember());
    registerCollaborationReadRoutes(app,route);
    app.openapi(createRoute({method:'get',path:'/api/v1/projects/{projectId}/collaboration/ai-activity',tags:['collaboration'],request:{params:projectParams},responses:{200:{description:'任务规划与分工最近 AI 活动',content:{'application/json':{schema:apiEnvelope(z.object({jobId:z.string().uuid().nullable(),activity:aiActivitySchema.nullable()}),'CollaborationAiActivityResponse')}}}}}),async c=>{
      const row=await c.env.DB.prepare("SELECT id,status FROM jobs WHERE project_id=?1 AND json_extract(input_json,'$.operation') IN ('collaboration.decompose','collaboration.assign','collaboration.adjust','collaboration.progression') ORDER BY created_at DESC,id DESC LIMIT 1").bind(c.req.valid('param').projectId).first<{id:string;status:string}>();
      return c.json(apiData(c,{jobId:row?.id??null,activity:row?await readActivity(c.env,row.id,row.status):null}),200);
    });
    route(app, 'get', '/settings', undefined, async (c) => c.json(apiData(c, await settings(c))));
    route(app, 'patch', '/settings', z.object({ expectedRevision: revision, aiCollaborationEnabled: z.boolean().optional(), assignmentMode: mode.optional(), evaluationMode: mode.optional(), planningMode:mode.optional(),progressionMode:mode.optional() }), async (c) => {
        const { projectId, userId } = ids(c);
        await owner(c.env, projectId, userId, 'owner');
        const b = await c.req.json();
        const mark = newId();
        const results = await c.env.DB.batch([c.env.DB.prepare(`UPDATE projects SET ai_collaboration_enabled=COALESCE(?8,ai_collaboration_enabled),assignment_mode=COALESCE(?3,assignment_mode),evaluation_mode=COALESCE(?4,evaluation_mode),planning_mode=COALESCE(?9,planning_mode),progression_mode=COALESCE(?10,progression_mode),collaboration_revision=collaboration_revision+1,collaboration_mutation_token=?5,updated_at=?7 WHERE id=?1 AND collaboration_revision=?2 AND ${projectOwnerSql('?1','?6')}`).bind(projectId, b.expectedRevision, b.assignmentMode ?? null, b.evaluationMode ?? null, mark, userId, nowIso(), b.aiCollaborationEnabled === undefined ? null : b.aiCollaborationEnabled ? 1 : 0,b.planningMode??null,b.progressionMode??null), c.env.DB.prepare(`INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) SELECT ?6,?2,'user',?3,'collaboration.settings_changed','project',?2,?1,?4,?5 WHERE EXISTS(SELECT 1 FROM projects WHERE id=?2 AND collaboration_mutation_token=?1)`).bind(mark, projectId, userId, JSON.stringify(b), nowIso(), newId())]);
        if (!results[0]!.meta.changes)
            throw invalidState('设置已变化');
        if (b.aiCollaborationEnabled === true) c.executionCtx.waitUntil(triggerProjectFileProcessing(c.env, projectId));
        return c.json(apiData(c, await settings(c)));
    });
    route(app, 'post', '/tasks/{taskId}/summary', z.object({retry:z.boolean().optional()}).strict(), async c => {
        const {projectId,userId}=ids(c); const body=await c.req.json();
        return c.json(apiData(c,await enqueueTaskSummary(c.env,projectId,c.req.param('taskId')!,userId,body.retry===true)));
    });
    route(app, 'post', '/tasks', taskInput, async (c) => {
        const { projectId, userId } = ids(c);
        await owner(c.env, projectId, userId);
        const b = taskInput.parse(await c.req.json());
        const id = newId();
        const now = nowIso();
        const goal=await projectGoal(c.env,projectId),token=newId();
        const result = await c.env.DB.batch([c.env.DB.prepare(`UPDATE project_goals SET graph_revision=graph_revision+1,graph_token=?3 WHERE project_id=?1 AND graph_revision=?2 AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?4 AND ${projectPermissionSql('project_members.project_id','project_members.user_id','taskManage')})`).bind(projectId,goal.graphRevision,token,userId),c.env.DB.prepare(`INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria,effort_hours) SELECT ?1,?2,?3,?4,'todo',1,?5,?6,?6,'open',?7,?8 WHERE EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?5 AND ${projectPermissionSql('project_members.project_id','project_members.user_id','taskManage')}) AND EXISTS(SELECT 1 FROM project_goals WHERE project_id=?2 AND graph_token=?9)`).bind(id, projectId, b.title, b.detail, userId, now, b.criteria, b.effortHours,token), audit(c.env, projectId, userId, 'collaboration.task_created', id, { title: b.title }, true)]);
        if (!result[0]!.meta.changes||!result[1]!.meta.changes)
            throw validationFailed('任务图版本或权限已变化');
        const row = await c.env.DB.prepare('SELECT * FROM tasks WHERE id=?1').bind(id).first<CollaborationTask>();
        return c.json(apiData(c, await taskWithReferences(c, row!)), 201);
    }, 201);
    route(app, 'patch', '/tasks/{taskId}', z.object({ expectedRevision: revision, title: z.string().min(1).max(200).optional(), detail: z.string().max(4000).optional(), criteria: z.string().min(1).max(4000).optional(), effortHours: z.number().min(.25).max(200).optional() }).strict(), async (c) => {
        const { projectId, userId } = ids(c);
        await owner(c.env, projectId, userId);
        const b = await c.req.json();
        const results = await c.env.DB.batch([c.env.DB.prepare(`UPDATE tasks SET title=COALESCE(?4,title),detail=COALESCE(?5,detail),criteria=COALESCE(?6,criteria),effort_hours=COALESCE(?7,effort_hours),revision=revision+1,updated_at=?8 WHERE id=?1 AND project_id=?2 AND revision=?3 AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?9 AND ${projectPermissionSql('project_members.project_id','project_members.user_id','taskManage')})`).bind(c.req.param('taskId'), projectId, b.expectedRevision, b.title ?? null, b.detail ?? null, b.criteria ?? null, b.effortHours ?? null, nowIso(), userId), audit(c.env, projectId, userId, 'collaboration.task_edited', c.req.param('taskId')!, b, true)]);
        if (!results[0]!.meta.changes)
            throw invalidState('任务版本或权限已变化');
        return c.json(apiData(c, await taskWithReferences(c, await task(c))));
    });
    for (const action of ['claim', 'assign'] as const)
        route(app, 'post', '/tasks/{taskId}/' + action, action === 'claim' ? z.object({ expectedRevision: revision }) : z.object({ expectedRevision: revision, assigneeId: z.string().uuid().nullable(), reason: z.string().min(1).max(2000) }), async (c) => {
            const { projectId, userId } = ids(c);
            const b = await c.req.json();
            if (action === 'assign')
                await owner(c.env, projectId, userId);
            const assignee = action === 'claim' ? userId : b.assigneeId;
            const condition = action === 'claim' ? "(lifecycle_state='open' OR (lifecycle_state IS NULL AND status!='done')) AND assignee_id IS NULL" : "1=1";
            const result = await c.env.DB.batch([c.env.DB.prepare(`UPDATE tasks SET assignee_id=?3,current_submission_id=CASE WHEN lifecycle_state='accepted' THEN current_submission_id ELSE NULL END,status=CASE WHEN lifecycle_state='accepted' THEN status WHEN ?3 IS NULL THEN 'todo' ELSE 'doing' END,lifecycle_state=CASE WHEN lifecycle_state='accepted' THEN lifecycle_state WHEN ?3 IS NULL THEN 'open' ELSE 'in_progress' END,revision=revision+1,updated_at=?4 WHERE id=?1 AND project_id=?2 AND archived_at IS NULL AND revision=?5 AND ${condition} AND (?3 IS NULL OR EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?3)) AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?6 AND (?7=0 OR ${projectPermissionSql('project_members.project_id','project_members.user_id','taskManage')}))`).bind(c.req.param('taskId'), projectId, assignee, nowIso(), b.expectedRevision, userId, action === 'assign' ? 1 : 0), audit(c.env, projectId, userId, 'collaboration.' + action, c.req.param('taskId')!, b, true)]);
            if (!result[0]!.meta.changes)
                throw invalidState('任务已被领取、成员或版本已变化');
            return c.json(apiData(c, await taskWithReferences(c, await task(c))));
        });
    route(app, 'post', '/tasks/{taskId}/submissions', z.object({ expectedRevision: revision, body: z.string().min(1).max(30000), materialVersionIds: z.array(z.string().uuid()).max(10).default([]) }), async (c) => {
        const { projectId, userId } = ids(c);
        const b = await c.req.json();
        const result = await submitCollaborationTask(c.env,{projectId,taskId:c.req.param('taskId')!,userId,expectedRevision:b.expectedRevision,body:b.body,materialVersionIds:b.materialVersionIds ?? []});
        return c.json(apiData(c,result),201);
    }, 201);
    route(app, 'post', '/submissions/{submissionId}/decide', z.object({ expectedRevision: revision, decision: z.enum(['accept', 'improve', 'rework']), feedback: z.string().min(1).max(5000) }), async (c) => { const { projectId, userId } = ids(c); const b = await c.req.json(); await decideSubmission(c.env, projectId, c.req.param('submissionId')!, b.expectedRevision, b.decision, b.feedback, userId); const row = await c.env.DB.prepare('SELECT * FROM task_submissions WHERE id=?1').bind(c.req.param('submissionId')).first<Submission>(); return c.json(apiData(c, toSubmission(row!))); });
    route(app, 'post', '/submissions/{submissionId}/scores', z.object({ expectedRevision: revision, scores: z.array(z.object({ key: z.string().min(1).max(40), score: z.number().min(0).max(100) }).strict()).min(1).max(10), reason: z.string().trim().min(1).max(2000) }).strict(), async (c) => {
        const { projectId, userId } = ids(c);
        await owner(c.env, projectId, userId);
        const b = await c.req.json() as { expectedRevision: number; scores: Array<{ key: string; score: number }>; reason: string };
        const submissionId = c.req.param('submissionId')!;
        const current = await c.env.DB.prepare('SELECT * FROM task_submissions WHERE id=?1 AND project_id=?2').bind(submissionId, projectId).first<Submission>();
        if (!current) throw notFound();
        const report = current.ai_report_json ? JSON.parse(current.ai_report_json) as { rubricScoring?: unknown } : null;
        const scoring = rubricScoringSchema.safeParse(report?.rubricScoring);
        if (!scoring.success || scoring.data.status !== 'scored') throw invalidState('本轮没有可复核的辅助评分；请先使用生效项目标准提交成果');
        const rubric = scoring.data;
        const active = await assertEffectiveStandard(c.env, projectId);
        if (rubric.standardsVersionId !== active.standardsVersionId) throw invalidState('本轮评分依据的项目标准已失效，请使用生效标准重新提交成果');
        if (new Set(b.scores.map(score => score.key)).size !== b.scores.length || b.scores.length !== rubric.weights.length || rubric.weights.some(weight => !b.scores.some(score => score.key === weight.key))) throw validationFailed('人工复核必须完整覆盖本轮评分标准，不能新增或遗漏维度');
        const weightedTotal = calculateRubricWeightedTotal(rubric.weights, b.scores);
        const override = { kind: 'assistive', standardsVersionId: active.standardsVersionId, rubricVersionId: rubric.rubricVersionId, rubricVersion: rubric.rubricVersion, scores: b.scores, weightedTotal, reason: b.reason, decidedBy: userId, decidedAt: nowIso() };
        const results = await c.env.DB.batch([c.env.DB.prepare(`UPDATE task_submissions SET human_score_override_json=?4,revision=revision+1,updated_at=?5 WHERE id=?1 AND project_id=?2 AND revision=?3 AND ai_report_json=?6 AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?7 AND ${projectPermissionSql('project_members.project_id','project_members.user_id','taskManage')}) AND ${effectiveStandardGuardSql('?2','?8')}`).bind(submissionId, projectId, b.expectedRevision, JSON.stringify(override), override.decidedAt, current.ai_report_json, userId, active.standardsVersionId), audit(c.env, projectId, userId, 'collaboration.scores_overridden', submissionId, override, true)]);
        if (!results[0]!.meta.changes) throw invalidState('提交评价或权限已变化，请重新核对评分');
        const updated = await c.env.DB.prepare('SELECT * FROM task_submissions WHERE id=?1').bind(submissionId).first<Submission>();
        return c.json(apiData(c, toSubmission(updated!)));
    });
    route(app, 'post', '/proposals/{proposalId}/apply', z.object({ expectedRevision: revision,selectedTaskKeys:z.array(z.string()).optional(),selectedUpdateTaskIds:z.array(z.string().uuid()).optional(),selectedAssignmentTaskIds:z.array(z.string().uuid()).optional() }), async (c) => { const { projectId, userId } = ids(c); const b = await c.req.json(); await applyProposal(c.env, projectId, c.req.param('proposalId')!, b.expectedRevision, userId,false,undefined,b); return c.json(apiData(c, { applied: true,...await continueConfirmedPlan(c.env,projectId,c.req.param('proposalId')!,userId) })); });
    route(app,'patch','/proposals/{proposalId}',z.object({expectedRevision:revision,payload:proposalSchema.shape.payload,reason:z.string().min(1).max(4000)}),async c=>{
      const {projectId,userId}=ids(c),b=await c.req.json();
      const proposal=await reviseProposal(c.env,projectId,c.req.param('proposalId')!,b.expectedRevision,b.payload,b.reason,userId);
      return c.json(apiData(c,toProposal(proposal)));
    });
    route(app,'post','/tasks/{taskId}/reopen',z.object({expectedRevision:revision,feedback:z.string().min(1).max(4000)}),async c=>{
      const {projectId,userId}=ids(c);await owner(c.env,projectId,userId);const b=await c.req.json(),row=await task(c);
      const results=await c.env.DB.batch([c.env.DB.prepare(`UPDATE tasks SET status=CASE WHEN assignee_id IS NULL THEN 'todo' ELSE 'doing' END,lifecycle_state=CASE WHEN assignee_id IS NULL THEN 'open' ELSE 'rework' END,revision=revision+1,updated_at=?4 WHERE id=?1 AND project_id=?2 AND revision=?3 AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?5 AND ${projectPermissionSql('project_members.project_id','project_members.user_id','taskManage')})`).bind(row.id,projectId,b.expectedRevision,nowIso(),userId),audit(c.env,projectId,userId,'collaboration.task_reopened',row.id,b,true)]);
      if(!results[0]!.meta.changes)throw invalidState('任务版本或权限已变化');
      return c.json(apiData(c,await taskWithReferences(c,await task(c))));
    });
    route(app,'get','/feedback/current',undefined,async c=>{const {projectId}=ids(c);return c.json(apiData(c,await currentProjectFeedback(c.env,projectId)));});
    route(app,'get','/feedback/history',undefined,async c=>{const {projectId}=ids(c);return c.json(apiData(c,{items:await projectFeedbackHistory(c.env,projectId)}));});
    route(app,'post','/feedback/current',z.object({feedback:z.string().max(12000),expectedVersion:z.number().int().nonnegative()}),async c=>{const {projectId,userId}=ids(c);const b=await c.req.json();return c.json(apiData(c,await saveProjectFeedback(c.env,projectId,userId,b.feedback,b.expectedVersion)));});
    route(app,'post','/feedback',z.object({feedback:z.string().min(1).max(12000),targetType:z.enum(['project','task','proposal','submission']).default('project'),targetId:z.string().uuid().optional(),requestAiRedo:z.boolean().default(false)}),async c=>{
      const {projectId,userId}=ids(c);await owner(c.env,projectId,userId);const b=await c.req.json(),id=newId();
      const type=b.targetType??'project';
      if(type==='project'){const current=await currentProjectFeedback(c.env,projectId);const saved=await saveProjectFeedback(c.env,projectId,userId,b.feedback,current.version);return c.json(apiData(c,{feedbackId:saved.versionId,queued:false}));}
      const tables:Record<string,string>={task:'tasks',proposal:'collaboration_proposals',submission:'task_submissions'};
      if(type!=='project'&&(!b.targetId||!await c.env.DB.prepare(`SELECT 1 FROM ${tables[type]} WHERE id=?1 AND project_id=?2`).bind(b.targetId,projectId).first()))throw validationFailed('反馈目标不属于项目');
      await c.env.DB.batch([c.env.DB.prepare(`INSERT INTO project_admin_feedback(id,project_id,actor_id,target_type,target_id,feedback,request_ai_redo,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?3 AND ${projectPermissionSql('project_members.project_id','project_members.user_id','taskManage')})`).bind(id,projectId,userId,type,b.targetId??null,b.feedback,b.requestAiRedo?1:0,nowIso()),audit(c.env,projectId,userId,'collaboration.admin_feedback',id,b,true)]);
      if(b.requestAiRedo)await c.env.DB.prepare("UPDATE collaboration_proposals SET status='stale',revision=revision+1,updated_at=?2 WHERE project_id=?1 AND status='pending'").bind(projectId,nowIso()).run();
      return c.json(apiData(c,{feedbackId:id,queued:false}));
    });
    for (const operation of ['decompose', 'assign'] as const) {
        const path = '/' + operation;
        const schema = operation === 'decompose' ? z.object({ allowSearch:z.boolean().default(false),searchQuery:z.string().trim().min(1).max(500).optional(),brief: z.string().min(1).max(12000), taskIds: z.array(z.string().uuid()).min(1).optional(), sourceVersionIds: z.array(z.string().uuid()).min(1).optional(),materialVersionIds:z.array(z.string().uuid()).max(10).optional() }).strict() : z.object({ taskIds: z.array(z.string().uuid()).min(1) });
        route(app, 'post', path, schema, async (c) => {
            const { projectId, userId } = ids(c);
            const b = schema.parse(await c.req.json()) as Record<string, unknown>;
            await owner(c.env, projectId, userId);
            if(operation==='decompose'&&!b.taskIds)await assertCanRegenerate(c.env,projectId);
            const idem = await withIdempotency(c.env, { key: c.req.header('idempotency-key'), userId, operation: 'collaboration.' + operation, rawBody: JSON.stringify({ projectId, submissionId: c.req.param('submissionId'), ...b }) }, async () => {
                const config = await loadAiConfig(c.env.DB);
                if (!config?.enabled)
                    throw aiUnavailable('AI 未启用');
                const s = await settings(c);
                if (!s.aiCollaborationEnabled || !await c.env.DB.prepare("SELECT 1 FROM projects WHERE id=?1 AND status='active'").bind(projectId).first()) throw aiUnavailable('本项目 AI 智能协作已关闭或项目已归档，可继续手动协作');
                const input: Record<string, unknown> = { operation: 'collaboration.' + operation, projectId, requestedBy: userId, settingsRevision: s.revision, ...b };
                if(operation==='decompose'){
                  input.planningAction=b.taskIds?'adjust':'regenerate';
                  if(!b.taskIds)await assertCanRegenerate(c.env,projectId);
                  const goal=await projectGoal(c.env,projectId);input.goalSnapshot=goal;input.goalRevision=goal.revision;input.graphRevision=goal.graphRevision;
                  const materialSnapshots=[];
                  for(const materialVersionId of (b.materialVersionIds??[]) as string[]){const row=await loadResourceVersionText(c.env,projectId,'material',materialVersionId);materialSnapshots.push({materialVersionId,title:row.title,markdown:row.text,revision:row.revision});}input.materialSnapshots=materialSnapshots;
                }
                if (operation === 'decompose' && b.sourceVersionIds) input.sourceSnapshots = await readProjectSourceContext(c.env, projectId, b.sourceVersionIds as string[]);
                if (operation === 'decompose' && b.taskIds) {
                    const selectedIds = b.taskIds as string[];
                    if (new Set(selectedIds).size !== selectedIds.length) throw validationFailed('调整范围不可重复');
                    const selected = await c.env.DB.prepare(`SELECT * FROM tasks WHERE project_id=?1 AND archived_at IS NULL AND id IN(SELECT value FROM json_each(?2)) AND (lifecycle_state IN ('open','in_progress','improve','rework') OR (lifecycle_state IS NULL AND status!='done'))`).bind(projectId, JSON.stringify(selectedIds)).all<CollaborationTask>();
                    if (selected.results.length !== selectedIds.length) throw invalidState('请选择本项目尚未提交、尚未验收的协作任务');
                    input.tasks = selected.results.map(t => ({ taskId: t.id, title: t.title, detail: t.detail, criteria: t.criteria, effortHours: t.effort_hours, revision: t.revision }));
                }
                if (operation === 'assign') {
                    const tasks = await c.env.DB.prepare(`SELECT * FROM tasks WHERE project_id=?1 AND archived_at IS NULL AND id IN(SELECT value FROM json_each(?2)) AND (lifecycle_state='open' OR (lifecycle_state IS NULL AND status!='done')) AND assignee_id IS NULL`).bind(projectId, JSON.stringify(b.taskIds)).all<CollaborationTask>();
                    if (tasks.results.length !== (b.taskIds as string[]).length)
                        throw invalidState('请选择未领取的协作任务');
                    input.tasks = tasks.results.map(t => ({ taskId: t.id, title: t.title, detail: t.detail, criteria: t.criteria, effortHours: t.effort_hours, revision: t.revision }));
                    const members = await c.env.DB.prepare(`SELECT pm.user_id,COALESCE((SELECT SUM(effort_hours) FROM tasks WHERE project_id=pm.project_id AND assignee_id=pm.user_id AND status!='done'),0) load_hours FROM project_members pm WHERE pm.project_id=?1`).bind(projectId).all<{
                        user_id: string;
                        load_hours: number;
                    }>();
                    input.profileStamp = await profileStamp(c.env, projectId);
                    input.members = members.results.map(m => ({ userId: m.user_id, loadHours: m.load_hours }));
                }
                return withReservedAiJob(c.env, { projectId, purpose: 'assignment_suggest',maxCalls:24 }, async (jobId, configVersionId) => {
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
