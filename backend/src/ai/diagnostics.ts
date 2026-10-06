import { z } from 'zod';
import type { Env } from '../env';
import { AppError } from '../core/errors';

export const MAX_DIAGNOSTIC_ENTRIES = 1000;
export const MAX_DIAGNOSTIC_BYTES = 1_000_000;
const fixedCodes = ['NONE', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'VALIDATION_FAILED', 'VERSION_CONFLICT', 'INVALID_STATE', 'AI_UNAVAILABLE', 'AI_OUTPUT_INVALID', 'QUOTA_EXCEEDED', 'TIMEOUT', 'PROBE_FAILED', 'PROVIDER_FAILED', 'REDIRECT_BLOCKED', 'FETCH_FAILED', 'INTERNAL'] as const;
const targetHosts = ['api.deepseek.com', 'api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'openrouter.ai', 'opencode.ai', 'api.cloudflare.com', 'custom-host-redacted'] as const;
const targetPaths = ['/chat/completions', '/v1/chat/completions', '/responses', '/v1/responses', '/messages', '/v1/messages', '/api/v1/chat/completions', '/zen/v1/chat/completions', '/zen/v1/responses', '/zen/v1/messages', '/zen/go/v1/chat/completions', '/zen/go/v1/responses', '/zen/go/v1/messages', '/v1beta/models/{model}:generateContent', '/client/v4/accounts/{account}/ai/v1/chat/completions', 'root-without-operation', 'duplicate-operation-suffix', 'custom-path-redacted'] as const;
export const diagnosticEntrySchema = z.object({
  timestamp: z.string().datetime(),
  requestId: z.string().uuid(),
  operation: z.enum(['config_read', 'config_save', 'config_disable', 'probe', 'model_call']),
  phase: z.enum(['request_started', 'request_finished', 'snapshot_loaded', 'config_persisted', 'probe_result', 'model_result', 'fetch_received', 'fetch_failed']),
  status: z.enum(['started', 'succeeded', 'failed']),
  durationMs: z.number().int().min(0).max(3_600_000),
  errorCode: z.enum(fixedCodes),
  errorReason: z.string().max(240).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  configVersion: z.number().int().nonnegative().optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
  purpose: z.enum(['textEconomy', 'visionEconomy', 'review']).optional(),
  method: z.enum(['GET', 'PUT', 'POST']).optional(),
  redirectMode: z.literal('manual').optional(),
  finalHost: z.enum(targetHosts).optional(),
  finalPath: z.enum(targetPaths).optional(),
  redirectHost: z.enum(targetHosts).optional(),
  redirectPath: z.enum(targetPaths).optional(),
  protocol: z.enum(['chat-completions', 'responses', 'messages', 'gemini']).optional(),
  failureKind: z.enum(['timeout', 'dns', 'tls', 'connection', 'redirect', 'request_encoding', 'fetch_rejected', 'network_unknown']).optional(),
  exceptionType: z.enum(['type_error', 'abort_error', 'timeout_error', 'error', 'unknown']).optional(),
});
export type DiagnosticEntry = z.infer<typeof diagnosticEntrySchema>;
export type DiagnosticInput = Omit<DiagnosticEntry, 'timestamp' | 'requestId'> & { requestId?: string | null };

/** Only public, fixed provider targets are visible; custom URLs and dynamic path
 * values can contain credentials, so those are represented by fixed labels. */
export function safeDiagnosticTarget(rawUrl: string): Pick<DiagnosticEntry, 'finalHost' | 'finalPath'> {
  try {
    const url = new URL(rawUrl);
    const host = (targetHosts as readonly string[]).includes(url.hostname) ? url.hostname as DiagnosticEntry['finalHost'] : 'custom-host-redacted';
    let path: DiagnosticEntry['finalPath'] = 'custom-path-redacted';
    if (host !== 'custom-host-redacted' && !url.search && !url.hash && !url.username && !url.password) {
      if ((targetPaths as readonly string[]).includes(url.pathname)) path = url.pathname as DiagnosticEntry['finalPath'];
      else if (url.pathname === '/' || /^\/v\d+\/?$/.test(url.pathname)) path = 'root-without-operation';
      else if (/\/(?:chat\/completions|responses|messages)\/(?:chat\/completions|responses|messages)\/?$/.test(url.pathname)) path = 'duplicate-operation-suffix';
      else if (host === 'generativelanguage.googleapis.com' && /^\/v1beta\/models\/[^/]+:generateContent$/.test(url.pathname)) path = '/v1beta/models/{model}:generateContent';
      else if (host === 'api.cloudflare.com' && /^\/client\/v4\/accounts\/[^/]+\/ai\/v1\/chat\/completions$/.test(url.pathname)) path = '/client/v4/accounts/{account}/ai/v1/chat/completions';
    }
    return { finalHost: host, finalPath: path };
  } catch { return { finalHost: 'custom-host-redacted', finalPath: 'custom-path-redacted' }; }
}

export function classifyFetchFailure(error: unknown, timedOut: boolean): Pick<DiagnosticEntry, 'failureKind' | 'exceptionType'> {
  const exceptionType = error instanceof TypeError ? 'type_error' : error instanceof Error && error.name === 'AbortError' ? 'abort_error' : error instanceof Error && error.name === 'TimeoutError' ? 'timeout_error' : error instanceof Error ? 'error' : 'unknown';
  if (timedOut || exceptionType === 'timeout_error') return { failureKind: 'timeout', exceptionType };
  const cause = error instanceof Error && error.cause && typeof error.cause === 'object' ? error.cause as { code?: unknown } : undefined;
  const direct = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const code = typeof cause?.code === 'string' ? cause.code : typeof direct === 'string' ? direct : '';
  // Read only bounded exception text for classification, never store or return it.
  const text = error instanceof Error ? error.message.slice(0, 2048) : '';
  const failureKind = /^(?:ENOTFOUND|EAI_AGAIN|EAI_FAIL)$/.test(code) || /\b(?:DNS|ENOTFOUND|EAI_AGAIN)\b/i.test(text) ? 'dns'
    : /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_VERIFY_|DEPTH_ZERO_)/.test(code) || /\b(?:TLS|SSL|certificate)\b/i.test(text) ? 'tls'
    : /^(?:ERR_TOO_MANY_REDIRECTS|UND_ERR_REDIRECT)$/.test(code) || /\bredirect(?:ed|ion|s)?\b/i.test(text) ? 'redirect'
    : /^(?:ERR_INVALID_CHAR|ERR_INVALID_HTTP_TOKEN)$/.test(code) || /\bByteString\b|invalid (?:HTTP )?header|header value/i.test(text) ? 'request_encoding'
    : /^(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(code) ? 'connection'
    : /\b(?:blocked|disallowed|forbidden)\b/i.test(text) ? 'fetch_rejected' : 'network_unknown';
  return { failureKind, exceptionType };
}

export function diagnosticErrorCode(error: unknown): DiagnosticEntry['errorCode'] {
  if (error instanceof AppError && (fixedCodes as readonly string[]).includes(error.code)) return error.code as DiagnosticEntry['errorCode'];
  return error instanceof Error && error.name === 'AbortError' ? 'TIMEOUT' : 'INTERNAL';
}

/** Keep a provider's explicit error explanation while dropping credentials and oversized echoes. */
export function safeProviderErrorReason(payload: unknown, credential?: string): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const root = payload as Record<string, unknown>;
  const error = root.error && typeof root.error === 'object' ? root.error as Record<string, unknown> : root;
  const code = [error.code, error.type].find((value): value is string => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value));
  const message = typeof root.error === 'string' ? root.error : typeof error.message === 'string' ? error.message : typeof error.detail === 'string' ? error.detail : undefined;
  if (!code && !message) return undefined;
  let reason = [code, message].filter(Boolean).join(': ').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (credential) reason = reason.split(credential).join('[已隐藏凭据]');
  reason = reason
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [已隐藏凭据]')
    .replace(/\b(api[_-]?key|authorization|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[已隐藏长标识]')
    .slice(0, 240);
  return reason || undefined;
}

export function safeBackendErrorReason(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return safeProviderErrorReason({ message: error.message })?.slice(0, 240);
}

export async function fetchAiProvider(
  env: Pick<Env, 'DB'> | undefined,
  requestId: string,
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
  protocol?: DiagnosticEntry['protocol'],
  credential?: string,
): Promise<Response> {
  const id = z.string().uuid().safeParse(requestId).success ? requestId : crypto.randomUUID();
  const target = safeDiagnosticTarget(url);
  const method = init.method?.toUpperCase();
  const safeMethod = method === 'GET' || method === 'PUT' || method === 'POST' ? method : undefined;
  const started = Date.now();
  let response: Response;
  try { response = await fetchImpl(url, init); }
  catch (error) {
    if (env) {
      const timeout = (init.signal instanceof AbortSignal && init.signal.aborted) || error instanceof Error && error.name === 'TimeoutError';
      await recordAiDiagnostic(env, { requestId: id, operation: 'model_call', phase: 'fetch_failed', status: 'failed', durationMs: Math.min(3_600_000, Date.now() - started), errorCode: timeout ? 'TIMEOUT' : 'FETCH_FAILED', errorReason: timeout ? '后端达到配置的供应商请求超时，未收到 HTTP 响应' : '后端网络请求失败，未收到供应商 HTTP 响应；请检查 DNS、TLS、出口网络和 API 地址', ...(safeMethod ? { method: safeMethod } : {}), ...(protocol ? { protocol } : {}), ...target, ...classifyFetchFailure(error, timeout) });
    }
    throw error;
  }
  if (env) {
    const errorReason = response.ok ? undefined : safeProviderErrorReason(await readBoundedProviderJson(response), credential) ?? `供应商返回 HTTP ${response.status}，但没有可读取的结构化错误原因`;
    await recordAiDiagnostic(env, { requestId: id, operation: 'model_call', phase: 'fetch_received', status: response.ok ? 'succeeded' : 'failed', durationMs: Math.min(3_600_000, Date.now() - started), errorCode: response.ok ? 'NONE' : 'PROVIDER_FAILED', ...(errorReason ? { errorReason } : {}), httpStatus: response.status, ...(safeMethod ? { method: safeMethod } : {}), ...(protocol ? { protocol } : {}), ...target });
  }
  return response;
}

async function readBoundedProviderJson(response: Response): Promise<unknown> {
  try {
    const reader = response.clone().body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 16 * 1024) { await reader.cancel(); return null; }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder().decode(bytes));
    } finally { reader.releaseLock(); }
  } catch { return null; }
}

