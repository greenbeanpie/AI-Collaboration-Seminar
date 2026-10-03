import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { recoverJobs } from '../src/cron';
import { newId, nowIso } from '../src/core/db';
import { createJobAndDispatch, getJob } from '../src/services/jobs';
import { recoverExecutionSlices } from '../src/services/ai-execution-slices';
import { answerClarification, cancelClarification, executeClarification, listProjectClarifications, UserClarificationPending } from '../src/services/ai-clarifications';
import { projectGoal } from '../src/services/project-simplification';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';

async function fixture() {
  await configureGoFixture();
  const owner = await seedUser(), projectId = await seedProject(owner.userId), jobId = newId();
  await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(projectId).run();
  const goal = await projectGoal(env, projectId);
  const input = { operation: 'collaboration.decompose', projectId, requestedBy: owner.userId, settingsRevision: 1, goalRevision: goal.revision, graphRevision: goal.graphRevision, brief: 'Fixture plan' };
  const binding = { userId: owner.userId, projectId, jobId, attemptId: jobId };
  const create = vi.fn(async () => ({ id: jobId }));
  const local = { ...env, AGENT_WORKFLOW: { create } } as unknown as Env;
  const start = () => createJobAndDispatch(local, { jobId, projectId, kind: 'agent_run', input, createdBy: owner.userId });
  const waitWithLostResponse = async () => {
    create.mockImplementationOnce(async () => {
      await expect(executeClarification(local, binding, { id: '0:ask', name: 'ask_user_question', args: { question: 'Which deliverable?', options: ['Report', 'Prototype'], allowUndecided: true } })).rejects.toBeInstanceOf(UserClarificationPending);
      throw new Error('Workflow accepted; create response lost');
    });
    await start();
    return (await listProjectClarifications(local, projectId, owner.userId))[0]!;
  };
  const outbox = () => env.DB.prepare('SELECT status,attempts,lease_until FROM job_outbox WHERE job_id=?1').bind(jobId).first<{status:string;attempts:number;lease_until:string|null}>();
  return { local, jobId, create, start, binding, waitWithLostResponse, outbox };
}

describe('clarification recovery after a lost initial dispatch response', () => {
  it('keeps a persisted question waiting without spending initial dispatch retries or failing at their limit', async () => {
    const f = await fixture(), question = await f.waitWithLostResponse();
    expect(await f.outbox()).toMatchObject({ status: 'pending', attempts: 0, lease_until: null });
    for (let tick = 0; tick < 6; tick++) await recoverJobs(f.local, new Date(Date.now() + tick * 360_000).toISOString());
    expect((await getJob(f.local, f.jobId)).status).toBe('waiting_input');
    expect(await f.outbox()).toMatchObject({ status: 'pending', attempts: 0, lease_until: null });
    await env.DB.prepare('UPDATE job_outbox SET attempts=5 WHERE job_id=?1').bind(f.jobId).run();
    await recoverJobs(f.local, nowIso());
    expect((await getJob(f.local, f.jobId)).status).toBe('waiting_input');
    expect(await env.DB.prepare('SELECT status FROM ai_clarifications WHERE id=?1').bind(question.id).first()).toEqual({ status: 'pending' });
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('recovers the durable answer continuation with its distinct execution slice', async () => {
    const f = await fixture(), question = await f.waitWithLostResponse();
    await answerClarification(f.local, f.binding, question.id, { expectedRevision: 1, text: 'Report' });
    await recoverExecutionSlices(f.local);
    await recoverJobs(f.local, nowIso());
    expect((await getJob(f.local, f.jobId)).status).toBe('running');
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.create).toHaveBeenLastCalledWith({ id: `${f.jobId}-s1`, params: { jobId: f.jobId, slice: 1 } });
    expect(await f.outbox()).toMatchObject({ attempts: 0, lease_until: null });
  });

  it('does not dispatch again after cancelling the persisted question', async () => {
    const f = await fixture(), question = await f.waitWithLostResponse();
    await cancelClarification(f.local, f.binding, question.id, 1);
    await recoverJobs(f.local, nowIso());
    await recoverExecutionSlices(f.local);
    expect((await getJob(f.local, f.jobId)).status).toBe('cancelled');
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it('still dispatches ordinary queued work after an initial create failure', async () => {
    const f = await fixture();
    f.create.mockRejectedValueOnce(new Error('Engine unavailable before acceptance'));
    await f.start();
    // Simulate a crash before the initial execution slice was persisted.
    await env.DB.prepare('DELETE FROM ai_execution_slices WHERE job_id=?1').bind(f.jobId).run();
    await env.DB.prepare("UPDATE jobs SET status='queued' WHERE id=?1").bind(f.jobId).run();
    await recoverJobs(f.local, nowIso());
    expect((await getJob(f.local, f.jobId)).status).toBe('running');
    expect(await f.outbox()).toMatchObject({ status: 'dispatched', attempts: 1 });
    expect(f.create).toHaveBeenCalledTimes(2);
  });
});
