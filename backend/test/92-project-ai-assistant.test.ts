import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { configureGoFixture, assertGoRequest } from './helpers/provider-config';
import { newId, nowIso } from '../src/core/db';
import { getJob } from '../src/services/jobs';
import { reserveAiSlot } from '../src/services/ai-reservations';
import { runCollaborationAiJob, adjustmentSchema, type CollaborationAiInput } from '../src/services/collaboration-ai';
import { ExecutionPaused, readExecution } from '../src/services/ai-execution-control';

afterEach(() => vi.unstubAllGlobals());
const request = (token: string, path: string, body?: unknown, method = body ? 'POST' : 'GET', key = newId()) => SELF.fetch(BASE + '/api/v1' + path, { method, headers: { cookie: authCookie(token), 'content-type': 'application/json', 'idempotency-key': key }, ...(body ? { body: JSON.stringify(body) } : {}) });

async function fixture(automatic = true) {
  await configureGoFixture();
  const owner = await seedUser();
  const projectId = await seedProject(owner.userId);
  const taskId = newId();
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET ai_collaboration_enabled=1,assignment_mode=?2,planning_mode=?2 WHERE id=?1").bind(projectId, automatic ? 'automatic' : 'manual'),
    env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria,effort_hours,assignee_id) VALUES(?1,?2,'旧标题','旧说明','doing',1,?3,?4,?4,'in_progress','旧标准',2,?3)").bind(taskId, projectId, owner.userId, now),
  ]);
  const input: CollaborationAiInput = { operation: 'collaboration.decompose', projectId, requestedBy: owner.userId, settingsRevision: 1, brief: '补充键盘操作验收，并缩小交付范围', taskIds: [taskId], tasks: [{ taskId, title: '旧标题', detail: '旧说明', criteria: '旧标准', effortHours: 2, revision: 1 }], configVersionId: 'cfg-seed-v1' };
  const jobId = newId();
  await reserveAiSlot(env, { projectId, jobId, purpose: 'assignment_suggest' });
  await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_by,created_at,updated_at) VALUES(?1,?2,'agent_run','queued',?3,0,?4,?5,?5)").bind(jobId, projectId, JSON.stringify(input), owner.userId, now).run();
  return { owner, projectId, taskId, jobId };
}
function provider(output: unknown, before?: () => Promise<void>) {
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => { assertGoRequest(url, init); await before?.(); return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 30, completion_tokens: 25 } }); });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
const update = (taskId: string) => ({ taskId, title: '缩小范围后的任务', detail: '实现主路径与键盘操作', criteria: '主路径可用且全部控件支持键盘', effortHours: 3 });

describe('project AI authority', () => {
  it('project create defaults to enabled and same intent cannot create duplicate projects', async () => {
    const owner = await seedUser();
    const key = newId();
    const body = { name: '默认启用项目' };
    const first = await request(owner.token, '/projects', body, 'POST', key);
    const created = (await first.json() as { data: { id: string; aiCollaborationEnabled: boolean } }).data;
    expect(first.status).toBe(201);
    expect(created.aiCollaborationEnabled).toBe(true);
    const repeat = await request(owner.token, '/projects', body, 'POST', key);
    expect((await repeat.json() as { data: { id: string } }).data.id).toBe(created.id);
    expect((await request(owner.token, '/projects', { name: '另一意图' }, 'POST', key)).status).toBe(409);
    const settings = await request(owner.token, `/projects/${created.id}/collaboration/settings`);
    expect((await settings.json() as { data: unknown }).data).toEqual({ aiCollaborationEnabled: true, assignmentMode: 'automatic', evaluationMode: 'automatic', planningMode:'automatic',progressionMode:'automatic', revision: 1 });
    const enabled = await request(owner.token, '/projects', { name: '明确开启项目', aiCollaborationEnabled: true });
    const enabledId = (await enabled.json() as { data: { id: string } }).data.id;
    expect((await (await request(owner.token, `/projects/${enabledId}/collaboration/settings`)).json() as { data: unknown }).data).toEqual({ aiCollaborationEnabled: true, assignmentMode: 'automatic', evaluationMode: 'automatic', planningMode:'automatic',progressionMode:'automatic', revision: 1 });
  });
  it('current project ownership is required, with CAS and one audit event', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const projectId = await seedProject(owner.userId);
    await env.DB.batch([env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(), projectId, member.userId, nowIso()), env.DB.prepare("UPDATE auth_accounts SET account_role='super_admin',is_admin=1 WHERE user_id=?1").bind(member.userId)]);
    const path = `/projects/${projectId}/collaboration/settings`;
    expect((await request(member.token, path, { expectedRevision: 1, aiCollaborationEnabled: true }, 'PATCH')).status).toBe(403);
    expect((await request(owner.token, path, { expectedRevision: 1, aiCollaborationEnabled: true }, 'PATCH')).status).toBe(200);
    expect((await request(owner.token, path, { expectedRevision: 1, aiCollaborationEnabled: false }, 'PATCH')).status).toBe(409);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM events WHERE project_id=?1 AND type='collaboration.settings_changed'").bind(projectId).first<{ n: number }>())?.n).toBe(1);
  });
  it('disabled projects reject new model jobs and foreign/submitted scopes before dispatch', async () => {
    await configureGoFixture();
    const owner = await seedUser();
    const projectId = await seedProject(owner.userId);
    const path = `/projects/${projectId}/collaboration/decompose`;
    expect((await request(owner.token, path, { brief: '创建明确任务' })).status).toBe(503);
    await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(projectId).run();
    expect((await request(owner.token, path, { brief: '调整', taskIds: [newId()] })).status).toBe(409);
    expect((await request(owner.token, path, { brief: '调整', grantOwner: true })).status).toBe(400);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM jobs WHERE project_id=?1').bind(projectId).first<{ n: number }>())?.n).toBe(0);
  });
});

