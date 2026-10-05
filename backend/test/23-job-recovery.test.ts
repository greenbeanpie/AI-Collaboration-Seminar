import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { handleScheduled, recoverJobs } from '../src/cron';
import { env } from './helpers/env';
import { newId, nowIso } from '../src/core/db';
import { seedProject, seedUser } from './helpers/seed';
import { assertNotTerminal, failJob, getJob, succeedJob, reconcileWorkflowJob } from '../src/services/jobs';

const seededJobIds: string[] = [];

afterEach(async () => {
  for (const jobId of seededJobIds.splice(0)) {
    await env.DB.prepare('DELETE FROM ai_calls WHERE job_id = ?1').bind(jobId).run();
    await env.DB.prepare('DELETE FROM usage_reservations WHERE job_id = ?1').bind(jobId).run();
    await env.DB.prepare('DELETE FROM jobs WHERE id = ?1').bind(jobId).run();
  }
});

interface Seeded {
  jobId: string;
  projectId: string;
}

async function seedJob(status: string): Promise<Seeded> {
  const owner = await seedUser();
  const projectId = await seedProject(owner.userId);
  const jobId = newId();
  seededJobIds.push(jobId);
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

function withWorkflow(workflow: { get?: unknown; create?: unknown }): Env {
  return { ...env, AGENT_WORKFLOW: workflow as unknown as Workflow };
}

async function ageRunningJob(jobId: string, outboxStatus = 'pending'): Promise<void> {
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE jobs SET updated_at = ?2 WHERE id = ?1').bind(jobId, old),
    env.DB.prepare('UPDATE job_outbox SET status = ?2, available_at = ?3, lease_until = NULL WHERE job_id = ?1').bind(jobId, outboxStatus, old),
  ]);
}

async function outboxStatus(jobId: string): Promise<string | undefined> {
  return (await env.DB.prepare('SELECT status FROM job_outbox WHERE job_id = ?1').bind(jobId).first<{ status: string }>())?.status;
}

