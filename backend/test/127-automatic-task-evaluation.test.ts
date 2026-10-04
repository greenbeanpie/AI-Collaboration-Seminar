import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { enqueueEvaluation } from '../src/services/collaboration-evaluation';
import { decideSubmission } from '../src/services/collaboration';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';

const app = createApp();
const offline = { ...env, AGENT_WORKFLOW: { create: async () => { throw new Error('no test workflow'); } } } as unknown as Env;
async function fixture(projectEnabled = true, globalEnabled = true) {
    await configureGoFixture();
    await env.DB.prepare('UPDATE ai_config_versions SET enabled=?1 WHERE id=(SELECT id FROM ai_config_versions ORDER BY version DESC LIMIT 1)').bind(globalEnabled ? 1 : 0).run();
    const user = await seedUser(), projectId = await seedProject(user.userId), taskId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.batch([
        env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=?2 WHERE id=?1').bind(projectId, projectEnabled ? 1 : 0),
        env.DB.prepare("INSERT INTO tasks(id,project_id,title,assignee_id,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria) VALUES(?1,?2,'成果',?3,'doing',1,?3,?4,?4,'in_progress','可核对')").bind(taskId, projectId, user.userId, now),
    ]);
    const request = async (path: string, body: unknown, key?: string) => {
        const response = await app.fetch(new Request(BASE + '/api/v1' + path, {
            method: 'POST', headers: { cookie: authCookie(user.token), 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body),
        }), offline, createExecutionContext());
        return { status: response.status, json: await response.json() as any };
    };
    const submit = (revision = 1, key?: string, alias = false) => request(`/projects/${projectId}/${alias ? '' : 'collaboration/'}tasks/${taskId}/submissions`, { expectedRevision: revision, body: '本轮成果' }, key);
    const counts = async () => {
        const submissions = await env.DB.prepare('SELECT COUNT(*) n FROM task_submissions WHERE project_id=?1').bind(projectId).first<{ n: number }>();
        const jobs = await env.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE project_id=?1 AND json_extract(input_json,'$.operation')='collaboration.evaluate'").bind(projectId).first<{ n: number }>();
        const reservations = await env.DB.prepare("SELECT COUNT(*) n FROM usage_reservations WHERE project_id=?1 AND status!='released'").bind(projectId).first<{ n: number }>();
        return { submissions: submissions!.n, jobs: jobs!.n, reservations: reservations!.n };
    };
    return { user, projectId, taskId, request, submit, counts };
}

describe('one automatic evaluation per submitted round', () => {
    it('automatically queues once, replays the same submission and job across route aliases, and rejects changed intent', async () => {
        const f = await fixture(), key = crypto.randomUUID();
        const first = await f.submit(1, key);
        expect(first.status).toBe(201);
        expect(first.json.data.evaluationJobId).toBeTruthy();
        expect(first.json.data.evaluationAttempts).toBe(1);
        expect(first.json.data.evaluationError).toBeUndefined();
        const replay = await f.submit(1, key, true);
        expect(replay.status).toBe(201);
        expect(replay.json.data).toEqual(first.json.data);
        expect((await f.submit(2, key)).status).toBe(409);
        expect((await f.submit()).status).toBe(409);
        expect(await f.counts()).toEqual({ submissions: 1, jobs: 1, reservations: 1 });
    });
    it.each([[false, true], [true, false], [false, false]])('disabled project=%s global=%s submits without evaluation or error', async (projectEnabled, globalEnabled) => {
        const f = await fixture(projectEnabled, globalEnabled), submitted = await f.submit();
        expect(submitted.status).toBe(201);
        expect(submitted.json.data.evaluationJobId).toBeNull();
        expect(submitted.json.data.evaluationAttempts).toBe(0);
        expect(submitted.json.data.evaluationError).toBeUndefined();
        expect(await f.counts()).toEqual({ submissions: 1, jobs: 0, reservations: 0 });
    });
    it.each(['failed', 'cancelled'])('does not restart a %s evaluation through service or generic retry', async status => {
        const f = await fixture(), first = (await f.submit()).json.data;
        await env.DB.prepare('UPDATE jobs SET status=?2 WHERE id=?1').bind(first.evaluationJobId, status).run();
        await expect(enqueueEvaluation(offline, f.projectId, first.submissionId, f.user.userId)).rejects.toThrow('本轮提交已启动过');
        expect((await f.request(`/jobs/${first.evaluationJobId}/retry`, {})).status).toBe(409);
        expect(await f.counts()).toEqual({ submissions: 1, jobs: 1, reservations: 1 });
    });
    it('rejects the removed manual evaluation endpoint and keeps old disabled submissions untouched after enablement', async () => {
        const f = await fixture(false), first = (await f.submit()).json.data;
        await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(f.projectId).run();
        expect((await f.request(`/projects/${f.projectId}/collaboration/submissions/${first.submissionId}/evaluate`, {})).status).toBe(404);
        expect(await f.counts()).toEqual({ submissions: 1, jobs: 0, reservations: 0 });
        const row = await env.DB.prepare('SELECT evaluation_attempts,evaluation_job_id FROM task_submissions WHERE id=?1').bind(first.submissionId).first();
        expect(row).toEqual({ evaluation_attempts: 0, evaluation_job_id: null });
    });
    it('queues a fresh evaluation only for a new submission round after rework', async () => {
        const f = await fixture(), first = (await f.submit()).json.data;
        await decideSubmission(offline, f.projectId, first.submissionId, 1, 'rework', '补充成果', f.user.userId);
        const second = await f.submit(3);
        expect(second.status).toBe(201);
        expect(second.json.data.round).toBe(2);
        expect(second.json.data.evaluationJobId).not.toBe(first.evaluationJobId);
        expect(second.json.data.evaluationAttempts).toBe(1);
        expect(await f.counts()).toEqual({ submissions: 2, jobs: 2, reservations: 2 });
    });
    it('concurrent enqueue claims only one evaluation and repeated calls cannot add an active reservation', async () => {
        const f = await fixture(false), first = (await f.submit()).json.data;
        await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(f.projectId).run();
        const starts = await Promise.allSettled([enqueueEvaluation(offline, f.projectId, first.submissionId, f.user.userId), enqueueEvaluation(offline, f.projectId, first.submissionId, f.user.userId)]);
        expect(starts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(starts.filter(result => result.status === 'rejected')).toHaveLength(1);
        expect(await f.counts()).toEqual({ submissions: 1, jobs: 1, reservations: 1 });
        await expect(enqueueEvaluation(offline, f.projectId, first.submissionId, f.user.userId)).rejects.toThrow();
        expect(await f.counts()).toEqual({ submissions: 1, jobs: 1, reservations: 1 });
    });
});
