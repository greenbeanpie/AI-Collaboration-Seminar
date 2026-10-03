import { configureGoFixture, assertGoRequest } from './helpers/provider-config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env, BASE } from './helpers/env';
import type { Env } from '../src/env';
import { assignmentOutputSchema } from '../src/services/assignment';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { reserveAiSlot } from '../src/services/budget';
import { getJob } from '../src/services/jobs';
import { applyProposal, decideSubmission, pendingTaskHumanReview, toSubmission, type Submission } from '../src/services/collaboration';
import { continueConfirmedPlan, runCollaborationAiJob, assessEvidence, taskEvaluationSchema, decompositionSchema, type CollaborationAiInput } from '../src/services/collaboration-ai';
afterEach(() => vi.unstubAllGlobals());
await configureGoFixture();
const id = () => crypto.randomUUID();
const stamp = () => new Date().toISOString();
function model(content: unknown, before?: () => Promise<void>) {
    return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { assertGoRequest(url, init); await before?.(); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 30, completion_tokens: 25 } }), { headers: { 'content-type': 'application/json' } }); });
}
async function job(input: CollaborationAiInput) {
    const jobId = id();
    await reserveAiSlot(env, { projectId: input.projectId, jobId, purpose: input.operation === 'collaboration.evaluate' ? 'review_run' : 'assignment_suggest' });
    await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) VALUES(?1,?2,'agent_run','queued',?3,0,?4,?5,?5)").bind(jobId, input.projectId, JSON.stringify({ ...input, configVersionId: 'cfg-seed-v1' }), input.requestedBy, stamp()).run();
    return jobId;
}
async function fixture(mode = 'manual', attachments: unknown[] = [], markdown = '成果包含三个验证案例。') {
    const user = await seedUser();
    const projectId = await seedProject(user.userId);
    const taskId = id();
    const submissionId = id();
    const materialId = id();
    const versionId = id();
    const now = stamp();
    await env.DB.batch([
        env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1,evaluation_mode=?2 WHERE id=?1').bind(projectId, mode),
        env.DB.prepare("INSERT INTO tasks(id,project_id,title,assignee_id,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria,current_submission_id) VALUES(?1,?2,'验证案例',?3,'doing',2,?3,?4,?4,'submitted','至少三个验证案例',?5)").bind(taskId, projectId, user.userId, now, submissionId),
        env.DB.prepare("INSERT INTO materials(id,project_id,title,created_by,created_at,updated_at) VALUES(?1,?2,'成果',?3,?4,?4)").bind(materialId, projectId, user.userId, now),
        env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at,attachments_json) VALUES(?1,?2,?3,1,'{}',?4,'manual',?5,?6,?7)").bind(versionId, materialId, projectId, markdown, user.userId, now, JSON.stringify(attachments)),
        env.DB.prepare("INSERT INTO task_submissions(id,project_id,task_id,round,submitted_by,body,material_versions_json,criteria,task_revision,created_at,updated_at) VALUES(?1,?2,?3,1,?4,'完成',?5,'至少三个验证案例',2,?6,?6)").bind(submissionId, projectId, taskId, user.userId, JSON.stringify([versionId]), now),
    ]);
    const input: CollaborationAiInput = { operation: 'collaboration.evaluate', projectId, requestedBy: user.userId, settingsRevision: 1, submissionId };
    const jobId = await job(input);
    await env.DB.prepare('UPDATE task_submissions SET evaluation_job_id=?2 WHERE id=?1').bind(submissionId, jobId).run();
    return { user, projectId, taskId, submissionId, versionId, jobId, markdown };
}
function report(versionId: string, decision: 'accept' | 'improve' | 'rework' = 'accept', quote = '成果包含三个验证案例。') { return { decision, feedback: '成果证据满足当前标准', evidence: [{ materialVersionId: versionId, quote }], limitations: [], coverage: 'complete' }; }
describe('artifact-only evaluation safety', () => {
    it('strict schemas reject invented grade/person-ranking and empty criteria', () => {
        expect(assignmentOutputSchema.safeParse({ assignments: [{ taskId: id(), assigneeId: null, reason: '没有匹配成员', abilityRank: 1 }], considerations: [] }).success).toBe(false);
        expect(taskEvaluationSchema.safeParse({ ...report(id()), grade: 90 }).success).toBe(false);
        expect(decompositionSchema.safeParse({ tasks: [{ title: '目标', detail: '', criteria: '', effortHours: 1 }] }).success).toBe(false);
    });
    it('relative HTML and Markdown evidence references need human review', () => {
        const versionId = id();
        const evaluation = taskEvaluationSchema.parse(report(versionId));
        for (const link of ['<img src="/proof.png">', '[proof](/proof)', '[proof][source]', 'www.example.test']) {
            expect(assessEvidence(evaluation, [{ versionId, markdown: '成果包含三个验证案例。' + link, attachments: [] }]).join(' ')).toContain('引用内容未读取');
        }
    });
    it('evidence quotes must occur in the referenced immutable version', () => {
        const versionId = id();
        expect(() => assessEvidence(taskEvaluationSchema.parse(report(versionId, 'accept', '虚构句子')), [{ versionId, markdown: '实际文本', attachments: [] }])).toThrow('证据无效');
    });
    it.each([['manual', 'manual'], ['manual', 'automatic'], ['automatic', 'manual'], ['automatic', 'automatic']])('assignment %s and evaluation %s remain independent', async (assignmentMode, mode) => {
        const f = await fixture(mode);
        await env.DB.prepare('UPDATE projects SET assignment_mode=?2,planning_mode=?2 WHERE id=?1').bind(f.projectId, assignmentMode).run();
        vi.stubGlobal('fetch', model(report(f.versionId)));
        await runCollaborationAiJob(env, f.jobId);
        expect((await getJob(env, f.jobId)).status).toBe('succeeded');
        const state = await env.DB.prepare('SELECT lifecycle_state,status FROM tasks WHERE id=?1').bind(f.taskId).first<{
            lifecycle_state: string;
            status: string;
        }>();
        expect(state?.lifecycle_state).toBe(mode === 'automatic' ? 'accepted' : 'submitted');
        expect(state?.status).toBe(mode === 'automatic' ? 'done' : 'doing');
    });
    it('automatic mode provisionally completes unread attachments with an explicit review marker', async () => {
        const f = await fixture('automatic', [{ fileId: id(), name: '证据.pdf' }]);
        vi.stubGlobal('fetch', model(report(f.versionId)));
        await runCollaborationAiJob(env, f.jobId);
        const j = await getJob(env, f.jobId);
        expect(j.status).toBe('succeeded');
        expect(JSON.parse(j.result_json!).autoApplied).toBe(true);
        expect(JSON.parse(j.result_json!).manualReviewReasons.join(' ')).toContain('附件');
        const persisted = await env.DB.prepare('SELECT ai_report_json FROM task_submissions WHERE id=?1').bind(f.submissionId).first<{
            ai_report_json: string;
        }>();
        expect(JSON.parse(persisted!.ai_report_json)).toMatchObject({ coverage: 'needs_human' });
        expect(JSON.parse(persisted!.ai_report_json).manualReviewReason).toContain('附件');
        expect(JSON.parse(persisted!.ai_report_json).humanReview).toMatchObject({status:'pending',reasonCodes:['unread_attachments']});
        expect(await pendingTaskHumanReview(env,f.projectId,f.taskId)).toBe(true);
        expect((await env.DB.prepare('SELECT status FROM tasks WHERE id=?1').bind(f.taskId).first<{
            status: string;
        }>())?.status).toBe('done');
    });
    it.each(['[proof](/proof)', '<img src="/proof.png">'])('unread reference %s is provisional and releases dependent tasks', async link => {
        const f = await fixture('automatic', [], '成果包含三个验证案例。' + link);
        const dependent = id();
        await env.DB.prepare("INSERT INTO tasks(id,project_id,title,assignee_id,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria) VALUES(?1,?2,'后续任务',?3,'todo',1,?3,?4,?4,'open','输出报告')").bind(dependent,f.projectId,f.user.userId,stamp()).run();
        await env.DB.prepare('INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,created_at) VALUES(?1,?2,?3,?4)').bind(f.projectId,dependent,f.taskId,stamp()).run();
        vi.stubGlobal('fetch',model(report(f.versionId)));
        await runCollaborationAiJob(env,f.jobId);
        expect(await pendingTaskHumanReview(env,f.projectId,f.taskId)).toBe(true);
        expect((await env.DB.prepare('SELECT ready FROM task_readiness_current WHERE task_id=?1').bind(dependent).first<{ready:number}>())?.ready).toBe(1);
        const saved=await env.DB.prepare('SELECT * FROM task_submissions WHERE id=?1').bind(f.submissionId).first<Submission>();
        expect(toSubmission(saved!).pendingHumanReview).toBe(true);
        expect(JSON.parse(saved!.ai_report_json!).humanReview.reasonCodes).toEqual(['unread_references']);
    });
    it.each(['accept','improve','rework'] as const)('manual %s resolves provisional review atomically', async decision => {
        const f=await fixture('automatic',[{fileId:id()}]);
        vi.stubGlobal('fetch',model(report(f.versionId)));
        await runCollaborationAiJob(env,f.jobId);
        const saved=await env.DB.prepare('SELECT revision FROM task_submissions WHERE id=?1').bind(f.submissionId).first<{revision:number}>();
        await decideSubmission(env,f.projectId,f.submissionId,saved!.revision,decision,'人工核验完成',f.user.userId);
        expect(await pendingTaskHumanReview(env,f.projectId,f.taskId)).toBe(false);
        const submission=await env.DB.prepare('SELECT * FROM task_submissions WHERE id=?1').bind(f.submissionId).first<Submission>();
        expect(toSubmission(submission!).pendingHumanReview).toBe(false);
        expect(JSON.parse(submission!.ai_report_json!).humanReview).toMatchObject({status:'resolved',decision,decidedBy:f.user.userId});
        expect((await env.DB.prepare('SELECT status,lifecycle_state FROM tasks WHERE id=?1').bind(f.taskId).first())).toMatchObject({status:decision==='accept'?'done':'doing',lifecycle_state:decision==='accept'?'accepted':decision});
    });
    it.each([
        {coverage:'needs_human',limitations:[]},
        {coverage:'complete',limitations:['正文缺少第三个案例']},
        {coverage:'complete',limitations:[],evidence:[]},
    ])('external references do not bypass separate evidence blockers %j',async patch=>{
        const f=await fixture('automatic',[{fileId:id()}]);
        vi.stubGlobal('fetch',model({...report(f.versionId),...patch}));
        await runCollaborationAiJob(env,f.jobId);
        expect(JSON.parse((await getJob(env,f.jobId)).result_json!).autoApplied).toBe(false);
        expect(await pendingTaskHumanReview(env,f.projectId,f.taskId)).toBe(false);
    });
    it('manual evaluation mode still requires an explicit decision for external references',async()=>{
        const f=await fixture('manual',[{fileId:id()}]);
        vi.stubGlobal('fetch',model(report(f.versionId)));
        await runCollaborationAiJob(env,f.jobId);
        expect(JSON.parse((await getJob(env,f.jobId)).result_json!).autoApplied).toBe(false);
        expect(await pendingTaskHumanReview(env,f.projectId,f.taskId)).toBe(false);
    });
    it('a human decision during the model call wins over provisional acceptance',async()=>{
        const f=await fixture('automatic',[{fileId:id()}]);
        vi.stubGlobal('fetch',model(report(f.versionId),async()=>{
            await decideSubmission(env,f.projectId,f.submissionId,1,'rework','人工要求返工',f.user.userId);
        }));
        await runCollaborationAiJob(env,f.jobId);
        expect((await getJob(env,f.jobId)).status).toBe('failed');
        expect(await pendingTaskHumanReview(env,f.projectId,f.taskId)).toBe(false);
        expect((await env.DB.prepare('SELECT status,ai_report_json FROM task_submissions WHERE id=?1').bind(f.submissionId).first())).toMatchObject({status:'rework',ai_report_json:null});
    });
    it('API exposes pending review on task list/detail and submission history, then clears after human confirmation',async()=>{
        const f=await fixture('automatic',[{fileId:id()}]);
        vi.stubGlobal('fetch',model(report(f.versionId)));
        await runCollaborationAiJob(env,f.jobId);
        const request=async(path:string,method='GET',body?:unknown)=>{
            const response=await SELF.fetch(`${BASE}/api/v1/projects/${f.projectId}${path}`,{method,headers:{cookie:authCookie(f.user.token),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
            expect(response.status).toBe(200);
            return (await response.json() as {data:any}).data;
        };
        expect((await request(`/tasks/${f.taskId}`)).pendingHumanReview).toBe(true);
        expect((await request('/tasks')).items[0].pendingHumanReview).toBe(true);
        expect((await request('/collaboration/tasks')).items[0].pendingHumanReview).toBe(true);
        const submission=(await request(`/collaboration/tasks/${f.taskId}/submissions`)).items[0];
        expect(submission.pendingHumanReview).toBe(true);
        expect(submission.aiReport.humanReview.status).toBe('pending');
        await request(`/collaboration/submissions/${f.submissionId}/decide`,'POST',{expectedRevision:submission.revision,decision:'accept',feedback:'附件核验通过'});
        expect((await request(`/tasks/${f.taskId}`)).pendingHumanReview).toBe(false);
        expect((await request(`/collaboration/tasks/${f.taskId}/submissions`)).items[0].pendingHumanReview).toBe(false);
    });
    it('retry uses persisted original coverage and preserves provisional semantics without another model call',async()=>{
        const f=await fixture('automatic',[{fileId:id()}]);
        await env.DB.prepare("UPDATE task_submissions SET status='evaluated',revision=2,ai_report_json=?2 WHERE id=?1").bind(f.submissionId,JSON.stringify({...report(f.versionId),coverage:'needs_human',modelCoverage:'complete',manualReviewReason:'附件内容未读取，需要人工核对'})).run();
        const fetchMock=model(report(f.versionId));
        vi.stubGlobal('fetch',fetchMock);
        await runCollaborationAiJob(env,f.jobId);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(await pendingTaskHumanReview(env,f.projectId,f.taskId)).toBe(true);
    });
    it('a parent task cannot autoaccept while its child still needs work', async () => {
        const f = await fixture('automatic',[{fileId:id()}]);
        await env.DB.prepare("INSERT INTO tasks(id,project_id,title,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria,parent_task_id) VALUES(?1,?2,'未完成子任务','todo',1,?3,?4,?4,'open','需要完成',?5)").bind(id(), f.projectId, f.user.userId, stamp(), f.taskId).run();
        vi.stubGlobal('fetch', model(report(f.versionId)));
        await runCollaborationAiJob(env, f.jobId);
        const result = JSON.parse((await getJob(env, f.jobId)).result_json!);
        expect(result.autoApplied).toBe(false);
        expect(result.manualReviewReasons.join(' ')).toContain('子任务');
    });
    it('a settings change during the model call cannot commit old results', async () => {
        const f = await fixture('automatic');
        vi.stubGlobal('fetch', model(report(f.versionId), async () => { await env.DB.prepare("UPDATE projects SET evaluation_mode='manual',collaboration_revision=collaboration_revision+1 WHERE id=?1").bind(f.projectId).run(); }));
        await runCollaborationAiJob(env, f.jobId);
        expect((await getJob(env, f.jobId)).status).toBe('failed');
        expect((await env.DB.prepare('SELECT ai_report_json,status FROM task_submissions WHERE id=?1').bind(f.submissionId).first<{
            ai_report_json: string | null;
            status: string;
        }>())).toMatchObject({ ai_report_json: null, status: 'pending' });
    });
    it('a requesting owner demoted during evaluation cannot commit their former authority', async () => {
        const f = await fixture('automatic');
        const requester = await seedUser();
        await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'owner',?4)").bind(id(), f.projectId, requester.userId, stamp()).run();
        const prior = await getJob(env, f.jobId);
        const input = JSON.parse(prior.input_json);
        input.requestedBy = requester.userId;
        await env.DB.prepare('UPDATE jobs SET input_json=?2 WHERE id=?1').bind(f.jobId, JSON.stringify(input)).run();
        vi.stubGlobal('fetch', model(report(f.versionId), async () => { await env.DB.prepare("UPDATE project_members SET role='member' WHERE project_id=?1 AND user_id=?2").bind(f.projectId, requester.userId).run(); }));
        await runCollaborationAiJob(env, f.jobId);
        expect((await getJob(env, f.jobId)).status).toBe('failed');
        expect((await env.DB.prepare('SELECT ai_report_json FROM task_submissions WHERE id=?1').bind(f.submissionId).first<{
            ai_report_json: string | null;
        }>())?.ai_report_json).toBeNull();
    });
    it('a newer submission or task edit makes old AI output stale', async () => {
        const f = await fixture('automatic');
        vi.stubGlobal('fetch', model(report(f.versionId), async () => { await env.DB.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?1').bind(f.taskId).run(); }));
        await runCollaborationAiJob(env, f.jobId);
        expect((await getJob(env, f.jobId)).status).toBe('failed');
    });
    it('disabled AI makes no provider request and does not accept', async () => {
        const f = await fixture('automatic');
        await env.DB.prepare('UPDATE ai_config_versions SET enabled=0').run();
        const fetchMock = model(report(f.versionId));
        vi.stubGlobal('fetch', fetchMock);
        await runCollaborationAiJob(env, f.jobId);
        expect((await getJob(env, f.jobId)).status).toBe('failed');
        expect(fetchMock).not.toHaveBeenCalled();
        await env.DB.prepare('UPDATE ai_config_versions SET enabled=1').run();
    });
    it('invalid tool-session output fails without repeating the investigation', async () => {
        const f = await fixture('automatic');
        const fetchMock = model({ decision: 'accept' });
        vi.stubGlobal('fetch', fetchMock);
        await runCollaborationAiJob(env, f.jobId);
        expect((await getJob(env, f.jobId)).status).toBe('failed');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('material bodies beyond the model limit are rejected without truncation or calls', async () => {
        const f = await fixture('automatic', [], '正文'.repeat(50000));
        const fetchMock = model(report(f.versionId));
        vi.stubGlobal('fetch', fetchMock);
        await runCollaborationAiJob(env, f.jobId);
        expect((await getJob(env, f.jobId)).status).toBe('failed');
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('completed operation replay does not create another model call', async () => {
        const f = await fixture('manual');
        const fetchMock = model(report(f.versionId));
        vi.stubGlobal('fetch', fetchMock);
        await runCollaborationAiJob(env, f.jobId);
        await runCollaborationAiJob(env, f.jobId);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
describe('bounded decomposition and assignment continuation', () => {
    const offline = { ...env, AGENT_WORKFLOW: { create: async () => { throw new Error('fixture has no workflow engine'); } } } as unknown as Env;
    it.each(['manual', 'automatic'])('decomposition %s uses separate assignment reservation with no recursive tasks', async (mode) => {
        const user = await seedUser();
        const projectId = await seedProject(user.userId);
        await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1,assignment_mode=?2,planning_mode=?2 WHERE id=?1').bind(projectId, mode).run();
        const jobId = await job({ operation: 'collaboration.decompose', projectId, requestedBy: user.userId, settingsRevision: 1, brief: '制作可交付的研究成果' });
        const provider = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
            assertGoRequest(_url, init);
            const input = JSON.parse(String(init?.body)) as {
                messages: Array<{
                    content: string;
                }>;
            };
            const assignment = input.messages[0]!.content.includes('团队分工建议助手');
            const data = JSON.parse(input.messages[1]!.content) as {
                tasks: Array<{
                    taskId: string;
                }>;
                members: Array<{
                    userId: string;
                }>;
            };
            const output = assignment ? { assignments: data.tasks.map(t => ({ taskId: t.taskId, assigneeId: data.members[0]!.userId, reason: '申报技能和当前负载匹配' })), considerations: [] } : { tasks: [{ title: '研究资料', detail: '整理正文证据', criteria: '三个有出处的事实', effortHours: 2 }, { title: '输出报告', detail: '给出可核对结论', criteria: '结论对应事实', effortHours: 3 }] };
            return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 30, completion_tokens: 20 } }), { headers: { 'content-type': 'application/json' } });
        });
        vi.stubGlobal('fetch', provider);
        await runCollaborationAiJob(offline, jobId);
        const done = await getJob(env, jobId);
        expect(done.status).toBe('succeeded');
        const result = JSON.parse(done.result_json!) as {
            proposalId: string;
            autoApplied: boolean;
            followupJobId: string | null;
        };
        expect(result.autoApplied).toBe(false);
        if (mode === 'manual') {
            expect(result.followupJobId).toBeNull();
            expect((await env.DB.prepare('SELECT COUNT(*) n FROM tasks WHERE project_id=?1').bind(projectId).first<{
                n: number;
            }>())?.n).toBe(0);
        }
        else {
            expect(result.followupJobId).toBeNull();
            await applyProposal(offline,projectId,result.proposalId,1,user.userId);
            result.followupJobId=(await continueConfirmedPlan(offline,projectId,result.proposalId,user.userId)).followupJobId;
            expect(result.followupJobId).toBe(result.proposalId);
            await runCollaborationAiJob(offline, result.followupJobId!);
            const assigned = await getJob(env, result.followupJobId!);
            expect(assigned.status).toBe('succeeded');
            expect(JSON.parse(assigned.result_json!).autoApplied).toBe(true);
            const children = await env.DB.prepare('SELECT assignee_id,parent_task_id FROM tasks WHERE plan_proposal_id=?1').bind(result.proposalId).all<{
                assignee_id: string;
                parent_task_id: string;
            }>();
            expect(children.results).toHaveLength(2);
            expect(children.results.every(t => t.assignee_id === user.userId)).toBe(true);
            const reservations = await env.DB.prepare('SELECT job_id,attempts_started FROM usage_reservations WHERE project_id=?1').bind(projectId).all<{
                job_id: string;
                attempts_started: number;
            }>();
            expect(reservations.results).toHaveLength(2);
            expect(reservations.results.every(r => r.attempts_started === 1)).toBe(true);
            await runCollaborationAiJob(offline, jobId);
            expect(provider).toHaveBeenCalledTimes(2);
        }
    });
});