describe('A07 engine and database recovery', () => {
  it('crash after claim before instance creation: cron redispatches once in the same run', async () => {
    const { jobId } = await seedJob('running');
    await ageRunningJob(jobId);
    const create = vi.fn(async () => ({ id: jobId }));
    const testEnv = withWorkflow({ get: vi.fn(async () => { throw new Error('instance.not_found'); }), create });
    await handleScheduled(testEnv);
    expect(create).toHaveBeenCalledExactlyOnceWith({ id: jobId, params: { jobId } });
    expect((await getJob(env, jobId)).status).toBe('running');
    expect(await outboxStatus(jobId)).toBe('dispatched');
    await handleScheduled(testEnv);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('an active instance is not recreated', async () => {
    const { jobId } = await seedJob('running');
    await ageRunningJob(jobId, 'dispatched');
    const create = vi.fn();
    await handleScheduled(withWorkflow({ get: async () => ({ status: async () => ({ status: 'running' }) }), create }));
    expect(create).not.toHaveBeenCalled();
    expect((await getJob(env, jobId)).status).toBe('running');
    expect(await outboxStatus(jobId)).toBe('dispatched');
  });

  it('a transient engine failure never permits replay', async () => {
    const { jobId } = await seedJob('running');
    await ageRunningJob(jobId);
    await expect(reconcileWorkflowJob(withWorkflow({ get: async () => { throw new Error('upstream timeout'); } }), jobId)).rejects.toThrow('upstream timeout');
    expect((await getJob(env, jobId)).status).toBe('running');
    expect(await outboxStatus(jobId)).toBe('pending');
  });

  it.each(['complete', 'errored', 'terminated'])('engine %s without committed business result fails explicitly', async (status) => {
    const { jobId } = await seedJob('running');
    await reconcileWorkflowJob(withWorkflow({ get: async () => ({ status: async () => ({ status }) }) }), jobId);
    expect((await getJob(env, jobId)).status).toBe('failed');
    expect((await getJob(env, jobId)).error_json).toContain(status);
    expect(await outboxStatus(jobId)).toBe('failed');
  });

  it('business success racing engine completion preserves result and outbox', async () => {
    const { jobId } = await seedJob('running');
    await reconcileWorkflowJob(withWorkflow({ get: async () => ({ status: async () => {
      await succeedJob(env, jobId, { committed: true });
      return { status: 'complete' };
    } }) }), jobId);
    expect((await getJob(env, jobId)).status).toBe('succeeded');
    expect(await outboxStatus(jobId)).toBe('done');
  });

  it('business success racing a missing instance is not requeued', async () => {
    const { jobId } = await seedJob('running');
    await ageRunningJob(jobId);
    await reconcileWorkflowJob(withWorkflow({ get: async () => {
      await succeedJob(env, jobId, { committed: true });
      throw new Error('instance.not_found');
    } }), jobId);
    expect((await getJob(env, jobId)).status).toBe('succeeded');
    expect(await outboxStatus(jobId)).toBe('done');
  });

  it('exhausted retries for a missing instance fail explicitly', async () => {
    const { jobId } = await seedJob('running');
    await ageRunningJob(jobId);
    await env.DB.prepare('UPDATE job_outbox SET attempts = 5 WHERE job_id = ?1').bind(jobId).run();
    const create = vi.fn();
    await handleScheduled(withWorkflow({ get: async () => { throw new Error('instance.not_found'); }, create }));
    expect((await getJob(env, jobId)).status).toBe('failed');
    expect(await outboxStatus(jobId)).toBe('failed');
    expect(create).not.toHaveBeenCalled();
  });

  it('concurrent recoverers claim only one dispatch', async () => {
    const { jobId } = await seedJob('queued');
    await ageRunningJob(jobId);
    const create = vi.fn(async () => ({ id: jobId }));
    const testEnv = withWorkflow({ create });
    await Promise.all([recoverJobs(testEnv, nowIso()), recoverJobs(testEnv, nowIso())]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(await outboxStatus(jobId)).toBe('dispatched');
  });
});

describe('A07 model attempt replay boundary', () => {
  it('missing instance with a recorded call fails without redispatch', async () => {
    const { jobId, projectId } = await seedJob('running');
    await ageRunningJob(jobId);
    await env.DB.prepare(
      "INSERT INTO usage_reservations (id, project_id, job_id, purpose, attempts_started, created_at) VALUES (?1, ?2, ?3, 'textEconomy', 1, ?4)",
    ).bind(newId(), projectId, jobId, nowIso()).run();
    await env.DB.prepare(
      "INSERT INTO ai_calls (id, project_id, job_id, purpose, model, created_at) VALUES (?1, ?2, ?3, 'textEconomy', 'fixture', ?4)",
    ).bind(newId(), projectId, jobId, nowIso()).run();
    const create = vi.fn();
    await handleScheduled(withWorkflow({ get: async () => { throw new Error('instance.not_found'); }, create }));
    expect((await getJob(env, jobId)).status).toBe('failed');
    expect((await getJob(env, jobId)).error_json).toContain('模型调用已开始');
    const reservation = await env.DB.prepare('SELECT status FROM usage_reservations WHERE job_id = ?1').bind(jobId).first<{ status: string }>();
    expect(reservation).toEqual({ status: 'settled' });
    expect(create).not.toHaveBeenCalled();
    expect(await outboxStatus(jobId)).toBe('failed');
  });

  it('missing instance with an unrecorded started attempt fails without redispatch', async () => {
    const { jobId, projectId } = await seedJob('running');
    await ageRunningJob(jobId);
    await env.DB.prepare(
      "INSERT INTO usage_reservations (id, project_id, job_id, purpose, attempts_started, created_at) VALUES (?1, ?2, ?3, 'textEconomy', 1, ?4)",
    ).bind(newId(), projectId, jobId, nowIso()).run();
    const create = vi.fn();
    await handleScheduled(withWorkflow({ get: async () => { throw new Error('instance.not_found'); }, create }));
    expect((await getJob(env, jobId)).status).toBe('failed');
    expect(create).not.toHaveBeenCalled();
    const reservation = await env.DB.prepare('SELECT status FROM usage_reservations WHERE job_id = ?1').bind(jobId).first<{ status: string }>();
    expect(reservation).toEqual({ status: 'settled' });
    expect(await outboxStatus(jobId)).toBe('failed');
  });

  it('waiting for user input racing engine completion remains actionable', async () => {
    const { jobId } = await seedJob('running');
    await reconcileWorkflowJob(withWorkflow({ get: async () => ({ status: async () => {
      await env.DB.prepare("UPDATE jobs SET status = 'waiting_input', updated_at = ?2 WHERE id = ?1").bind(jobId, new Date(Date.now() + 1000).toISOString()).run();
      return { status: 'complete' };
    } }) }), jobId);
    expect((await getJob(env, jobId)).status).toBe('waiting_input');
    expect(await outboxStatus(jobId)).toBe('dispatched');
  });
});
