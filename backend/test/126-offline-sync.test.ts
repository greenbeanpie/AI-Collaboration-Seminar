import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';

describe('offline sync', () => {
  it('replays a committed create without creating duplicate tasks and rejects changed intent', async () => {
    const owner = await seedUser(), projectId = await seedProject(owner.userId), key = crypto.randomUUID();
    const sync = (title = '离线任务') => SELF.fetch(`${BASE}/api/v1/projects/${projectId}/offline-sync`, { method: 'POST', headers: { cookie: authCookie(owner.token), 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ method: 'POST', tail: 'tasks', body: { title } }) });
    const first = await sync(); expect(first.status).toBe(200);
    const data = await first.json() as { data: { taskId: string } };
    const second = await sync(); expect(second.status).toBe(200);
    expect((await second.json() as typeof data).data.taskId).toBe(data.data.taskId);
    expect((await env.DB.prepare('SELECT COUNT(*) count FROM tasks WHERE project_id=?1').bind(projectId).first<{ count: number }>())?.count).toBe(1);
    expect((await sync('另一份内容')).status).toBe(409);
  });
  it('retains the original version-conflict contract and rechecks current membership', async () => {
    const owner = await seedUser(), projectId = await seedProject(owner.userId);
    const call = (tail: string, method: string, body: unknown) => SELF.fetch(`${BASE}/api/v1/projects/${projectId}/offline-sync`, { method: 'POST', headers: { cookie: authCookie(owner.token), 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ tail, method, body }) });
    const created = await call('tasks', 'POST', { title: 'original' });
    const task = (await created.json() as { data: { taskId: string } }).data;
    const conflict = await call(`tasks/${task.taskId}`, 'PATCH', { expectedRevision: 99, title: 'stale' });
    expect(conflict.status).toBe(409); expect((await conflict.json() as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT');
    await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(projectId, owner.userId).run();
    expect((await call('tasks', 'POST', { title: 'revoked' })).status).toBe(403);
  });
  it('does not turn offline sync into an arbitrary API or administrator proxy', async () => {
    const owner = await seedUser(), projectId = await seedProject(owner.userId);
    for (const tail of ['../other/tasks', 'collaboration/decompose', 'assessments/manual', 'invitations', 'tasks?admin=true']) {
      const response = await SELF.fetch(`${BASE}/api/v1/projects/${projectId}/offline-sync`, { method: 'POST', headers: { cookie: authCookie(owner.token), 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ method: 'POST', tail, body: {} }) });
      expect(response.status).toBe(400);
    }
  });
  it('synchronizes public claim, submission and comment aliases with one durable result per intent', async () => {
    const owner = await seedUser(), projectId = await seedProject(owner.userId);
    const call = (tail: string, body: unknown, key = crypto.randomUUID()) => SELF.fetch(`${BASE}/api/v1/projects/${projectId}/offline-sync`, { method: 'POST', headers: { cookie: authCookie(owner.token), 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ tail, method: 'POST', body }) });
    const created = await call('tasks', { title: '离线协作', criteria: '提交真实成果说明' });
    const task = (await created.json() as { data: { taskId: string } }).data;
    const claimed = await call(`tasks/${task.taskId}/claim`, { expectedRevision: 1 });
    expect(claimed.status).toBe(200);
    const claimedTask = (await claimed.json() as { data: { revision: number } }).data;
    const key = crypto.randomUUID(), body = { expectedRevision: claimedTask.revision, body: '离线起草的成果说明', materialVersionIds: [] };
    const submission = await call(`tasks/${task.taskId}/submissions`, body, key);
    expect(submission.status).toBe(200);
    const replay = await call(`tasks/${task.taskId}/submissions`, body, key);
    expect(replay.status).toBe(200);
    expect((await env.DB.prepare('SELECT COUNT(*) count FROM task_submissions WHERE task_id=?1').bind(task.taskId).first<{ count: number }>())?.count).toBe(1);
    const commentKey = crypto.randomUUID(), comment = { targetType: 'task', targetId: task.taskId, body: '离线讨论' };
    expect((await call('comments', comment, commentKey)).status).toBe(200);
    expect((await call('comments', comment, commentKey)).status).toBe(200);
    expect((await env.DB.prepare('SELECT COUNT(*) count FROM comments WHERE target_id=?1').bind(task.taskId).first<{ count: number }>())?.count).toBe(1);
  });
});
