import type { Env } from '../env';
import { nowIso, newId } from '../core/db';
import { loadAiConfig, type AiPurpose } from './config';

export interface AiCallRecord {
  projectId?: string | null;
  jobId?: string | null;
  runId?: string | null;
  purpose: AiPurpose;
  configVersionId: string;
  promptVersion: string;
  model: string;
  input: unknown;
  output: unknown;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  status: 'ok' | 'repaired' | 'invalid' | 'failed' | 'timeout';
}

/**
 * 记录每次模型调用：输入/输出快照存 R2，元数据落 D1。
 * 费用：pricePerMTokens 未配置 → cost_status='unknown'，不填零（PLAN 二.7）。
 */
export async function recordAiCall(env: Env, params: AiCallRecord): Promise<string> {
  const config = await loadAiConfig(env.DB, params.configVersionId);
  const price = config?.config[params.purpose].pricePerMTokens;
  const validTokens = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;
  const calculated = price && validTokens(params.promptTokens) && validTokens(params.completionTokens)
    ? (params.promptTokens * price[0] + params.completionTokens * price[1]) / 1_000_000 : null;
  const known = calculated !== null && Number.isFinite(calculated);
  const cost = known ? calculated : null;
  const reservation = params.jobId ? await env.DB.prepare("SELECT id FROM usage_reservations WHERE job_id = ?1 AND status = 'reserved' ORDER BY created_at DESC LIMIT 1").bind(params.jobId).first<{ id: string }>() : null;
  const id = newId();
  const inputKey = `ai-calls/${id}/input.json`;
  const outputKey = `ai-calls/${id}/output.json`;
  await env.FILES.put(inputKey, JSON.stringify(params.input ?? null));
  await env.FILES.put(outputKey, JSON.stringify(params.output ?? null));
  await env.DB.prepare(
    `INSERT INTO ai_calls (
       id, project_id, job_id, run_id, purpose, config_version_id, prompt_version, model,
       input_r2_key, output_r2_key, prompt_tokens, completion_tokens, cost_usd, cost_status,
       status, latency_ms, created_at, reservation_id
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
  )
    .bind(
      id,
      params.projectId ?? null,
      params.jobId ?? null,
      params.runId ?? null,
      params.purpose,
      params.configVersionId,
      params.promptVersion,
      params.model,
      inputKey,
      outputKey,
      validTokens(params.promptTokens) ? params.promptTokens : null,
      validTokens(params.completionTokens) ? params.completionTokens : null,
      cost,
      known ? 'known' : 'unknown',
      params.status,
      Math.round(params.latencyMs),
      nowIso(),
      reservation?.id ?? null,
    )
    .run();
  return id;
}
