import { configureGoFixture } from './helpers/provider-config';
import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { mockGatewayFetch } from './helpers/ai-mock';
import { runAssignmentSuggestionJob } from '../src/services/assignment';

afterEach(() => {
  vi.unstubAllGlobals();
});

await configureGoFixture();

interface JobView {
  status: string;
  result: unknown;
  error: unknown;
}

async function finishJob(cookie: string, jobId: string): Promise<JobView> {
  for (let i = 0; i < 20; i++) {
    const res = await SELF.fetch(`${BASE}/api/v1/jobs/${jobId}`, { headers: { cookie } });
    if (res.status === 200) {
      const data = (await res.json() as { data: JobView }).data;
      if (['succeeded', 'failed'].includes(data.status)) return data;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await runAssignmentSuggestionJob(env, jobId);
  const res = await SELF.fetch(`${BASE}/api/v1/jobs/${jobId}`, { headers: { cookie } });
  return (await res.json() as { data: JobView }).data;
}

describe('分工建议与人工应用', () => {
  it('异步建议不直接修改任务；人工应用校验成员和版本且保留状态', async () => {
    const owner = await seedUser();
    const teammate = await seedUser('member@example.com', '团队成员');
    const outsider = await seedUser('outsider@example.com', '项目外用户');
    const projectId = await seedProject(owner.userId);
    const cookie = authCookie(owner.token);
    await env.DB.prepare(
      "INSERT INTO project_members (id, project_id, user_id, role, skills_json, hours_per_week, joined_at) VALUES (?1, ?2, ?3, 'member', ?4, ?5, ?6)",
    ).bind(crypto.randomUUID(), projectId, teammate.userId, JSON.stringify(['前端开发']), 8, new Date().toISOString()).run();

    // This compatibility route applies only to genuinely pre-existing legacy rows.
    const initialTask={taskId:crypto.randomUUID(),revision:1,status:'todo',assigneeId:null};
    await env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at) VALUES(?1,?2,'搭建原型','完成前端原型','todo',1,?3,?4,?4)").bind(initialTask.taskId,projectId,owner.userId,new Date().toISOString()).run();

    const markDoing = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/tasks/${initialTask.taskId}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: initialTask.revision, status: 'doing' }),
    });
    expect(markDoing.status).toBe(200);
    const taskBeforeSuggestion = (await markDoing.json() as { data: { revision: number; status: string; assigneeId: string | null } }).data;

    vi.stubGlobal('fetch', mockGatewayFetch());
    const request = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/assignment-suggestions`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(request.status).toBe(202);
    const { jobId } = (await request.json() as { data: { jobId: string } }).data;
    const job = await finishJob(cookie, jobId);
    expect(job.status).toBe('succeeded');
    const result = job.result as {
      assignments: Array<{ taskId: string; assigneeId: string | null; reason: string; expectedRevision: number }>;
      considerations: string[];
    };
    expect(result.assignments).toHaveLength(1);
    const suggestedAssigneeId = result.assignments[0]!.assigneeId;
    expect(result.assignments[0]).toMatchObject({
      taskId: initialTask.taskId,
      expectedRevision: taskBeforeSuggestion.revision,
    });
    expect([owner.userId, teammate.userId]).toContain(suggestedAssigneeId);
    expect(result.considerations).toHaveLength(1);

    const beforeApply = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/tasks/${initialTask.taskId}`, { headers: { cookie } });
    const untouched = (await beforeApply.json() as { data: { revision: number; status: string; assigneeId: string | null } }).data;
    expect(untouched).toEqual(taskBeforeSuggestion);

    const apply = async (assigneeId: string | null, expectedRevision: number) => SELF.fetch(
      `${BASE}/api/v1/projects/${projectId}/tasks/apply-assignment`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: initialTask.taskId, assigneeId, expectedRevision }),
      },
    );

    const applied = await apply(suggestedAssigneeId, taskBeforeSuggestion.revision);
    expect(applied.status).toBe(200);
    const assigned = (await applied.json() as { data: { revision: number; status: string; assigneeId: string | null } }).data;
    expect(assigned).toMatchObject({ revision: taskBeforeSuggestion.revision + 1, status: 'doing', assigneeId: suggestedAssigneeId });

    const stale = await apply(null, taskBeforeSuggestion.revision);
    expect(stale.status).toBe(409);
    expect((await stale.json() as { error: { code: string; details: { currentRevision: number } } }).error)
      .toMatchObject({ code: 'VERSION_CONFLICT', details: { currentRevision: assigned.revision } });

    const invalidMember = await apply(outsider.userId, assigned.revision);
    expect(invalidMember.status).toBe(400);
    expect((await invalidMember.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    const final = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/tasks/${initialTask.taskId}`, { headers: { cookie } });
    expect((await final.json() as { data: { revision: number; status: string; assigneeId: string | null } }).data).toEqual(assigned);
  });

  it('超过单次任务上限时不创建 AI job', async () => {
    const owner = await seedUser();
    const projectId = await seedProject(owner.userId);
    const cookie = authCookie(owner.token);
    const now = new Date().toISOString();
    const statements = Array.from({ length: 21 }, (_, index) => env.DB.prepare(
      "INSERT INTO tasks (id, project_id, title, detail, due_precision, status, revision, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, '', 'unknown', 'todo', 1, ?4, ?5, ?5)",
    ).bind(crypto.randomUUID(), projectId, `任务 ${index}`, owner.userId, now));
    await env.DB.batch(statements);

    const request = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/assignment-suggestions`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(request.status).toBe(400);
    const jobs = await env.DB.prepare('SELECT COUNT(*) AS count FROM jobs WHERE project_id = ?1 AND kind = \'assignment_suggest\'')
      .bind(projectId)
      .first<{ count: number }>();
    expect(jobs?.count).toBe(0);
  });

  it('重试分工 AI job 时也会先占用项目并发名额', async () => {
    const owner = await seedUser();
    const projectId = await seedProject(owner.userId);
    const cookie = authCookie(owner.token);
    const oldJobId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO jobs (id, project_id, kind, status, input_json, attempts, created_by, created_at, updated_at) VALUES (?1, ?2, 'assignment_suggest', 'failed', '{}', 1, ?3, ?4, ?4)",
    ).bind(oldJobId, projectId, owner.userId, createdAt).run();

    const retry = await SELF.fetch(`${BASE}/api/v1/jobs/${oldJobId}/retry`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(retry.status).toBe(202);
    const { jobId } = (await retry.json() as { data: { jobId: string } }).data;
    const reservation = await env.DB.prepare('SELECT purpose FROM usage_reservations WHERE job_id = ?1')
      .bind(jobId)
      .first<{ purpose: string }>();
    expect(reservation?.purpose).toBe('assignment_suggest');
  });
});
