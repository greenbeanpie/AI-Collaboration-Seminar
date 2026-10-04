import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { LIMITS } from '../core/limits';
import { quotaExceeded } from '../core/errors';
import { loadAiConfig, type AiPurpose, type LoadedAiConfig } from '../ai/config';

/**
 * AI 预算与并发预占（PLAN 二.7）：
 * - 每项目并行 AI 任务上限 2（LIMITS.concurrentAiTasksPerProject）。
 * - 调用前按模型价格与受限文本请求估算原子预占金额，调用后按真实用量结算。
 * - 未配置价格的模型金额记为 0（费用 unknown，不填零）；超时/用量未知 → pending_reconcile。
 * - 崩溃遗留的预占由 cron 释放，但仍在排队/运行的对应任务不得被释放（避免重复扣款与超额放行）。
 */

/** 任务种类 → 模型用途（决定用哪一档价格估算） */
const KIND_TO_AI_PURPOSE: Record<string, AiPurpose> = {
  agent_run: 'textEconomy',
  assignment_suggest: 'textEconomy',
  requirement_extract: 'textEconomy',
  source_summary: 'textEconomy',
  parse_source: 'textEconomy',
  ocr_pages: 'visionEconomy',
  review_run: 'review',
  rehearsal_turn: 'review',
};

