import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { LIMITS } from '../core/limits';
import { AppError, quotaExceeded } from '../core/errors';
import { loadAiConfig } from '../ai/config';
import { loadExecutionPolicy, resolveExecutionTarget } from './ai-execution-control';

/**
 * AI 并发槽位与调用额度预占：
 * - 每项目并行 AI 任务上限 2（LIMITS.concurrentAiTasksPerProject）。
 * - 模型轮次由独立执行窗口控制，本模块只管理项目并发槽位。
 * - 崩溃遗留的活动槽位由 cron 释放，但仍在排队/运行的任务不会被释放。
 */

/** Distinguish project admission from monetary/provider quotas. */
export function isConcurrencyLimitError(error: unknown): boolean {
  return error instanceof AppError && error.code === 'QUOTA_EXCEEDED'
    && error.details?.limit === LIMITS.concurrentAiTasksPerProject;
}

/** 在业务写入和派发之前冻结配置与预占。创建失败且任务未落库才释放。 */
export async function withReservedAiJob<T>(
  env: Env,
  params: { projectId: string; purpose: string; maxCalls?: number },
  create: (jobId: string, configVersionId: string | undefined) => Promise<T>,
): Promise<T> {
  const jobId = newId();
  const config = await loadAiConfig(env.DB);
  await reserveAiSlot(env, { ...params, jobId, configVersionId: config?.id });
  try {
    return await create(jobId, config?.id);
  } catch (error) {
    const job = await env.DB.prepare('SELECT id FROM jobs WHERE id = ?1').bind(jobId).first();
    if (!job) await settleReservation(env, jobId, 'released');
    throw error;
  }
}

/** 在真实 fetch 前持久化尝试标记，调用记录写失败也不能重放请求。 */
export async function markAiCallStarted(env: Env, jobId: string | undefined, _expandInvestigation=false): Promise<void> {
  if (!jobId) return;
  const active = await findActiveReservation(env, jobId);
  if (!active) throw quotaExceeded('任务没有活动并发预占，拒绝发起模型请求');
  const claim = await env.DB.prepare("UPDATE usage_reservations SET attempts_started = attempts_started + 1 WHERE id = ?1 AND status = 'reserved'").bind(active.id).run();
  if ((claim.meta?.changes ?? 0) === 0) throw quotaExceeded('任务并发槽位已变化，请刷新处理状态');
}

async function findActiveReservation(env: Env, jobId: string): Promise<{ id: string; created_at: string; attempts_started: number } | null> {
  return env.DB.prepare(
    "SELECT id, created_at, attempts_started FROM usage_reservations WHERE job_id = ?1 AND status = 'reserved' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(jobId)
    .first<{ id: string; created_at: string; attempts_started: number }>();
}

/**
 * 原子预占一个 AI 并发槽位。
 * 同一任务已有活动预占时直接返回（OCR 与要求提取可能分阶段复用同一任务）。
 */
export async function reserveAiSlot(
  env: Env,
  params: { projectId: string; jobId: string; purpose: string; configVersionId?: string; maxCalls?: number },
): Promise<void> {
  if (await findActiveReservation(env, params.jobId)) return;

  const maxCalls = (await loadExecutionPolicy(env)).maxModelCalls;
  const result = await env.DB.prepare(
    `INSERT INTO usage_reservations (id, project_id, job_id, purpose, status, created_at, max_calls)
     SELECT ?1, ?2, ?3, ?4, 'reserved', ?5, ?7
      WHERE (SELECT COUNT(*) FROM usage_reservations
              WHERE project_id = ?2 AND status = 'reserved') < ?6
        AND NOT EXISTS (SELECT 1 FROM usage_reservations WHERE job_id = ?3 AND status = 'reserved')`,
  )
    .bind(
      newId(),
      params.projectId,
      params.jobId,
      params.purpose,
      nowIso(),
      LIMITS.concurrentAiTasksPerProject,
      maxCalls,
    )
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    if (await findActiveReservation(env, params.jobId)) return;
    const state = await env.DB.prepare("SELECT COUNT(*) AS active FROM usage_reservations WHERE project_id = ?1 AND status = 'reserved'")
      .bind(params.projectId)
      .first<{ active: number }>();
    if ((state?.active ?? 0) >= LIMITS.concurrentAiTasksPerProject) {
      throw quotaExceeded('该项目的 AI 任务并发已达上限，请等待进行中的任务完成', { limit: LIMITS.concurrentAiTasksPerProject });
    }
    throw quotaExceeded('无法创建任务并发预占，请重新发起');
  }
}

/** 任务结束时释放并发槽位；已开始的任务记为 settled，未发起调用的任务记为 released。 */
export async function settleReservation(env: Env, jobId: string, outcome: 'settled' | 'released', settledAt = nowIso()): Promise<void> {
  const active = await findActiveReservation(env, jobId);
  if (!active) return;
  const status = outcome === 'released' && active.attempts_started === 0 ? 'released' : 'settled';
  await env.DB.prepare(
    "UPDATE usage_reservations SET status = ?2, settled_at = ?3 WHERE id = ?1 AND status = 'reserved'",
  )
    .bind(active.id, status, settledAt)
    .run();
}

/** Release only an idle job; the SQL fence protects a concurrently acquired call or resumed execution. */
export async function releaseIdleReservation(env: Env, jobId: string, now = nowIso()): Promise<void> {
  const target = await resolveExecutionTarget(env, { kind: 'job', id: jobId });
  await env.DB.prepare(`UPDATE usage_reservations
    SET status = CASE WHEN attempts_started = 0 THEN 'released' ELSE 'settled' END, settled_at = ?3
    WHERE job_id = ?1 AND status = 'reserved'
      AND NOT EXISTS (SELECT 1 FROM ai_executions WHERE target_kind = 'job' AND target_id = ?2
        AND (inflight_token IS NOT NULL OR (state = 'paused' AND pause_reason = 'request_uncertain')))
      AND (EXISTS (SELECT 1 FROM jobs WHERE id = ?1 AND status IN ('succeeded','failed','cancelled','waiting_input'))
        OR EXISTS (SELECT 1 FROM ai_executions WHERE target_kind = 'job' AND target_id = ?2 AND state = 'paused')
        OR (NOT EXISTS (SELECT 1 FROM jobs WHERE id = ?1) AND created_at <= ?4))`)
    .bind(jobId, target.id, now, new Date(Date.parse(now) - 2 * 60_000).toISOString()).run();
}

/** Minute recovery: terminal/idle slots need no age delay. Orphans retain a creation grace period. */
export async function releaseStaleReservations(env: Env, now: string): Promise<void> {
  const orphanBefore = new Date(Date.parse(now) - 2 * 60_000).toISOString();
  const candidates = await env.DB.prepare(`SELECT r.job_id FROM usage_reservations r
    LEFT JOIN jobs j ON j.id = r.job_id
    WHERE r.status = 'reserved'
      AND (j.status IN ('succeeded','failed','cancelled','waiting_input')
        OR (j.id IS NULL AND r.created_at <= ?1)
        OR EXISTS (SELECT 1 FROM ai_executions e WHERE e.target_kind = 'job' AND e.target_id = r.job_id AND e.state = 'paused'))`)
    .bind(orphanBefore).all<{job_id:string}>();
  for (const row of candidates.results) await releaseIdleReservation(env, row.job_id, now);
}
