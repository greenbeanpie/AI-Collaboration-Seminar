import { afterEach, describe, expect, it } from 'vitest';
import { env } from './helpers/env';
import { newId, nowIso } from '../src/core/db';
import { seedProject, seedUser } from './helpers/seed';
import { assertNotTerminal, failJob, getJob, succeedJob } from '../src/services/jobs';

afterEach(() => {
  // 本文件不发送模型请求
});

interface Seeded {
  jobId: string;
  projectId: string;
}

async function seedJob(status: string): Promise<Seeded> {
  const owner = await seedUser();
  const projectId = await seedProject(owner.userId);
  const jobId = newId();
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO jobs (id, project_id, kind, status, input_json, attempts, created_by, created_at, updated_at) VALUES (?1, ?2, 'agent_run', ?3, '{}', 0, ?4, ?5, ?5)",
    ).bind(jobId, projectId, status, owner.userId, now),
    env.DB.prepare(
      "INSERT INTO job_outbox (id, job_id, status, available_at, attempts, created_at, updated_at) VALUES (?1, ?2, 'dispatched', ?3, 1, ?3, ?3)",
    ).bind(newId(), jobId, now),
  ]);
  return { jobId, projectId };
}

describe('A07 任务恢复与重复执行边界', () => {
  it('终态任务不会被延迟执行改回运行中或改写结果', async () => {
    const { jobId } = await seedJob('running');
    await succeedJob(env, jobId, { ok: true });
    expect((await getJob(env, jobId)).status).toBe('succeeded');

    // 迟到的失败回调不得覆盖终态，也不得把 outbox 改回 failed
    await failJob(env, jobId, { code: 'INTERNAL', message: '迟到失败' });
    const job = await getJob(env, jobId);
    expect(job.status).toBe('succeeded');
    expect(job.result_json).toContain('ok');
    const outbox = await env.DB.prepare('SELECT status FROM job_outbox WHERE job_id = ?1').bind(jobId).first<{ status: string }>();
    expect(outbox?.status).toBe('done');
  });

  it('失败终态同样不可被迟到成功覆盖', async () => {
    const { jobId } = await seedJob('running');
    await failJob(env, jobId, { code: 'AI_UNAVAILABLE', message: '模型不可用' });
    await succeedJob(env, jobId, { ok: true });
    const job = await getJob(env, jobId);
    expect(job.status).toBe('failed');
    expect(job.error_json).toContain('AI_UNAVAILABLE');
  });

  it('assertNotTerminal 对终态任务抛出 INVALID_STATE', async () => {
    const { jobId } = await seedJob('running');
    await succeedJob(env, jobId, { ok: true });
    await expect(assertNotTerminal(env, jobId)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('outbox 租约只允许一次抢占，租约过期后才可再次抢占', async () => {
    const { jobId } = await seedJob('queued');
    const now = nowIso();
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    const claim = "UPDATE job_outbox SET lease_until = ?2, attempts = attempts + 1, updated_at = ?3 WHERE job_id = ?1 AND (lease_until IS NULL OR lease_until <= ?3)";

    const first = await env.DB.prepare(claim).bind(jobId, future, now).run();
    expect(first.meta?.changes).toBe(1);
    const second = await env.DB.prepare(claim).bind(jobId, future, now).run();
    expect(second.meta?.changes).toBe(0);

    // 租约过期后可重新抢占
    const later = new Date(Date.now() + 10 * 60_000).toISOString();
    const third = await env.DB.prepare(claim).bind(jobId, new Date(Date.now() + 15 * 60_000).toISOString(), later).run();
    expect(third.meta?.changes).toBe(1);
  });
});