// INSERT and both retention bounds are one serialized D1 transaction, including
// concurrent writers. Byte cost uses the complete UTF-8 JSON plus its separator.
const trimSql = `DELETE FROM ai_diagnostics WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS entry_rank,
      SUM(byte_size) OVER (ORDER BY id DESC ROWS UNBOUNDED PRECEDING) AS newest_bytes
    FROM ai_diagnostics
  ) WHERE entry_rank > ${MAX_DIAGNOSTIC_ENTRIES} OR newest_bytes > ${MAX_DIAGNOSTIC_BYTES - 512}
)`;

/** Best effort, bounded latency; a diagnostics failure never changes a business result. */
export async function recordAiDiagnostic(env: Pick<Env, 'DB'>, input: DiagnosticInput): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const uuid = z.string().uuid().safeParse(input.requestId);
    // Construct only fixed schema fields. Unknown properties are discarded by Zod;
    // IDs are opaque UUIDs, never an arbitrary header or user-supplied free text.
    const entry = diagnosticEntrySchema.parse({ ...input, requestId: uuid.success ? uuid.data : crypto.randomUUID(), timestamp: new Date().toISOString() });
    const json = JSON.stringify(entry);
    const bytes = new TextEncoder().encode(json).byteLength + 1;
    const write = env.DB.batch([
      env.DB.prepare('INSERT INTO ai_diagnostics(entry_json, byte_size) VALUES (?1, ?2)').bind(json, bytes),
      env.DB.prepare(trimSql),
    ]).then(() => true, () => false);
    return await Promise.race([write, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 250); })]);
  } catch { return false; }
  finally { if (timer) clearTimeout(timer); }
}

export async function readAiDiagnostics(env: Pick<Env, 'DB'>) {
  const rows = await env.DB.prepare('SELECT entry_json, byte_size FROM ai_diagnostics ORDER BY id DESC LIMIT 1000').all<{ entry_json: string; byte_size: number }>();
  const items: DiagnosticEntry[] = [];
  let retainedBytes = 0;
  for (const row of rows.results) {
    retainedBytes += row.byte_size;
    try { const safe = diagnosticEntrySchema.safeParse(JSON.parse(row.entry_json)); if (safe.success) items.push(safe.data); }
    catch { /* A malformed row must not expose raw stored content. */ }
  }
  return { items, retention: { maxEntries: MAX_DIAGNOSTIC_ENTRIES, maxBytes: MAX_DIAGNOSTIC_BYTES, retainedEntries: rows.results.length, retainedBytes } as const };
}
