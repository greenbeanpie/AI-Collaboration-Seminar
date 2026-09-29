import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { LIMITS } from '../core/limits';
import { quotaExceeded } from '../core/errors';

/**
 * AI 预算/并发预占（PLAN 二.7）：每项目并行 AI 任务上限 2。
 * 调用前原子预占（计数检查 + 插入），任务完成/失败时结算/释放；
 * 崩溃遗留的预占由 cron 按时限释放（backend_plan.md 4.7）。
 */
export async function reserveAiSlot(
  env: Env,
  params: { projectId: string; jobId: string; purpose: string },
): Promise<void> {
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM usage_reservations WHERE project_id = ?1 AND status IN ('reserved', 'pending_reconcile')",
  )
    .bind(params.projectId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= LIMITS.concurrentAiTasksPerProject) {
    throw quotaExceeded('该项目的 AI 任务并发已达上限，请等待进行中的任务完成', {
      limit: LIMITS.concurrentAiTasksPerProject,
    });
  }
  await env.DB.prepare(
    "INSERT INTO usage_reservations (id, project_id, job_id, purpose, estimated_cost, status, created_at) VALUES (?1, ?2, ?3, ?4, 0, 'reserved', ?5)",
  )
    .bind(newId(), params.projectId, params.jobId, params.purpose, nowIso())
    .run();
}

export async function settleReservation(env: Env, jobId: string, outcome: 'settled' | 'released'): Promise<void> {
  await env.DB.prepare(
    'UPDATE usage_reservations SET status = ?2, settled_at = ?3 WHERE job_id = ?1 AND status = ?4',
  )
    .bind(jobId, outcome, nowIso(), 'reserved')
    .run();
}

/** cron：释放超过 2 小时仍未结算的预占（对应任务应已被标记失败） */
export async function releaseStaleReservations(env: Env, now: string): Promise<void> {
  const staleBefore = new Date(Date.now() - 2 * 3600_000).toISOString();
  await env.DB.prepare(
    "UPDATE usage_reservations SET status = 'released', settled_at = ?2 WHERE status = 'reserved' AND created_at <= ?1",
  )
    .bind(now, staleBefore)
    .run();
}
