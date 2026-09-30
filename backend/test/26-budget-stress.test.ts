import { describe, expect, it } from 'vitest';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { estimateCostUsd, reserveAiSlot, settleReservation } from '../src/services/budget';
import { loadAiConfig } from '../src/ai/config';

async function withPriced(model: string) {
  const row = await env.DB.prepare('SELECT id, config_json FROM ai_config_versions ORDER BY version DESC LIMIT 1')
    .first<{ id: string; config_json: string }>();
  const priced = JSON.parse(row!.config_json) as Record<string, { model: string; pricePerMTokens: [number, number] | null }>;
  for (const purpose of ['textEconomy', 'visionEconomy', 'review'] as const) {
    priced[purpose]!.model = model;
    priced[purpose]!.pricePerMTokens = [1_000_000, 1_000_000];
  }
  await env.DB.prepare('UPDATE ai_config_versions SET config_json = ?2 WHERE id = ?1')
    .bind(row!.id, JSON.stringify(priced))
    .run();
  return async () => {
    await env.DB.prepare('UPDATE ai_config_versions SET config_json = ?2 WHERE id = ?1')
      .bind(row!.id, row!.config_json)
      .run();
  };
}

describe('A13 并发与预算竞争压测', () => {
  it('同项目 12 个并发预占严格只通过 2 个，且活动预占数恒为 2', async () => {
    const owner = await seedUser();
    const pid = await seedProject(owner.userId);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        reserveAiSlot(env, { projectId: pid, jobId: `stress-${i}-${pid}`, purpose: 'agent_run' }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(10);
    for (const r of rejected) expect((r.reason as { code?: string }).code).toBe('QUOTA_EXCEEDED');

    const active = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM usage_reservations WHERE project_id = ?1 AND status IN ('reserved', 'pending_reconcile')",
    ).bind(pid).first<{ n: number }>();
    expect(active?.n).toBe(2);
  });

  it('并发预占不会让项目承诺金额超过预算，且释放后额度可复用', async () => {
    const restore = await withPriced('budget-stress-model');
    try {
      const owner = await seedUser();
      const pid = await seedProject(owner.userId);
      const config = await loadAiConfig(env.DB);
      const unit = estimateCostUsd(config, 'textEconomy');
      expect(unit).toBeGreaterThan(0);

      const budget = unit * 1.5; // 只容得下 1 次预占
      await env.DB.prepare('UPDATE projects SET ai_budget_usd = ?2 WHERE id = ?1').bind(pid, budget).run();

      const results = await Promise.allSettled([
        reserveAiSlot(env, { projectId: pid, jobId: `budget-a-${pid}`, purpose: 'agent_run' }),
        reserveAiSlot(env, { projectId: pid, jobId: `budget-b-${pid}`, purpose: 'agent_run' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect((rejected.reason as { code?: string }).code).toBe('QUOTA_EXCEEDED');
      expect((rejected.reason as { details?: { budgetUsd?: number } }).details?.budgetUsd).toBeCloseTo(budget);

      const committed = await env.DB.prepare(
        "SELECT COALESCE(SUM(estimated_cost), 0) AS c FROM usage_reservations WHERE project_id = ?1 AND status IN ('reserved', 'pending_reconcile', 'settled')",
      ).bind(pid).first<{ c: number }>();
      expect(committed!.c).toBeLessThanOrEqual(budget);

      // 释放后额度可再次预占
      const holder = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<void>;
      void holder;
      const reserved = await env.DB.prepare(
        "SELECT job_id FROM usage_reservations WHERE project_id = ?1 AND status = 'reserved'",
      ).bind(pid).first<{ job_id: string }>();
      await settleReservation(env, reserved!.job_id, 'released');
      await expect(
        reserveAiSlot(env, { projectId: pid, jobId: `budget-c-${pid}`, purpose: 'agent_run' }),
      ).resolves.toBeUndefined();
    } finally {
      await restore();
    }
  });

  it('预算为 0 时拒绝预占并给出预算明细，且不留下预占记录', async () => {
    // 必须先配置价格：价格未知时估算为 0，只受并发上限约束（见 budget.ts 注释）
    const restore = await withPriced('zero-budget-model');
    try {
      const owner = await seedUser();
      const pid = await seedProject(owner.userId);
      await env.DB.prepare('UPDATE projects SET ai_budget_usd = 0 WHERE id = ?1').bind(pid).run();

      let error: unknown;
      try {
        await reserveAiSlot(env, { projectId: pid, jobId: `zero-${pid}`, purpose: 'agent_run' });
      } catch (err) {
        error = err;
      }
      expect((error as { code?: string })?.code).toBe('QUOTA_EXCEEDED');
      expect((error as { details?: { budgetUsd?: number } })?.details?.budgetUsd).toBe(0);
      const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_reservations WHERE project_id = ?1').bind(pid).first<{ n: number }>();
      expect(rows?.n).toBe(0);
    } finally {
      await restore();
    }
  });
});