describe('bounded owner task instructions', () => {
  it('requires administrator approval for task edits and preserves assignee after approval', async () => {
    const f = await fixture();
    const fetch = provider({ tasks: [], updates: [update(f.taskId)] });
    await runCollaborationAiJob(env, f.jobId);
    const job = await getJob(env, f.jobId);
    expect(job.status).toBe('succeeded');
    expect((await env.DB.prepare('SELECT revision FROM tasks WHERE id=?1').bind(f.taskId).first<{revision:number}>())?.revision).toBe(1);
    const outcome=JSON.parse(job.result_json!);
    expect(outcome.autoApplied).toBe(false);
    expect((await request(f.owner.token,`/projects/${f.projectId}/collaboration/proposals/${outcome.proposalId}/apply`,{expectedRevision:1})).status).toBe(200);
    const task = await env.DB.prepare('SELECT title,criteria,assignee_id,revision FROM tasks WHERE id=?1').bind(f.taskId).first();
    expect(task).toMatchObject({ title: '缩小范围后的任务', criteria: '主路径可用且全部控件支持键盘', assignee_id: f.owner.userId, revision: 2 });
    const event = await env.DB.prepare("SELECT actor_type,actor_id FROM events WHERE project_id=?1 AND type='collaboration.proposal_applied'").bind(f.projectId).first();
    expect(event).toEqual({ actor_type: 'user', actor_id: f.owner.userId });
    await runCollaborationAiJob(env, f.jobId);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM tasks WHERE project_id=?1').bind(f.projectId).first<{ n: number }>())?.n).toBe(1);
  });
  it('preserves manual preview mode and refuses a stale human edit', async () => {
    const f = await fixture(false);
    provider({ tasks: [], updates: [update(f.taskId)] });
    await runCollaborationAiJob(env, f.jobId);
    expect((await env.DB.prepare('SELECT revision FROM tasks WHERE id=?1').bind(f.taskId).first<{ revision: number }>())?.revision).toBe(1);
    const result = JSON.parse((await getJob(env, f.jobId)).result_json!) as { proposalId: string };
    await env.DB.prepare("UPDATE tasks SET revision=2,criteria='人类更新' WHERE id=?1").bind(f.taskId).run();
    expect((await request(f.owner.token, `/projects/${f.projectId}/collaboration/proposals/${result.proposalId}/apply`, { expectedRevision: 1 })).status).toBe(409);
    expect((await env.DB.prepare('SELECT criteria FROM tasks WHERE id=?1').bind(f.taskId).first<{ criteria: string }>())?.criteria).toBe('人类更新');
  });
  it.each(['queued', 'during-call'] as const)('disable %s blocks stale action application', async phase => {
    const f = await fixture();
    const disable = () => env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=0,collaboration_revision=2 WHERE id=?1').bind(f.projectId).run().then(() => undefined);
    const fetch = provider({ tasks: [], updates: [update(f.taskId)] }, phase === 'during-call' ? disable : undefined);
    if (phase === 'queued') await disable();
    await runCollaborationAiJob(env, f.jobId);
    expect((await getJob(env, f.jobId)).status).toBe('failed');
    expect((await env.DB.prepare('SELECT revision FROM tasks WHERE id=?1').bind(f.taskId).first<{ revision: number }>())?.revision).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(phase === 'queued' ? 0 : 1);
  });
  it('archiving and restoring a project does not revive an old queued automatic action', async () => {
    const f = await fixture();
    const fetch = provider({ tasks: [], updates: [update(f.taskId)] });
    const path = `/projects/${f.projectId}`;
    expect((await request(f.owner.token, path, { expectedRevision: 1, status: 'archived' }, 'PATCH')).status).toBe(200);
    expect((await request(f.owner.token, path, { expectedRevision: 2, status: 'active' }, 'PATCH')).status).toBe(200);
    await runCollaborationAiJob(env, f.jobId);
    expect((await getJob(env, f.jobId)).status).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
    expect((await env.DB.prepare('SELECT revision FROM tasks WHERE id=?1').bind(f.taskId).first<{ revision: number }>())?.revision).toBe(1);
  });
  it('rejects model escalation, foreign task edits, and extra privileged output', async () => {
    expect(adjustmentSchema.safeParse({ tasks: [], updates: [{ ...update(newId()), role: 'owner' }] }).success).toBe(false);
    expect(adjustmentSchema.safeParse({ tasks: [], updates: [], deleteProject: true }).success).toBe(false);
    const f = await fixture();
    provider({ tasks: [], updates: [update(newId())] });
    // A scope-escaping update is repairable model output: after the bounded repair it pauses for an
    // explicit resume instead of applying, so no privileged edit ever reaches the task.
    await expect(runCollaborationAiJob(env, f.jobId)).rejects.toBeInstanceOf(ExecutionPaused);
    expect((await getJob(env, f.jobId)).status).toBe('waiting_input');
    expect(await readExecution(env, { kind: 'job', id: f.jobId })).toMatchObject({ state: 'paused', pauseReason: 'output_invalid' });
    expect((await env.DB.prepare('SELECT revision FROM tasks WHERE id=?1').bind(f.taskId).first<{ revision: number }>())?.revision).toBe(1);
  });
});
