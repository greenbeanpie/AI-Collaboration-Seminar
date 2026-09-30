import type { Env } from '../env';
import { loadAiConfig } from '../ai/config';
import { settleReservation } from './budget';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound } from '../core/errors';

export type JobKind =
  | 'parse_source'
  | 'ocr_pages'
  | 'requirement_extract'
  | 'assignment_suggest'
  | 'agent_run'
  | 'review_run'
  | 'rehearsal_turn'
  | 'web_fetch'
  | 'gc';

export interface JobRow {
  id: string;
  project_id: string | null;
  kind: JobKind;
  status: 'queued' | 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'cancelled';
  input_json: string;
  result_json: string | null;
  error_json: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface ParseJobInput {
  configVersionId?: string;
  sourceId: string;
  sourceVersionId: string;
  phase: 'extract' | 'ocr';
}

/**
 * 创建任务并写入 outbox（同一 batch），随后尽力派发。
 * 派发失败不阻塞：定时恢复器每分钟补投（backend_plan.md 4.6）。
 */
export async function createJobAndDispatch(
  env: Env,
  params: { projectId: string | null; kind: JobKind; input: unknown; createdBy: string | null; jobId?: string },
): Promise<string> {
  const jobId = params.jobId ?? newId();
  const now = nowIso();
  const supplied = params.input as Record<string, unknown>;
  const latestConfig = await loadAiConfig(env.DB);
  let frozenConfig = supplied.configVersionId ?? latestConfig?.id;
  if (typeof supplied.sourceVersionId === 'string' && latestConfig?.enabled) {
    await env.DB.prepare('UPDATE source_versions SET ai_config_version_id = ?2 WHERE id = ?1 AND ai_config_version_id IS NULL').bind(supplied.sourceVersionId, frozenConfig ?? null).run();
    const source = await env.DB.prepare('SELECT ai_config_version_id FROM source_versions WHERE id = ?1').bind(supplied.sourceVersionId).first<{ ai_config_version_id: string | null }>();
    frozenConfig = source?.ai_config_version_id ?? frozenConfig;
  }
  const input = { ...supplied, configVersionId: frozenConfig };
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO jobs (id, project_id, kind, status, input_json, attempts, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, 'queued', ?4, 0, ?5, ?6, ?6)",
    ).bind(jobId, params.projectId, params.kind, JSON.stringify(input), params.createdBy, now),
    env.DB.prepare(
      "INSERT INTO job_outbox (id, job_id, status, available_at, attempts, created_at, updated_at) VALUES (?1, ?2, 'pending', ?3, 0, ?4, ?4)",
    ).bind(newId(), jobId, now, now),
  ]);
  await tryDispatchJob(env, jobId);
  return jobId;
}

const PARSE_JOB_KINDS = new Set(['parse_source', 'ocr_pages', 'requirement_extract', 'web_fetch']);

/** 尝试创建确定性实例（实例 ID = jobId；解析类走 PARSE_WORKFLOW，AI 类走 AGENT_WORKFLOW） */
export async function tryDispatchJob(env: Env, jobId: string): Promise<'dispatched' | 'deferred' | 'engine'> {
  const claim = await env.DB.prepare(
    "UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?2 WHERE id = ?1 AND status IN ('queued', 'waiting_input')",
  )
    .bind(jobId, nowIso())
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return 'deferred';

  try {
    const job = await getJob(env, jobId);
    const workflow = PARSE_JOB_KINDS.has(job.kind) ? env.PARSE_WORKFLOW : env.AGENT_WORKFLOW;
    await workflow.create({ id: jobId, params: { jobId } });
    await env.DB.prepare("UPDATE job_outbox SET status = 'dispatched', updated_at = ?2 WHERE job_id = ?1 AND status = 'pending'")
      .bind(jobId, nowIso())
      .run();
    return 'dispatched';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('already exists')) {
      await reconcileWorkflowJob(env, jobId);
      // 只在已核对实例状态后标记派发。
      await env.DB.prepare("UPDATE job_outbox SET status = 'dispatched', updated_at = ?2 WHERE job_id = ?1 AND status = 'pending'")
        .bind(jobId, nowIso())
        .run();
      return 'dispatched';
    }
    // 引擎不可用（如本地/测试无 Workflow 运行时）：交由恢复器或同步执行兜底
    console.warn(`[jobs] workflow dispatch failed for ${jobId}: ${message}`);
    await env.DB.prepare("UPDATE jobs SET status = 'queued', updated_at = ?2 WHERE id = ?1 AND status = 'running'")
      .bind(jobId, nowIso())
      .run();
    return 'engine';
  }
}

export async function getJob(env: Env, jobId: string): Promise<JobRow> {
  const row = await env.DB.prepare(
    'SELECT id, project_id, kind, status, input_json, result_json, error_json, attempts, created_at, updated_at FROM jobs WHERE id = ?1',
  )
    .bind(jobId)
    .first<JobRow>();
  if (!row) throw notFound('任务不存在');
  return row;
}

