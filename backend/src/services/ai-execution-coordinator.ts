import type { Env } from '../env';
import { AppError } from '../core/errors';
import {
  acquireExecutionCall,
  abortExecutionCall,
  finishExecutionCall,
  readExecution,
  resolveExecutionTarget,
  type ExecutionCallToken,
  type ExecutionTarget,
} from './ai-execution-control';
import { claimAiResource, finishAiResource, type AiResourceClaim } from './ai-resource-quota';

export interface CoordinatedExecutionSlot {
  target: ExecutionTarget;
  token: ExecutionCallToken;
  resourceClaim?: AiResourceClaim;
}

/**
 * Execution Coordinator: unifies cross-table state transitions across
 * `ai_resource_dispatches` (daily/global quota), `ai_executions` (generation/window),
 * and `usage_reservations` (project concurrency slots).
 */
export function buildCancelExecutionBatch(
  env: Env,
  t: ExecutionTarget,
  generation: number,
  now: string,
): D1PreparedStatement[] {
  const writes: D1PreparedStatement[] = [
    env.DB.prepare(
      `WITH RECURSIVE chain(id) AS (SELECT ?2 UNION SELECT l.retry_job_id FROM admin_ai_retry_links l JOIN chain ON l.parent_job_id=chain.id)
 UPDATE ai_executions SET state='cancelled',inflight_token=NULL,inflight_generation=NULL,updated_at=?3 WHERE target_kind=?1 AND target_id=?2 AND generation=?4 AND state IN ('running','paused','finalizing')
 AND (?1!='job' OR NOT EXISTS(SELECT 1 FROM jobs WHERE status='succeeded' AND (id IN (SELECT id FROM chain) OR json_extract(input_json,'$.autoRetryRootId')='job:'||?2)))`,
    ).bind(t.kind, t.id, now, generation),
  ];
  if (t.kind === 'job') {
    writes.push(
      env.DB.prepare(
        `WITH RECURSIVE chain(id) AS (SELECT ?1 UNION SELECT l.retry_job_id FROM admin_ai_retry_links l JOIN chain ON l.parent_job_id=chain.id)
  UPDATE jobs SET status='cancelled',finished_at=?2,updated_at=?2 WHERE status IN ('running','queued','waiting_input') AND (id IN (SELECT id FROM chain) OR json_extract(input_json,'$.autoRetryRootId')='job:'||?1)
    AND EXISTS(SELECT 1 FROM ai_executions WHERE target_kind='job' AND target_id=?1 AND state='cancelled' AND generation=?3 AND updated_at=?2)`,
      ).bind(t.id, now, generation),
      env.DB.prepare(
        `WITH RECURSIVE chain(id) AS (SELECT ?1 UNION SELECT l.retry_job_id FROM admin_ai_retry_links l JOIN chain ON l.parent_job_id=chain.id)
 UPDATE usage_reservations SET status=CASE WHEN attempts_started=0 THEN 'released' ELSE 'settled' END,settled_at=?2
 WHERE status='reserved' AND job_id IN (SELECT id FROM jobs WHERE status='cancelled' AND (id IN (SELECT id FROM chain) OR json_extract(input_json,'$.autoRetryRootId')='job:'||?1))
 AND EXISTS(SELECT 1 FROM ai_executions WHERE target_kind='job' AND target_id=?1 AND state='cancelled' AND generation=?3 AND updated_at=?2)`,
      ).bind(t.id, now, generation),
    );
  }
  return writes;
}

export function buildReleaseIdleReservationStatement(
  env: Env,
  jobId: string,
  targetId: string,
  now: string,
): D1PreparedStatement {
  const orphanBefore = new Date(Date.parse(now) - 2 * 60_000).toISOString();
  return env.DB.prepare(
    `UPDATE usage_reservations
    SET status = CASE WHEN attempts_started = 0 THEN 'released' ELSE 'settled' END, settled_at = ?3
    WHERE job_id = ?1 AND status = 'reserved'
      AND NOT EXISTS (SELECT 1 FROM ai_executions WHERE target_kind = 'job' AND target_id = ?2
        AND (inflight_token IS NOT NULL OR (state = 'paused' AND pause_reason = 'request_uncertain')))
      AND (EXISTS (SELECT 1 FROM jobs WHERE id = ?1 AND status IN ('succeeded','failed','cancelled','waiting_input'))
        OR EXISTS (SELECT 1 FROM ai_executions WHERE target_kind = 'job' AND target_id = ?2 AND state = 'paused')
        OR (NOT EXISTS (SELECT 1 FROM jobs WHERE id = ?1) AND created_at <= ?4))`,
  ).bind(jobId, targetId, now, orphanBefore);
}

export async function acquireCoordinatedModelCall(
  env: Env,
  params: {
    jobId: string;
    operation: 'workers_ai' | 'text_or_vision' | 'media_understanding';
    model: string;
    resourceManaged?: boolean;
  },
): Promise<CoordinatedExecutionSlot> {
  const resourceClaim = params.resourceManaged
    ? undefined
    : await claimAiResource(env, { jobId: params.jobId, operation: params.operation, model: params.model });
  const target = await resolveExecutionTarget(env, { kind: 'job', id: params.jobId });
  try {
    const token = await acquireExecutionCall(env, target, env.AI_EXECUTION_CONTEXT?.generation);
    return { target, token, resourceClaim };
  } catch (error) {
    if (resourceClaim) await finishAiResource(env, resourceClaim, 'cancelled');
    throw error;
  }
}

export async function completeCoordinatedModelCall(
  env: Env,
  slot: CoordinatedExecutionSlot,
): Promise<void> {
  if (slot.resourceClaim) await finishAiResource(env, slot.resourceClaim, 'completed');
  if (!(await finishExecutionCall(env, slot.target, slot.token))) {
    throw new AppError('INVALID_STATE', '任务已取消或执行代次已变化；迟到结果不发布', 409, false, {
      executionSuperseded: true,
    });
  }
}

export async function abortCoordinatedModelCall(
  env: Env,
  slot: CoordinatedExecutionSlot,
  resourceOutcome: 'cancelled' | 'completed' | 'uncertain' = 'cancelled',
): Promise<void> {
  if (slot.resourceClaim) await finishAiResource(env, slot.resourceClaim, resourceOutcome);
  await abortExecutionCall(env, slot.target, slot.token);
}

export async function pauseUncertainCoordinatedCall(
  env: Env,
  slot: CoordinatedExecutionSlot,
  uncertain: boolean,
): Promise<void> {
  await finishExecutionCall(env, slot.target, slot.token, { uncertain });
  if (uncertain) {
    const { ExecutionPaused } = await import('./ai-execution-control');
    throw new ExecutionPaused((await readExecution(env, slot.target))!);
  }
}
