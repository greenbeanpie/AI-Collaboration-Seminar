import type { Env } from '../env';
import { nowIso, newId } from '../core/db';
import { loadAiConfig, type AiPurpose } from './config';
import { recordAiDiagnostic } from './diagnostics';
import type { ApiProtocol } from '../../../shared/ai-providers';
import { tokenCount } from './usage';

export interface AiContextMetadata {
  protocol: ApiProtocol;
  step?: number;
  stage: number;
  compactionCount: number;
  baseHash: string;
  baseChars: number;
  inputHash: string;
  inputChars: number;
  repeatedReads?: number;
}

export interface AiCallRecord {
  diagnosticRequestId?: string;
  projectId?: string | null;
  draftId?: string;
  searchUsage?: unknown;
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
  cachedTokens?: number | null;
  cacheMissTokens?: number | null;
  contextMetadata?: AiContextMetadata | null;
  latencyMs: number;
  status: 'ok' | 'repaired' | 'invalid' | 'failed' | 'timeout';
}

/** 记录模型调用、输入/输出快照、token 用量和执行状态。 */
export async function recordAiCall(env: Env, params: AiCallRecord): Promise<string> {
  const config = await loadAiConfig(env.DB, params.configVersionId);
  const validTokens = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;
  const reservation = params.jobId ? await env.DB.prepare("SELECT id FROM usage_reservations WHERE job_id = ?1 AND status = 'reserved' ORDER BY created_at DESC LIMIT 1").bind(params.jobId).first<{ id: string }>() : null;
  const id = newId();
  await recordAiDiagnostic(env, {
    requestId: params.diagnosticRequestId ?? params.jobId ?? params.runId ?? id,
    operation: 'model_call', phase: 'model_result', purpose: params.purpose,
    status: params.status === 'ok' || params.status === 'repaired' ? 'succeeded' : 'failed',
    durationMs: Math.max(0, Math.min(3_600_000, Math.round(params.latencyMs))),
    errorCode: params.status === 'ok' || params.status === 'repaired' ? 'NONE' : params.status === 'timeout' ? 'TIMEOUT' : params.status === 'invalid' ? 'AI_OUTPUT_INVALID' : 'PROVIDER_FAILED',
    ...(config ? { configVersion: config.version } : {}),
  });
  const inputKey = `ai-calls/${id}/input.json`;
  const outputKey = `ai-calls/${id}/output.json`;
  await env.FILES.put(inputKey, JSON.stringify(params.input ?? null));
  await env.FILES.put(outputKey, JSON.stringify(params.output ?? null));
  await env.DB.prepare(
    `INSERT INTO ai_calls (
       id, project_id, job_id, run_id, purpose, config_version_id, prompt_version, model,
       input_r2_key, output_r2_key, prompt_tokens, completion_tokens,
       status, latency_ms, created_at, reservation_id, draft_id, search_usage_json,
       cached_tokens, cache_miss_tokens, context_metadata_json
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
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
      params.status,
      Math.round(params.latencyMs),
      nowIso(),
      reservation?.id ?? null,
      params.draftId ?? null,
      params.searchUsage ? JSON.stringify(params.searchUsage) : null,
      tokenCount(params.cachedTokens),
      tokenCount(params.cacheMissTokens),
      params.contextMetadata ? serializeContextMetadata(params.contextMetadata) : null,
    )
    .run();
  return id;
}

/** Only bounded counters and hashes enter searchable call metadata. */
function serializeContextMetadata(value: AiContextMetadata): string | null {
  if (!['chat-completions', 'responses', 'messages', 'gemini'].includes(value.protocol)
    || !/^[a-f0-9]{64}$/.test(value.baseHash) || !/^[a-f0-9]{64}$/.test(value.inputHash)
    || [value.stage, value.compactionCount, value.baseChars, value.inputChars].some(n => tokenCount(n) === null)
    || (value.step !== undefined && tokenCount(value.step) === null)
    || (value.repeatedReads !== undefined && tokenCount(value.repeatedReads) === null)) return null;
  return JSON.stringify({ protocol: value.protocol, step: value.step, stage: value.stage, compactionCount: value.compactionCount,
    baseHash: value.baseHash, baseChars: value.baseChars, inputHash: value.inputHash, inputChars: value.inputChars,
    ...(value.repeatedReads === undefined ? {} : { repeatedReads: value.repeatedReads }) });
}
