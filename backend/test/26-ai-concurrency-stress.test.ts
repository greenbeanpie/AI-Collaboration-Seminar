import { describe, expect, it } from 'vitest';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { markAiCallStarted, reserveAiSlot, settleReservation } from '../src/services/ai-reservations';

describe('AI concurrent reservation stress', () => {
  it('allows at most two active reservations for one project', async () => {
    const owner = await seedUser();
    const projectId = await seedProject(owner.userId);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      reserveAiSlot(env, { projectId, jobId: `stress-${index}-${projectId}`, purpose: 'agent_run' }),
    ));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected).toHaveLength(10);
    for (const result of rejected) expect((result.reason as { code?: string }).code).toBe('QUOTA_EXCEEDED');
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_reservations WHERE project_id=?1 AND status='reserved'").bind(projectId).first()).toEqual({ n: 2 });
  });

  it('frees the concurrency slot after a started job reaches a terminal state', async () => {
    const owner = await seedUser();
    const projectId = await seedProject(owner.userId);
    const firstJobId = `first-${projectId}`;
    await reserveAiSlot(env, { projectId, jobId: firstJobId, purpose: 'agent_run' });
    await markAiCallStarted(env, firstJobId);
    await settleReservation(env, firstJobId, 'released');
    expect(await env.DB.prepare('SELECT status FROM usage_reservations WHERE job_id=?1').bind(firstJobId).first()).toEqual({ status: 'settled' });
    await expect(reserveAiSlot(env, { projectId, jobId: `second-${projectId}`, purpose: 'agent_run' })).resolves.toBeUndefined();
  });
});
