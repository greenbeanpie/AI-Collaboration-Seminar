import type { Env } from '../env';
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
}

export interface ParseJobInput {
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
  params: { projectId: string | null; kind: JobKind; input: unknown; createdBy: string | null },
): Promise<string> {
  const jobId = newId();
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO jobs (id, project_id, kind, status, input_json, attempts, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, 'queued', ?4, 0, ?5, ?6, ?6)",
    ).bind(jobId, params.projectId, params.kind, JSON.stringify(params.input), params.createdBy, now),
    env.DB.prepare(
      "INSERT INTO job_outbox (id, job_id, status, available_at, attempts, created_at, updated_at) VALUES (?1, ?2, 'pending', ?3, 0, ?4, ?4)",
    ).bind(newId(), jobId, now, now),
  ]);
  await tryDispatchParseJob(env, jobId);
  return jobId;
}

/** 尝试创建确定性实例（实例 ID = jobId）；实例已存在或引擎不可用时不视为错误 */
export async function tryDispatchParseJob(env: Env, jobId: string): Promise<'dispatched' | 'deferred' | 'engine'> {
  const claim = await env.DB.prepare(
    "UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?2 WHERE id = ?1 AND status IN ('queued', 'waiting_input')",
  )
    .bind(jobId, nowIso())
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return 'deferred';

  try {
    await env.PARSE_WORKFLOW.create({ id: jobId, params: { jobId } });
    await env.DB.prepare("UPDATE job_outbox SET status = 'dispatched', updated_at = ?2 WHERE job_id = ?1")
      .bind(jobId, nowIso())
      .run();
    return 'dispatched';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('already exists')) {
      // 实例已存在：核对状态，不重复创建（PLAN 二.7）
      await env.DB.prepare("UPDATE job_outbox SET status = 'dispatched', updated_at = ?2 WHERE job_id = ?1")
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
    'SELECT id, project_id, kind, status, input_json, result_json, error_json, attempts, created_at FROM jobs WHERE id = ?1',
  )
    .bind(jobId)
    .first<JobRow>();
  if (!row) throw notFound('任务不存在');
  return row;
}

export async function failJob(env: Env, jobId: string, error: { code: string; message: string; details?: unknown }): Promise<void> {
  await env.DB.prepare(
    "UPDATE jobs SET status = 'failed', error_json = ?2, finished_at = ?3, updated_at = ?3 WHERE id = ?1 AND status IN ('running', 'queued')",
  )
    .bind(jobId, JSON.stringify(error), nowIso())
    .run();
  await env.DB.prepare("UPDATE job_outbox SET status = 'failed', last_error = ?2, updated_at = ?3 WHERE job_id = ?1")
    .bind(jobId, error.code, nowIso())
    .run();
}

export async function succeedJob(env: Env, jobId: string, result: unknown): Promise<void> {
  await env.DB.prepare(
    "UPDATE jobs SET status = 'succeeded', result_json = ?2, finished_at = ?3, updated_at = ?3 WHERE id = ?1 AND status IN ('running', 'queued')",
  )
    .bind(jobId, JSON.stringify(result ?? null), nowIso())
    .run();
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
