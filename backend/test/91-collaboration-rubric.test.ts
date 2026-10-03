import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env, BASE } from './helpers/env';
import { configureGoFixture, assertGoRequest } from './helpers/provider-config';
import { seedProject, seedUser, authCookie } from './helpers/seed';
import type { Env } from '../src/env';
import { getJob } from '../src/services/jobs';
import { enqueueEvaluation } from '../src/services/collaboration-evaluation';
import { runCollaborationAiJob, taskEvaluationSchema, calculateRubricWeightedTotal, type CollaborationAiInput, type EvaluationRubricSnapshot } from '../src/services/collaboration-ai';

afterEach(() => vi.unstubAllGlobals());
await configureGoFixture();
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const offline = { ...env, AGENT_WORKFLOW: { create: async () => { throw new Error('fixture has no workflow engine'); } } } as unknown as Env;
const weights = [{ key: 'quality', label: '成果质量', weight: 3 }, { key: 'coverage', label: '案例覆盖', weight: 1 }];
const markdown = '成果包含三个验证案例。每个案例都有明确结果。';

async function fixture(automatic = false, attachments: unknown[] = []) {
    const user = await seedUser();
    const projectId = await seedProject(user.userId);
    const taskId = id(), submissionId = id(), materialId = id(), versionId = id(), timestamp = now();
    await env.DB.batch([
        env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1,evaluation_mode=?2 WHERE id=?1').bind(projectId, automatic ? 'automatic' : 'manual'),
        env.DB.prepare("INSERT INTO tasks(id,project_id,title,assignee_id,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria,current_submission_id) VALUES(?1,?2,'验证案例',?3,'doing',2,?3,?4,?4,'submitted','至少三个验证案例',?5)").bind(taskId, projectId, user.userId, timestamp, submissionId),
        env.DB.prepare("INSERT INTO materials(id,project_id,title,created_by,created_at,updated_at) VALUES(?1,?2,'成果',?3,?4,?4)").bind(materialId, projectId, user.userId, timestamp),
        env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at,attachments_json) VALUES(?1,?2,?3,1,'{}',?4,'manual',?5,?6,?7)").bind(versionId, materialId, projectId, markdown, user.userId, timestamp, JSON.stringify(attachments)),
        env.DB.prepare("INSERT INTO task_submissions(id,project_id,task_id,round,submitted_by,body,material_versions_json,criteria,task_revision,created_at,updated_at) VALUES(?1,?2,?3,1,?4,'已完成',?5,'至少三个验证案例',2,?6,?6)").bind(submissionId, projectId, taskId, user.userId, JSON.stringify([versionId]), timestamp),
    ]);
    return {
        user, projectId, taskId, submissionId, materialId, versionId,
        start: () => enqueueEvaluation(offline, projectId, submissionId, user.userId),
        persisted: async () => {
            const row = await env.DB.prepare('SELECT ai_report_json,status FROM task_submissions WHERE id=?1').bind(submissionId).first<{ ai_report_json: string | null; status: string }>();
            return { status: row!.status, report: row!.ai_report_json ? JSON.parse(row!.ai_report_json) : null };
        },
    };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function rubric(f: Fixture, version = 1, status: 'confirmed' | 'draft' = 'confirmed', rubricWeights = weights): Promise<EvaluationRubricSnapshot> {
    const snapshot = { rubricVersionId: id(), version, weights: rubricWeights, notes: '仅用于成果辅助反馈' };
    await env.DB.prepare("INSERT INTO rubric_versions(id,project_id,version,source,weights_json,notes,status,confirmed_by,confirmed_at,created_at) VALUES(?1,?2,?3,'custom',?4,?5,?6,?7,?8,?8)").bind(snapshot.rubricVersionId, f.projectId, version, JSON.stringify(rubricWeights), snapshot.notes, status, f.user.userId, now()).run();
    return snapshot;
}
function report(f: Fixture, withScores = true) {
    const evidence = [{ materialVersionId: f.versionId, quote: '成果包含三个验证案例。' }];
    return {
        decision: 'accept', feedback: '成果提供三个可核对案例', evidence, limitations: [], coverage: 'complete',
        ...(withScores ? { scores: [
            { key: 'coverage', score: 40, confidence: 0.8, comment: '覆盖三个案例', evidence },
            { key: 'quality', score: 80, confidence: 0.9, comment: '有明确结果', evidence },
        ] } : {}),
    };
}
function model(output: unknown, before?: () => Promise<void>) {
    return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        assertGoRequest(url, init);
        await before?.();
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 30, completion_tokens: 25 } }), { headers: { 'content-type': 'application/json' } });
    });
}
async function mutateInput(jobId: string, change: (input: CollaborationAiInput) => void) {
    const input = JSON.parse((await getJob(env, jobId)).input_json) as CollaborationAiInput;
    change(input);
    await env.DB.prepare('UPDATE jobs SET input_json=?2 WHERE id=?1').bind(jobId, JSON.stringify(input)).run();
}
async function expectFailedUntouched(f: Fixture, jobId: string) {
    expect((await getJob(env, jobId)).status).toBe('failed');
    expect(await f.persisted()).toEqual({ status: 'pending', report: null });
    const state = await env.DB.prepare('SELECT lifecycle_state,status FROM tasks WHERE id=?1').bind(f.taskId).first();
    expect(state).toMatchObject({ lifecycle_state: 'submitted', status: 'doing' });
}

