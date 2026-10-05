import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { LIMITS } from '../core/limits';
import { quotaExceeded } from '../core/errors';
import { loadAiConfig } from '../ai/config';

/**
 * AI 并发槽位与调用额度预占：
 * - 每项目并行 AI 任务上限 2（LIMITS.concurrentAiTasksPerProject）。
 * - 每个任务在首次模型请求前冻结有限调用额度，避免自动修复或调查无限扩张。
 * - 崩溃遗留的活动槽位由 cron 释放，但仍在排队/运行的任务不会被释放。
 */

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
export async function markAiCallStarted(env: Env, jobId: string | undefined, expandInvestigation=false): Promise<void> {
  if (!jobId) return;
  const active = await findActiveReservation(env, jobId);
  if (!active) throw quotaExceeded('任务没有活动并发预占，拒绝发起模型请求');
  const row=await env.DB.prepare('SELECT purpose,attempts_started,max_calls FROM usage_reservations WHERE id=?1').bind(active.id).first<{purpose:string;attempts_started:number;max_calls:number}>();
  // A finite execution allowance is independent of how many files can be discovered.
  // Never create another allowance automatically after exhaustion.
  if(expandInvestigation && row && row.purpose!=='ocr_pages' && row.attempts_started>=row.max_calls && row.max_calls<24) {
    const extended=await env.DB.prepare(`UPDATE usage_reservations SET max_calls=MIN(24,max_calls+2)
      WHERE id=?1 AND status='reserved' AND max_calls=?2 AND max_calls<24
      AND EXISTS(SELECT 1 FROM jobs WHERE id=?3 AND status IN ('running','queued'))
      `).bind(active.id,row.max_calls,jobId).run();
    if(!extended.meta.changes) throw quotaExceeded('无法扩展本次任务的调用额度；读取检查点已保存，可稍后重新发起');
  }
  const claim = await env.DB.prepare("UPDATE usage_reservations SET attempts_started = attempts_started + 1 WHERE id = ?1 AND status = 'reserved' AND (purpose = 'ocr_pages' OR attempts_started < max_calls)").bind(active.id).run();
  if ((claim.meta?.changes ?? 0) === 0) throw quotaExceeded('已达到本次预占的模型调用次数上限；调查检查点已保存，请重新发起任务');
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

  const maxCalls = Math.max(2, Math.min(params.purpose === 'audio_pipeline' ? 64 : 24, params.maxCalls ?? 2));
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

/**
 * cron：释放超过 2 小时且对应任务已不在排队/运行中的预占。
 * 仍在 queued/running/waiting_input 的任务不释放，避免并发槽位被重复占用或过早放行；
 * 任务记录缺失（孤儿预占）按已结束处理，避免永久占用槽位。
 */
export async function releaseStaleReservations(env: Env, now: string): Promise<void> {
  const staleBefore = new Date(new Date(now).getTime() - 2 * 3600_000).toISOString();
  const stale = await env.DB.prepare(
    `SELECT job_id FROM usage_reservations WHERE status = 'reserved' AND created_at <= ?1
       AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id = usage_reservations.job_id AND jobs.status IN ('queued', 'running', 'waiting_input'))`,
  ).bind(staleBefore).all<{ job_id: string }>();
  for (const row of stale.results) await settleReservation(env, row.job_id, 'released', now);
}