export async function failJob(env: Env, jobId: string, error: { code: string; message: string; details?: unknown }, expectedUpdatedAt?: string): Promise<boolean> {
  const transition = await env.DB.prepare(
    "UPDATE jobs SET status = 'failed', error_json = ?2, finished_at = ?3, updated_at = ?3 WHERE id = ?1 AND status IN ('running', 'queued', 'waiting_input') AND (?4 IS NULL OR updated_at = ?4)",
  )
    .bind(jobId, JSON.stringify(error), nowIso(), expectedUpdatedAt ?? null)
    .run();
  if ((transition.meta?.changes ?? 0) === 0) return false;
  await env.DB.prepare("UPDATE job_outbox SET status = 'failed', last_error = ?2, updated_at = ?3 WHERE job_id = ?1")
    .bind(jobId, error.code, nowIso())
    .run();
  return true;
}

export async function succeedJob(env: Env, jobId: string, result: unknown): Promise<void> {
  const transition = await env.DB.prepare(
    "UPDATE jobs SET status = 'succeeded', result_json = ?2, finished_at = ?3, updated_at = ?3 WHERE id = ?1 AND status IN ('running', 'queued')",
  )
    .bind(jobId, JSON.stringify(result ?? null), nowIso())
    .run();
  if ((transition.meta?.changes ?? 0) === 0) return;
  await env.DB.prepare("UPDATE job_outbox SET status = 'done', updated_at = ?2 WHERE job_id = ?1")
    .bind(jobId, nowIso())
    .run();
}

export async function waitJobInput(env: Env, jobId: string, result: unknown): Promise<void> {
  await env.DB.prepare(
    "UPDATE jobs SET status = 'waiting_input', result_json = ?2, updated_at = ?3 WHERE id = ?1 AND status IN ('running', 'queued')",
  )
    .bind(jobId, JSON.stringify(result ?? null), nowIso())
    .run();
}

/** 终态不可逆：终态任务拒绝 retry/继续（PLAN 二.7） */
export async function assertNotTerminal(env: Env, jobId: string): Promise<JobRow> {
  const job = await getJob(env, jobId);
  if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
    throw invalidState('任务已进入终态');
  }
  return job;
}

/** Inspect the engine before recovering a stale dispatch; transient lookup errors never permit replay. */
export async function reconcileWorkflowJob(env: Env, jobId: string): Promise<void> {
  const job = await getJob(env, jobId);
  if (['succeeded', 'failed', 'cancelled', 'waiting_input'].includes(job.status)) return;
  const workflow = PARSE_JOB_KINDS.has(job.kind) ? env.PARSE_WORKFLOW : env.AGENT_WORKFLOW;
  let state: InstanceStatus;
  try {
    const instance = await workflow.get(jobId);
    state = await instance.status();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/(?:^|\b)instance\.not_found(?:$|\b)/.test(message)) throw error;
    // A process can die after claiming the job but before creating its instance.
    // Compare the observed version and update job + outbox atomically, so a late
    // business completion or another recovery cannot be overwritten.
    const started = await env.DB.prepare(
      `SELECT EXISTS (SELECT 1 FROM ai_calls WHERE job_id = ?1)
         OR EXISTS (SELECT 1 FROM usage_reservations WHERE job_id = ?1 AND attempts_started > 0) AS started`,
    ).bind(jobId).first<{ started: number }>();
    if (started?.started) {
      const failed = await failJob(env, jobId, { code: 'INTERNAL', message: 'Workflow 实例缺失且模型调用已开始，请核对费用后重试新任务' }, job.updated_at);
      if (failed) await settleReservation(env, jobId, 'released');
      return;
    }
    const recoveredAt = nowIso();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE job_outbox SET status = 'pending', lease_until = NULL, available_at = ?3, updated_at = ?3
         WHERE job_id = ?1 AND status IN ('pending', 'dispatched')
           AND EXISTS (SELECT 1 FROM jobs WHERE id = ?1 AND status = 'running' AND updated_at = ?2)`,
      ).bind(jobId, job.updated_at, recoveredAt),
      env.DB.prepare(
        `UPDATE jobs SET status = 'queued', updated_at = ?3 WHERE id = ?1 AND status = 'running' AND updated_at = ?2
           AND EXISTS (SELECT 1 FROM job_outbox WHERE job_id = ?1 AND status = 'pending' AND updated_at = ?3)`,
      ).bind(jobId, job.updated_at, recoveredAt),
    ]);
    return;
  }
  if (['errored', 'terminated', 'complete'].includes(state.status)) {
    const failed = await failJob(env, jobId, { code: 'INTERNAL', message: 'Workflow 已结束但业务任务未提交结果，请重试新任务', details: { workflowStatus: state.status } }, job.updated_at);
    if (failed) await settleReservation(env, jobId, 'released');
  } else {
    // Refresh checked live instances so they do not starve older recovery candidates.
    await env.DB.prepare("UPDATE jobs SET updated_at = ?3 WHERE id = ?1 AND status = 'running' AND updated_at = ?2")
      .bind(jobId, job.updated_at, nowIso()).run();
  }
}