describe('bounded assistive rubric scores', () => {
    it('enqueue freezes latest confirmed rubric, excluding newer drafts', async () => {
        const f = await fixture();
        await rubric(f);
        const confirmed = await rubric(f, 2);
        await rubric(f, 3, 'draft');
        const jobId = await f.start();
        expect(JSON.parse((await getJob(env, jobId)).input_json).rubricSnapshot).toEqual(confirmed);
    });
    it('persists dimension confidence and immutable evidence with server-normalized weighted total', async () => {
        const f = await fixture();
        const frozen = await rubric(f);
        const jobId = await f.start();
        const provider = model(report(f));
        vi.stubGlobal('fetch', provider);
        await runCollaborationAiJob(env, jobId);
        expect((await getJob(env, jobId)).status).toBe('succeeded');
        const persisted = (await f.persisted()).report;
        expect(persisted.rubricScoring).toMatchObject({ kind: 'assistive', status: 'scored', rubricVersionId: frozen.rubricVersionId, rubricVersion: 1, weights, weightedTotal: 70 });
        expect(persisted.rubricScoring.scores.map((s: { key: string }) => s.key)).toEqual(['quality', 'coverage']);
        expect(persisted.rubricScoring.scores[0]).toMatchObject({ score: 80, confidence: 0.9, evidence: [{ materialVersionId: f.versionId, quote: '成果包含三个验证案例。' }] });
        expect(persisted.scores).toBeUndefined();
        const body = JSON.parse(String(provider.mock.calls[0]![1]?.body));
        expect(JSON.parse(body.messages[1].content).rubricSnapshot).toEqual(frozen);
        expect(body.messages[0].content).toContain('总分由服务器计算');
        await runCollaborationAiJob(env, jobId);
        expect(provider).toHaveBeenCalledTimes(1);
    });
    it('draft-only or absent rubric gives explicit feedback-only result without scores', async () => {
        const f = await fixture();
        await rubric(f, 1, 'draft');
        const jobId = await f.start();
        expect(JSON.parse((await getJob(env, jobId)).input_json).rubricSnapshot).toBeNull();
        vi.stubGlobal('fetch', model(report(f, false)));
        await runCollaborationAiJob(env, jobId);
        expect((await getJob(env, jobId)).status).toBe('succeeded');
        const persisted = (await f.persisted()).report;
        expect(persisted.rubricScoring).toMatchObject({ kind: 'assistive', status: 'unavailable', reason: expect.stringContaining('没有已确认') });
        expect(persisted.rubricScoring.scores).toBeUndefined();
        expect(persisted.scores).toBeUndefined();
    });
    it('legacy jobs without rubric snapshot remain feedback-only', async () => {
        const f = await fixture();
        await rubric(f);
        const jobId = await f.start();
        await mutateInput(jobId, input => { delete input.rubricSnapshot; });
        vi.stubGlobal('fetch', model(report(f, false)));
        await runCollaborationAiJob(env, jobId);
        expect((await getJob(env, jobId)).status).toBe('succeeded');
        expect((await f.persisted()).report.rubricScoring.status).toBe('unavailable');
    });
    it('no-rubric output cannot invent scores', async () => {
        const f = await fixture();
        const jobId = await f.start();
        const provider = model(report(f));
        vi.stubGlobal('fetch', provider);
        await runCollaborationAiJob(env, jobId);
        await expectFailedUntouched(f, jobId);
        expect(provider).toHaveBeenCalledTimes(1);
    });
    it.each(['missing', 'extra', 'duplicate', 'omitted', 'total'])('refuses %s rubric output without repeating the tool session', async kind => {
        const f = await fixture(true);
        await rubric(f);
        const jobId = await f.start();
        const output = report(f);
        if (kind === 'missing') output.scores!.pop();
        if (kind === 'extra') output.scores!.push({ ...output.scores![0]!, key: 'invented' });
        if (kind === 'duplicate') output.scores![1]!.key = 'coverage';
        if (kind === 'omitted') delete output.scores;
        if (kind === 'total') Object.assign(output, { weightedTotal: 100 });
        const provider = model(output);
        vi.stubGlobal('fetch', provider);
        await runCollaborationAiJob(env, jobId);
        await expectFailedUntouched(f, jobId);
        expect(provider).toHaveBeenCalledTimes(1);
    });
    it.each(['score', 'confidence', 'empty_evidence', 'person_rank'])('strict scoring schema rejects invalid %s', kind => {
        const evidence = [{ materialVersionId: id(), quote: '原文' }];
        const output = { decision: 'accept', feedback: '反馈', evidence, limitations: [], coverage: 'complete', scores: [{ key: 'quality', score: 80, confidence: 0.8, comment: '评语', evidence }] };
        if (kind === 'score') output.scores[0]!.score = 101;
        if (kind === 'confidence') output.scores[0]!.confidence = -0.1;
        if (kind === 'empty_evidence') output.scores[0]!.evidence = [];
        if (kind === 'person_rank') Object.assign(output.scores[0]!, { personRank: 1 });
        expect(taskEvaluationSchema.safeParse(output).success).toBe(false);
    });
    it.each(['foreign', 'draft', 'weights', 'version'])('forged %s snapshot never reaches provider', async kind => {
        const f = await fixture();
        await rubric(f);
        const jobId = await f.start();
        if (kind === 'foreign') {
            const other = await fixture();
            const foreign = await rubric(other);
            await mutateInput(jobId, input => { input.rubricSnapshot = foreign; });
        } else if (kind === 'draft') {
            const draft = await rubric(f, 2, 'draft');
            await mutateInput(jobId, input => { input.rubricSnapshot = draft; });
        } else await mutateInput(jobId, input => {
            if (kind === 'weights') input.rubricSnapshot!.weights[0]!.weight = 100;
            else input.rubricSnapshot!.version = 9;
        });
        const provider = model(report(f));
        vi.stubGlobal('fetch', provider);
        await runCollaborationAiJob(env, jobId);
        await expectFailedUntouched(f, jobId);
        expect(provider).not.toHaveBeenCalled();
    });
    it.each(['quote', 'version'])('rejects forged per-dimension evidence %s', async kind => {
        const f = await fixture(true);
        await rubric(f);
        const jobId = await f.start();
        const output = report(f);
        output.scores![0]!.evidence = [{ materialVersionId: kind === 'version' ? id() : f.versionId, quote: kind === 'quote' ? '不存在的正文' : '成果包含三个验证案例。' }];
        vi.stubGlobal('fetch', model(output));
        await runCollaborationAiJob(env, jobId);
        await expectFailedUntouched(f, jobId);
        expect(JSON.parse((await getJob(env, jobId)).error_json!).code).toBe('AI_OUTPUT_INVALID');
    });
    it('new material version never replaces evidence from submitted immutable version', async () => {
        const f = await fixture();
        await rubric(f);
        const jobId = await f.start();
        await env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at,attachments_json) VALUES(?1,?2,?3,2,'{}','完全不同的新成果','manual',?4,?5,'[]')").bind(id(), f.materialId, f.projectId, f.user.userId, now()).run();
        vi.stubGlobal('fetch', model(report(f)));
        await runCollaborationAiJob(env, jobId);
        expect((await getJob(env, jobId)).status).toBe('succeeded');
        expect((await f.persisted()).report.rubricScoring.scores[0].evidence[0].materialVersionId).toBe(f.versionId);
    });
    it.each(['new_version', 'mutated_weights', 'newly_confirmed'])('rubric %s during model call cannot persist or autoaccept', async kind => {
        const f = await fixture(true);
        const frozen = kind === 'newly_confirmed' ? null : await rubric(f);
        const jobId = await f.start();
        vi.stubGlobal('fetch', model(report(f, Boolean(frozen)), async () => {
            if (kind === 'mutated_weights') await env.DB.prepare('UPDATE rubric_versions SET weights_json=?2 WHERE id=?1').bind(frozen!.rubricVersionId, JSON.stringify([{ key: 'quality', label: '成果质量', weight: 100 }])).run();
            else await rubric(f, kind === 'newly_confirmed' ? 1 : 2);
        }));
        await runCollaborationAiJob(env, jobId);
        await expectFailedUntouched(f, jobId);
    });
    it.each(['low_confidence', 'unread_attachment'])('%s scores preserve review policy', async kind => {
        const f = await fixture(true, kind === 'unread_attachment' ? [{ fileId: id(), name: '证据.pdf' }] : []);
        await rubric(f);
        const jobId = await f.start();
        const output = report(f);
        if (kind === 'low_confidence') output.scores![0]!.confidence = 0.4;
        vi.stubGlobal('fetch', model(output));
        await runCollaborationAiJob(env, jobId);
        const done = await getJob(env, jobId);
        expect(done.status).toBe('succeeded');
        expect(JSON.parse(done.result_json!).autoApplied).toBe(kind === 'unread_attachment');
        expect((await f.persisted()).report).toMatchObject({ coverage: 'needs_human', rubricScoring: { status: 'scored' }, ...(kind === 'unread_attachment' ? {humanReview:{status:'pending'}} : {}) });
    });
    it.each(['before', 'during'])('project switch off %s evaluation prevents results', async when => {
        const f = await fixture(true);
        await rubric(f);
        const jobId = await f.start();
        const disable = async () => { await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=0 WHERE id=?1').bind(f.projectId).run(); };
        if (when === 'before') await disable();
        const provider = model(report(f), when === 'during' ? disable : undefined);
        vi.stubGlobal('fetch', provider);
        await runCollaborationAiJob(env, jobId);
        await expectFailedUntouched(f, jobId);
        if (when === 'before') expect(provider).not.toHaveBeenCalled();
    });
    it('disabled project cannot enqueue and does not consume submission attempt', async () => {
        const f = await fixture();
        await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=0 WHERE id=?1').bind(f.projectId).run();
        await expect(f.start()).rejects.toThrow('未启用');
        expect(await env.DB.prepare('SELECT evaluation_attempts,evaluation_job_id FROM task_submissions WHERE id=?1').bind(f.submissionId).first()).toMatchObject({ evaluation_attempts: 0, evaluation_job_id: null });
    });
    it('does not repair after the project switch is disabled by first response', async () => {
        const f = await fixture();
        await rubric(f);
        const jobId = await f.start();
        const provider = model({ invalid: true }, async () => { await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=0 WHERE id=?1').bind(f.projectId).run(); });
        vi.stubGlobal('fetch', provider);
        await runCollaborationAiJob(env, jobId);
        await expectFailedUntouched(f, jobId);
        expect(provider).toHaveBeenCalledTimes(1);
    });
    it.each(['duplicate', 'zero_total'])('invalid confirmed rubric %s cannot authorize a scoring job', async kind => {
        const f = await fixture();
        await rubric(f, 1, 'confirmed', kind === 'duplicate' ? [weights[0]!, weights[0]!] : weights.map(weight => ({ ...weight, weight: 0 })));
        await expect(f.start()).rejects.toThrow('无效');
        expect((await f.persisted()).status).toBe('pending');
    });
});

describe('shared server weighted total', () => {
    it('normalizes non-percent weights and rounds only the final total', () => {
        expect(calculateRubricWeightedTotal(weights, [{ key: 'coverage', score: 40 }, { key: 'quality', score: 80 }])).toBe(70);
        expect(calculateRubricWeightedTotal(weights, [{ key: 'coverage', score: 33.333 }, { key: 'quality', score: 88.888 }])).toBe(75);
    });
    it.each(['duplicate', 'missing', 'extra', 'range'])('refuses invalid %s score dimensions', kind => {
        const scores = [{ key: 'quality', score: 80 }, { key: 'coverage', score: 40 }];
        if (kind === 'duplicate') scores[1]!.key = 'quality';
        if (kind === 'missing') scores.pop();
        if (kind === 'extra') scores.push({ key: 'invented', score: 10 });
        if (kind === 'range') scores[1]!.score = -1;
        expect(() => calculateRubricWeightedTotal(weights, scores)).toThrow();
    });
});

function beforeAutomaticDecision(before: () => Promise<void>): Env {
    const marked = new WeakSet<object>();
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
        const proxy = new Proxy(statement, { get(target, key) {
            if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
            const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
        } });
        marked.add(proxy);
        return proxy;
    };
    const database = new Proxy(env.DB, { get(target, key) {
        if (key === 'prepare') return (sql: string) => sql.includes('UPDATE task_submissions SET decision=') ? wrap(target.prepare(sql)) : target.prepare(sql);
        if (key === 'batch') return async (statements: D1PreparedStatement[]) => { if (statements.some(statement => marked.has(statement))) await before(); return target.batch(statements); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { ...env, DB: database };
}
describe('atomic rubric auto-decision guard', () => {
    it.each(['new_version', 'mutated_weights', 'previously_absent'])('%s changed after final rubric read blocks automatic acceptance and audit', async kind => {
        const f = await fixture(true);
        const frozen = kind === 'previously_absent' ? null : await rubric(f);
        const jobId = await f.start();
        vi.stubGlobal('fetch', model(report(f, Boolean(frozen))));
        let injected = false;
        const raced = beforeAutomaticDecision(async () => {
            injected = true;
            if (kind === 'mutated_weights') await env.DB.prepare('UPDATE rubric_versions SET weights_json=?2 WHERE id=?1').bind(frozen!.rubricVersionId, JSON.stringify([{ key: 'quality', label: '成果质量', weight: 100 }])).run();
            else await rubric(f, kind === 'previously_absent' ? 1 : 2);
        });
        await runCollaborationAiJob(raced, jobId);
        expect(injected).toBe(true);
        const done = await getJob(env, jobId);
        expect(done.status).toBe('succeeded');
        expect(JSON.parse(done.result_json!)).toMatchObject({ autoApplied: false, applyError: expect.any(String) });
        expect((await f.persisted()).status).toBe('evaluated');
        expect((await f.persisted()).report.rubricScoring.status).toBe(frozen ? 'scored' : 'unavailable');
        expect(await env.DB.prepare('SELECT lifecycle_state,status FROM tasks WHERE id=?1').bind(f.taskId).first()).toMatchObject({ lifecycle_state: 'submitted', status: 'doing' });
        expect((await env.DB.prepare("SELECT COUNT(*) n FROM events WHERE project_id=?1 AND type='collaboration.submission_decided'").bind(f.projectId).first<{ n: number }>())?.n).toBe(0);
    });
});

async function scoredFixture() {
    const f = await fixture();
    const frozen = await rubric(f);
    const jobId = await f.start();
    vi.stubGlobal('fetch', model(report(f)));
    await runCollaborationAiJob(env, jobId);
    expect((await getJob(env, jobId)).status).toBe('succeeded');
    const row = await env.DB.prepare('SELECT revision,ai_report_json FROM task_submissions WHERE id=?1').bind(f.submissionId).first<{ revision: number; ai_report_json: string }>();
    return { ...f, frozen, expectedRevision: row!.revision, originalReport: row!.ai_report_json };
}
type ScoredFixture = Awaited<ReturnType<typeof scoredFixture>>;
const overrideBody = (f: ScoredFixture) => ({ expectedRevision: f.expectedRevision, scores: [{ key: 'quality', score: 90 }, { key: 'coverage', score: 50 }], reason: '负责人复核三个案例的成果' });
function overrideRequest(f: Fixture, body: unknown, token = f.user.token) {
    return SELF.fetch(`${BASE}/api/v1/projects/${f.projectId}/collaboration/submissions/${f.submissionId}/scores`, {
        method: 'POST', headers: { cookie: authCookie(token), 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
}
async function overrideRow(f: Fixture) {
    return env.DB.prepare('SELECT revision,ai_report_json,human_score_override_json FROM task_submissions WHERE id=?1').bind(f.submissionId).first<{ revision: number; ai_report_json: string | null; human_score_override_json: string | null }>();
}
async function overrideAudits(f: Fixture) {
    return (await env.DB.prepare("SELECT project_id,actor_type,actor_id,entity_id,payload_json FROM events WHERE project_id=?1 AND type='collaboration.scores_overridden'").bind(f.projectId).all()).results;
}
describe('owner assistive score override', () => {
    it('uses original immutable scoring weights, preserves AI report and records scoped user audit', async () => {
        const f = await scoredFixture();
        await rubric(f, 2, 'confirmed', [{ key: 'new-standard', label: '新的维度', weight: 100 }]);
        const response = await overrideRequest(f, overrideBody(f));
        expect(response.status).toBe(200);
        const body = await response.json() as { data: { humanScoreOverride: unknown; aiReport: unknown; revision: number } };
        expect(body.data.humanScoreOverride).toMatchObject({ kind: 'assistive', rubricVersionId: f.frozen.rubricVersionId, rubricVersion: 1, weightedTotal: 80, decidedBy: f.user.userId, scores: overrideBody(f).scores });
        expect(body.data.aiReport).toEqual(JSON.parse(f.originalReport));
        expect(body.data.revision).toBe(f.expectedRevision + 1);
        const persisted = await overrideRow(f);
        expect(persisted!.ai_report_json).toBe(f.originalReport);
        expect(JSON.parse(persisted!.human_score_override_json!)).toEqual(body.data.humanScoreOverride);
        const audits = await overrideAudits(f);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({ project_id: f.projectId, actor_type: 'user', actor_id: f.user.userId, entity_id: f.submissionId });
        expect(JSON.parse(String(audits[0]!.payload_json))).toEqual(body.data.humanScoreOverride);
    });
    it.each(['member', 'admin', 'super_admin'])('%s account cannot substitute for project owner', async kind => {
        const f = await scoredFixture();
        const viewer = await seedUser();
        if (kind === 'member') await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(id(), f.projectId, viewer.userId, now()).run();
        else await env.DB.prepare('UPDATE auth_accounts SET account_role=?2,is_admin=1 WHERE user_id=?1').bind(viewer.userId, kind).run();
        expect((await overrideRequest(f, overrideBody(f), viewer.token)).status).toBe(403);
        expect((await overrideRow(f))!.human_score_override_json).toBeNull();
        expect(await overrideAudits(f)).toHaveLength(0);
    });
    it.each(['missing', 'extra', 'duplicate', 'range', 'confidence', 'privileges'])('rejects invalid %s payload without report, revision or audit change', async kind => {
        const f = await scoredFixture();
        const payload = overrideBody(f);
        if (kind === 'missing') payload.scores.pop();
        if (kind === 'extra') payload.scores.push({ key: 'invented', score: 100 });
        if (kind === 'duplicate') payload.scores[1]!.key = 'quality';
        if (kind === 'range') payload.scores[0]!.score = 101;
        if (kind === 'confidence') Object.assign(payload.scores[0]!, { confidence: 1 });
        if (kind === 'privileges') Object.assign(payload, { role: 'owner', decidedBy: id(), projectId: id(), officialGrade: 100 });
        expect((await overrideRequest(f, payload)).status).toBe(400);
        expect(await overrideRow(f)).toMatchObject({ revision: f.expectedRevision, ai_report_json: f.originalReport, human_score_override_json: null });
        expect(await overrideAudits(f)).toHaveLength(0);
    });
    it('repeated stale CAS request cannot overwrite or duplicate audit', async () => {
        const f = await scoredFixture();
        const payload = overrideBody(f);
        expect((await overrideRequest(f, payload)).status).toBe(200);
        const saved = await overrideRow(f);
        payload.reason = '过期请求试图覆盖';
        payload.scores[0]!.score = 0;
        expect((await overrideRequest(f, payload)).status).toBe(409);
        expect((await overrideRequest(f, payload)).status).toBe(409);
        expect(await overrideRow(f)).toEqual(saved);
        expect(await overrideAudits(f)).toHaveLength(1);
    });
    it('cross-project submission and feedback-only report cannot be overridden', async () => {
        const f = await scoredFixture();
        const other = await fixture();
        const nonexistent = { ...f, submissionId: other.submissionId };
        expect((await overrideRequest(nonexistent, overrideBody(f))).status).toBe(404);
        await env.DB.prepare('UPDATE task_submissions SET ai_report_json=?2 WHERE id=?1').bind(f.submissionId, JSON.stringify(report(f, false))).run();
        expect((await overrideRequest(f, overrideBody(f))).status).toBe(409);
        expect((await overrideRow(f))!.human_score_override_json).toBeNull();
        expect(await overrideAudits(f)).toHaveLength(0);
    });
});