/** 两次文本请求（含一次修复）的保守计划金额；图片 token 无可靠上界。 */
export function estimateCostUsd(config: LoadedAiConfig | null, purpose: AiPurpose, toolContext = false): number {
  const model = config?.config[purpose];
  const price = model?.pricePerMTokens;
  if (!model || !price) return 0;
  // No bounded estimate is available without an output cap. Unlimited-budget
  // projects still reconcile actual usage; finite budgets reject below.
  if (model.enabledOutputLimit === false) return 0;
  // UTF-8/JSON 转义按每个 UTF-16 单元最多 6 字节，加受限消息协议开销。
  // 这是文本规划金额；不覆盖供应商额外收费，需以账单核对。
  const inputTokens = model.maxInputChars * 6 + (toolContext ? 32000 : 4096);
  return 2 * (inputTokens * price[0] + model.maxOutputTokens * price[1]) / 1_000_000;
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

/** 在真实 fetch 前持久化尝试标记，调用记录写失败也不能释放费用。 */
export async function markAiCallStarted(env: Env, jobId: string | undefined, expandInvestigation=false): Promise<void> {
  if (!jobId) return;
  const active = await findActiveReservation(env, jobId);
  if (!active) throw quotaExceeded('任务没有活动预算预占，拒绝发起模型请求');
  const row=await env.DB.prepare('SELECT project_id,purpose,attempts_started,max_calls FROM usage_reservations WHERE id=?1').bind(active.id).first<{project_id:string;purpose:string;attempts_started:number;max_calls:number}>();
  // A finite execution allowance is independent of how many files can be discovered.
  // Never create another allowance automatically after exhaustion.
  if(expandInvestigation && row && row.purpose!=='ocr_pages' && row.attempts_started>=row.max_calls && row.max_calls<24) {
    const config=await loadAiConfig(env.DB,await frozenConfigVersionIdFor(env,jobId));
    const purpose=KIND_TO_AI_PURPOSE[row.purpose];
    const extra=purpose?estimateCostUsd(config,purpose,true):0;
    const extended=await env.DB.prepare(`UPDATE usage_reservations SET max_calls=MIN(24,max_calls+2),estimated_cost=estimated_cost+?2
      WHERE id=?1 AND status='reserved' AND max_calls=?3 AND max_calls<24
      AND EXISTS(SELECT 1 FROM jobs WHERE id=?4 AND status IN ('running','queued'))
      AND ((SELECT ai_budget_usd FROM projects WHERE id=?5) IS NULL OR
        (?2 <= (SELECT ai_budget_usd FROM projects WHERE id=?5) -
         (SELECT COALESCE(SUM(CASE WHEN status='settled' THEN COALESCE(settled_cost,0) ELSE estimated_cost END),0) FROM usage_reservations WHERE project_id=?5 AND status IN ('reserved','settled','pending_reconcile'))
         AND NOT EXISTS(SELECT 1 FROM usage_reservations WHERE project_id=?5 AND status='pending_reconcile')))`)
      .bind(active.id,extra,row.max_calls,jobId,row.project_id).run();
    if(!extended.meta.changes) throw quotaExceeded('继续调查所需预算不足；读取检查点已保存，可稍后重新发起');
  }
  const claim = await env.DB.prepare("UPDATE usage_reservations SET attempts_started = attempts_started + 1 WHERE id = ?1 AND status = 'reserved' AND (purpose = 'ocr_pages' OR attempts_started < max_calls)").bind(active.id).run();
  if ((claim.meta?.changes ?? 0) === 0) throw quotaExceeded('已达到本次预占的模型调用次数上限；调查检查点已保存，不会自动追加付费调用');
}

async function findActiveReservation(env: Env, jobId: string): Promise<{ id: string; created_at: string; attempts_started: number } | null> {
  return env.DB.prepare(
    "SELECT id, created_at, attempts_started FROM usage_reservations WHERE job_id = ?1 AND status = 'reserved' ORDER BY created_at DESC LIMIT 1",
  )
    .bind(jobId)
    .first<{ id: string; created_at: string; attempts_started: number }>();
}

/** 读取任务创建时冻结的模型配置版本（缺失时回退最新版本，仅影响估算精度） */
async function frozenConfigVersionIdFor(env: Env, jobId: string): Promise<string | undefined> {
  const job = await env.DB.prepare('SELECT input_json FROM jobs WHERE id = ?1').bind(jobId).first<{ input_json: string }>();
  if (!job) return undefined;
  try {
    const parsed = JSON.parse(job.input_json) as { configVersionId?: unknown };
    return typeof parsed.configVersionId === 'string' ? parsed.configVersionId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 原子预占一个 AI 并发槽位与估算金额。
 * 同一任务已有活动预占时直接返回（OCR 与要求提取可能分阶段复用同一任务）。
 */
export async function reserveAiSlot(
  env: Env,
  params: { projectId: string; jobId: string; purpose: string; configVersionId?: string; maxCalls?: number },
): Promise<void> {
  if (await findActiveReservation(env, params.jobId)) return;

  const config = await loadAiConfig(env.DB, params.configVersionId ?? await frozenConfigVersionIdFor(env, params.jobId));
  const aiPurpose = KIND_TO_AI_PURPOSE[params.purpose];
  const maxCalls = Math.max(2, Math.min(24, params.maxCalls ?? 2));
  const estimatedCost = (aiPurpose ? estimateCostUsd(config, aiPurpose, maxCalls > 2) : 0) * (maxCalls / 2);
  const project = await env.DB.prepare('SELECT ai_budget_usd FROM projects WHERE id = ?1').bind(params.projectId).first<{ ai_budget_usd: number | null }>();
  if (project?.ai_budget_usd !== null && project?.ai_budget_usd !== undefined) {
    const model = aiPurpose ? config?.config[aiPurpose] : undefined;
    // 任意兼容 API 的分词/附加计费与视觉输入 token 无法由本系统保证上界。
    if (!model?.pricePerMTokens || model.enabledOutputLimit === false || !Number.isFinite(estimatedCost) || aiPurpose === 'visionEconomy' || model.provider !== 'workers-ai') {
      throw quotaExceeded('有限金额预算要求已知价格和可估算的文本模型；图片/OCR或未知分词计费接口不能保证费用上界', { budgetUsd: project.ai_budget_usd, purpose: params.purpose });
    }
  }

  const result = await env.DB.prepare(
    `INSERT INTO usage_reservations (id, project_id, job_id, purpose, estimated_cost, status, created_at, max_calls)
     SELECT ?1, ?2, ?3, ?4, ?5, 'reserved', ?6, ?8
      WHERE (SELECT COUNT(*) FROM usage_reservations
              WHERE project_id = ?2 AND status = 'reserved') < ?7
        AND NOT EXISTS (SELECT 1 FROM usage_reservations WHERE job_id = ?3 AND status = 'reserved')
        AND ((SELECT ai_budget_usd FROM projects WHERE id = ?2) IS NULL
             OR (NOT EXISTS (SELECT 1 FROM usage_reservations WHERE project_id = ?2 AND status = 'pending_reconcile')
             AND ?5 <= (SELECT ai_budget_usd FROM projects WHERE id = ?2)
                      - (SELECT COALESCE(SUM(CASE WHEN status = 'settled' THEN COALESCE(settled_cost, 0) ELSE COALESCE(estimated_cost, 0) END), 0)
                           FROM usage_reservations
                          WHERE project_id = ?2 AND status IN ('reserved', 'pending_reconcile', 'settled'))))`,
  )
    .bind(
      newId(),
      params.projectId,
      params.jobId,
      params.purpose,
      estimatedCost,
      nowIso(),
      LIMITS.concurrentAiTasksPerProject,
      maxCalls,
    )
    .run();

  if ((result.meta?.changes ?? 0) === 0) {
    if (await findActiveReservation(env, params.jobId)) return;
    // 区分并发超限与预算不足，给出可操作的错误
    const state = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM usage_reservations WHERE project_id = ?1 AND status = 'reserved') AS active,
              (SELECT ai_budget_usd FROM projects WHERE id = ?1) AS budget,
              (SELECT COALESCE(SUM(CASE WHEN status = 'settled' THEN COALESCE(settled_cost, 0) ELSE COALESCE(estimated_cost, 0) END), 0)
                 FROM usage_reservations WHERE project_id = ?1 AND status IN ('reserved', 'pending_reconcile', 'settled')) AS committed`,
    )
      .bind(params.projectId)
      .first<{ active: number; budget: number | null; committed: number }>();

    if ((state?.active ?? 0) >= LIMITS.concurrentAiTasksPerProject) {
      throw quotaExceeded('该项目的 AI 任务并发已达上限，请等待进行中的任务完成', {
        limit: LIMITS.concurrentAiTasksPerProject,
      maxCalls,
      });
    }
    throw quotaExceeded('项目 AI 预算不足，请提高预算或等待结算后重试', {
      budgetUsd: state?.budget ?? null,
      committedUsd: state?.committed ?? 0,
      estimatedCostUsd: estimatedCost,
    });
  }
}

/**
 * 结算或释放预占。
 * settled：按该次预占之后产生的 ai_calls 真实费用结算；存在费用未知的调用 → pending_reconcile。
 * released：仅未发生调用时释放；已发生调用仍结算，费用未知或记录缺失则待对账。
 */
export async function settleReservation(env: Env, jobId: string, outcome: 'settled' | 'released', settledAt = nowIso()): Promise<void> {
  const active = await findActiveReservation(env, jobId);
  if (!active) return;
  const now = settledAt;
  const agg = await env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN cost_status = 'known' THEN cost_usd ELSE 0 END), 0) AS known_cost,
            SUM(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END) AS unknown_calls, COUNT(*) AS calls
       FROM (SELECT cost_status,cost_usd FROM ai_calls WHERE reservation_id = ?3 OR (reservation_id IS NULL AND job_id = ?1 AND created_at >= ?2) UNION ALL SELECT cost_status,cost_usd FROM media_calls WHERE job_id=?1 AND created_at>=?2)`,
  )
    .bind(jobId, active.created_at, active.id)
    .first<{ known_cost: number; unknown_calls: number | null; calls: number }>();

  const unknown = (agg?.unknown_calls ?? 0) > 0 || active.attempts_started > (agg?.calls ?? 0);
  const status = unknown ? 'pending_reconcile' : outcome === 'released' && !agg?.calls ? 'released' : 'settled';
  await env.DB.prepare(
    "UPDATE usage_reservations SET status = ?2, settled_cost = ?3, settled_at = ?4 WHERE id = ?1 AND status = 'reserved'",
  )
    .bind(active.id, status, unknown || status === 'released' ? null : (agg?.known_cost ?? 0), now)
    .run();
}

/**
 * cron：释放超过 2 小时且对应任务已不在排队/运行中的预占。
 * 仍在 queued/running/waiting_input 的任务不释放，避免重复扣款或超额放行；
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
