import { prepareAutomaticJobRetry } from './ai-automatic-retries';
import { currentProjectFeedback } from './project-feedback';
import { activeExecutionSlice, ensureInitialExecutionSlice, dispatchExecutionSlice } from './ai-execution-slices';
import type { Env } from '../env';
import { loadAiConfig } from '../ai/config';
import { settleReservation } from './budget';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound } from '../core/errors';
import { assertSourceJobActive, loadActiveSourceVersion, sourceLifecycleGuard } from './source-lifecycle';

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
  sourceLifecycleVersion?: number;
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
  const sourceVersionId = typeof supplied.sourceVersionId === 'string' ? supplied.sourceVersionId : null;
  const lifecycle = sourceVersionId ? await loadActiveSourceVersion(env, sourceVersionId, typeof supplied.sourceLifecycleVersion === 'number' ? supplied.sourceLifecycleVersion : undefined) : null;
  if (lifecycle && params.projectId !== lifecycle.projectId) throw invalidState('来源不属于任务项目');
  const latestConfig = await loadAiConfig(env.DB);
  let frozenConfig = supplied.configVersionId ?? latestConfig?.id;
  // Independent summaries freeze the config chosen for this job, while parse/OCR
  // and requirements continue sharing the source's original frozen version.
  if (supplied.operation !== 'source.summary' && supplied.operation !== 'media.summary' && typeof supplied.sourceVersionId === 'string' && latestConfig?.enabled) {
    await env.DB.prepare(`UPDATE source_versions SET ai_config_version_id = ?2 WHERE id = ?1 AND ai_config_version_id IS NULL AND ${sourceLifecycleGuard('?1', '?3')}`).bind(supplied.sourceVersionId, frozenConfig ?? null, lifecycle!.lifecycleVersion).run();
    const source = await env.DB.prepare('SELECT ai_config_version_id FROM source_versions WHERE id = ?1').bind(supplied.sourceVersionId).first<{ ai_config_version_id: string | null }>();
    frozenConfig = source?.ai_config_version_id ?? frozenConfig;
  }
  const feedbackSnapshot = params.projectId ? await currentProjectFeedback(env, params.projectId) : undefined;
  const input = { ...supplied, feedbackSnapshot, configVersionId: frozenConfig, ...(lifecycle ? { sourceLifecycleVersion: lifecycle.lifecycleVersion } : {}) };
  const writes = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO jobs (id, project_id, kind, status, input_json, attempts, created_by, created_at, updated_at)
       SELECT ?1, ?2, ?3, 'queued', ?4, 0, ?5, ?6, ?6
       WHERE ?7 IS NULL OR ${sourceLifecycleGuard('?7', '?8')}`,
    ).bind(jobId, params.projectId, params.kind, JSON.stringify(input), params.createdBy, now, sourceVersionId, lifecycle?.lifecycleVersion ?? null),
    env.DB.prepare(
      "INSERT INTO job_outbox (id, job_id, status, available_at, attempts, created_at, updated_at) SELECT ?1, ?2, 'pending', ?3, 0, ?4, ?4 WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ?2 AND status = 'queued')",
    ).bind(newId(), jobId, now, now),
  ]);
  if (!(writes[0]?.meta.changes ?? 0)) throw invalidState('来源已移入回收站或生命周期已变化，请刷新后重试');
  await tryDispatchJob(env, jobId);
  return jobId;
}

const PARSE_JOB_KINDS = new Set(['parse_source', 'ocr_pages', 'requirement_extract', 'web_fetch']);

async function assertDispatchActive(env: Env, jobId: string): Promise<void> {
  const job = await getJob(env, jobId);
  if (!['queued','running'].includes(job.status)) throw invalidState('任务已停止');
  if (typeof (JSON.parse(job.input_json) as Record<string, unknown>).sourceVersionId === 'string') await assertSourceJobActive(env, jobId);
}

/** 尝试创建确定性实例（实例 ID = jobId；解析类走 PARSE_WORKFLOW，AI 类走 AGENT_WORKFLOW） */
export async function tryDispatchJob(env: Env, jobId: string): Promise<'dispatched' | 'deferred' | 'engine'> {
  try { await assertDispatchActive(env, jobId); } catch { return 'deferred'; }
  const claim = await env.DB.prepare(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?2 WHERE id = ?1 AND status = 'queued'
      AND (json_extract(input_json, '$.sourceVersionId') IS NULL OR ${sourceLifecycleGuard("json_extract(jobs.input_json, '$.sourceVersionId')", "COALESCE(json_extract(jobs.input_json, '$.sourceLifecycleVersion'), 1)")})`,
  )
    .bind(jobId, nowIso())
    .run();
  if ((claim.meta?.changes ?? 0) === 0) return 'deferred';

  try {
    const job = await getJob(env, jobId);
    const workflow = PARSE_JOB_KINDS.has(job.kind) ? env.PARSE_WORKFLOW : env.AGENT_WORKFLOW;
    await assertDispatchActive(env, jobId);
    if(PARSE_JOB_KINDS.has(job.kind)) await workflow.create({ id: jobId, params: { jobId } });
    else {
      await ensureInitialExecutionSlice(env,jobId);
      const slice=await activeExecutionSlice(env,jobId);
      if(!slice || !await dispatchExecutionSlice(env,slice)) return 'engine';
    }
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
    // A persisted relay must stay running: its pending slice is the recovery outbox.
    const current=await getJob(env,jobId);
    if(!PARSE_JOB_KINDS.has(current.kind) && await activeExecutionSlice(env,jobId)) return 'engine';
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

export async function failJob(env: Env, jobId: string, error: { code: string; message: string; details?: unknown }, expectedUpdatedAt?: string, expectedInstanceId?: string): Promise<boolean> {
  const failedAt=nowIso(),serializedError=JSON.stringify(error);
  const writes=[
    env.DB.prepare(
      "UPDATE jobs SET status = 'failed', error_json = ?2, finished_at = ?3, updated_at = ?3 WHERE id = ?1 AND status IN ('running', 'queued', 'waiting_input') AND (?4 IS NULL OR updated_at = ?4) AND (?5 IS NULL OR ?5 = (SELECT instance_id FROM ai_execution_slices WHERE job_id=?1 ORDER BY slice DESC LIMIT 1))",
    ).bind(jobId,serializedError,failedAt,expectedUpdatedAt??null,expectedInstanceId??null),
    env.DB.prepare("UPDATE job_outbox SET status='failed',last_error=?2,updated_at=?3 WHERE job_id=?1 AND EXISTS(SELECT 1 FROM jobs WHERE id=?1 AND status='failed' AND updated_at=?3 AND error_json=?4)").bind(jobId,error.code,failedAt,serializedError),
  ];
  const retry=prepareAutomaticJobRetry(env,jobId,error,failedAt);
  if(retry)writes.push(retry);
  const results=await env.DB.batch(writes);
  return (results[0]?.meta.changes ?? 0)>0;
}

export async function succeedJob(env: Env, jobId: string, result: unknown): Promise<void> {
  const transition = await env.DB.prepare(
    `UPDATE jobs SET status = 'succeeded', result_json = ?2, finished_at = ?3, updated_at = ?3 WHERE id = ?1 AND status IN ('running', 'queued')
      AND (json_extract(input_json, '$.sourceVersionId') IS NULL OR ${sourceLifecycleGuard("json_extract(jobs.input_json, '$.sourceVersionId')", "COALESCE(json_extract(jobs.input_json, '$.sourceLifecycleVersion'), 1)")})`,
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
    `UPDATE jobs SET status = 'waiting_input', result_json = ?2, updated_at = ?3 WHERE id = ?1 AND status IN ('running', 'queued')
      AND (json_extract(input_json, '$.sourceVersionId') IS NULL OR ${sourceLifecycleGuard("json_extract(jobs.input_json, '$.sourceVersionId')", "COALESCE(json_extract(jobs.input_json, '$.sourceLifecycleVersion'), 1)")})`,
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
  try { await assertDispatchActive(env, jobId); } catch { return; }
  const workflow = PARSE_JOB_KINDS.has(job.kind) ? env.PARSE_WORKFLOW : env.AGENT_WORKFLOW;
  const active = PARSE_JOB_KINDS.has(job.kind) ? null : await activeExecutionSlice(env,jobId);
  if(active?.status==='pending') { await dispatchExecutionSlice(env,active); return; }
  const instanceId=active?.instance_id ?? jobId;
  let state: InstanceStatus;
  try {
    const instance = await workflow.get(instanceId);
    state = await instance.status();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/(?:^|\b)instance\.not_found(?:$|\b)/.test(message)) throw error;
    // A process can die after claiming the job but before creating its instance.
    // Compare the observed version and update job + outbox atomically, so a late
    // business completion or another recovery cannot be overwritten.
    const started = await env.DB.prepare(
      `SELECT EXISTS (SELECT 1 FROM ai_calls WHERE job_id = ?1)
         OR EXISTS (SELECT 1 FROM media_calls WHERE job_id = ?1)
         OR EXISTS (SELECT 1 FROM usage_reservations WHERE job_id = ?1 AND attempts_started > 0) AS started`,
    ).bind(jobId).first<{ started: number }>();
    if ((!active && started?.started) || active?.status === 'running' || active?.status === 'complete') {
      const failed = await failJob(env, jobId, { code: 'INTERNAL', message: 'Workflow 实例缺失且模型调用已开始，请核对费用后重试新任务' }, job.updated_at, active?.instance_id);
      if (failed) await settleReservation(env, jobId, 'released');
      return;
    }
    if(active){
      await env.DB.prepare("UPDATE ai_execution_slices SET status='pending',updated_at=?3 WHERE job_id=?1 AND slice=?2 AND status='dispatched' AND NOT EXISTS(SELECT 1 FROM ai_execution_slices newer WHERE newer.job_id=?1 AND newer.slice>?2)").bind(jobId,active.slice,nowIso()).run();
      await dispatchExecutionSlice(env,{...active,status:'pending'});
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
    const failed = await failJob(env, jobId, { code: 'INTERNAL', message: 'Workflow 已结束但业务任务未提交结果，请重试新任务', details: { workflowStatus: state.status } }, job.updated_at, active?.instance_id);
    if (failed) await settleReservation(env, jobId, 'released');
  } else {
    // Refresh checked live instances so they do not starve older recovery candidates.
    await env.DB.prepare("UPDATE jobs SET updated_at = ?3 WHERE id = ?1 AND status = 'running' AND updated_at = ?2")
      .bind(jobId, job.updated_at, nowIso()).run();
  }
}
