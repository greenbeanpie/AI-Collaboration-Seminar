import { unseal } from './secrets';
import type { AiModelConfig } from './config';
import { AppError, aiUnavailable } from '../core/errors';
import { providerOptionErrors } from '../../../shared/ai-providers';
import { buildProviderRequest, normalizeProviderResponse } from './transport';

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

export interface GatewayCallInput {
  config: AiModelConfig;
  messages: ChatMessage[];
  /** 需要 JSON 输出时置 true；模型不支持结构化约束时由调用方改用 JSON 提示 + Zod 校验 */
  jsonMode?: boolean;
  privateContext?: boolean;
  maxOutputTokens?: number;
  beforeFetch?: () => Promise<void>;
  /** Stable opaque job/conversation ID; used only by the opt-in Go adapter. */
  sessionId?: string;
}

export interface GatewayCallOutput {
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
}

export interface GatewayEndpoint {
  accountId: string;
  apiToken: string;
  gatewayId: string;
  authSecret?: string;
  /** 当前环境；仅 local 允许回环模型地址，用于零费用本地联调 */
  envName?: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 自定义模型端点地址策略：
 * - 云端（staging/production）：只允许公网 HTTPS，禁止用户信息、查询参数、内网/本机地址。
 * - ENV_NAME=local：额外允许 http/https 回环地址，便于用本地 stub 模型做零费用端到端验证。
 */
export function isAllowedModelEndpoint(raw: string, envName?: string): boolean {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return false;
  }
  if (target.username || target.password || target.search || target.hash) return false;
  const hostname = target.hostname.toLowerCase().replace(/\.$/, '');
  if (envName === 'local' && LOOPBACK_HOSTS.has(hostname) && (target.protocol === 'http:' || target.protocol === 'https:')) {
    return true;
  }
  return (
    target.protocol === 'https:' &&
    !target.username &&
    !target.password &&
    !target.search &&
    !target.hash &&
    !hostname.includes(':') &&
    !/^([0-9.]+|localhost|.*\.localhost|.*\.local|.*\.internal)$/.test(hostname)
  );
}

/**
 * Cloudflare AI Gateway 统一入口（PLAN 二.5）：
 * POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions
 * Header: Authorization Bearer + cf-aig-gateway-id。不使用已弃用的 /compat 入口。
 *
 * 每次调用只尝试一次；是否额外重试由上层统一决定（LIMITS.aiCallExtraRetries）。
 * fetchImpl 参数供测试注入 mock。
 */
export async function gatewayChat(
  endpoint: GatewayEndpoint,
  input: GatewayCallInput,
  fetchImpl: typeof fetch = fetch,
): Promise<GatewayCallOutput> {
  const optionErrors = providerOptionErrors(input.config);
  if (optionErrors.length) throw new AppError('AI_UNAVAILABLE', optionErrors.join('；'), 503, false);
  const custom = input.config.provider !== 'workers-ai';
  if (!custom && (!endpoint.apiToken || !endpoint.accountId || !endpoint.gatewayId)) {
    throw aiUnavailable('AI Gateway 未配置（缺少 Account/Gateway/Token）');
  }
  const url = custom ? input.config.apiUrl : `https://api.cloudflare.com/client/v4/accounts/${endpoint.accountId}/ai/v1/chat/completions`;
  let token = endpoint.apiToken;
  if (custom) {
    if (!url || !input.config.apiKeyEncrypted || !input.config.model) throw aiUnavailable('请填写 API URL、key 和模型名称');
    if (!isAllowedModelEndpoint(url, endpoint.envName)) throw aiUnavailable('模型 API 必须使用公开 HTTPS 域名且不能包含查询参数');
    try { token = await unseal(input.config.apiKeyEncrypted, endpoint.authSecret ?? ''); }
    catch { throw new AppError('AI_UNAVAILABLE', '模型密钥解密失败，请重新配置', 503, false); }
    if (/[\x00-\x1f\x7f]/.test(token)) throw new AppError('AI_UNAVAILABLE', '模型密钥含无效控制字符，请重新配置', 503, false);
  }
  const textChars = input.messages.reduce((total, message) => total + (typeof message.content === 'string' ? message.content.length : message.content.reduce((n, part) => n + (part.type === 'text' ? part.text.length : 0), 0)), 0);
  if (textChars > input.config.maxInputChars || input.messages.length > 32) {
    throw new AppError('QUOTA_EXCEEDED', '模型输入超过已预占的文本上限', 429, false);
  }
  if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > input.config.maxOutputTokens)) {
    throw new AppError('QUOTA_EXCEEDED', '模型输出上限超过已预占额度', 429, false);
  }
  const { protocol, headers, body } = buildProviderRequest(input.config, input.messages, token, Boolean(input.jsonMode), input.maxOutputTokens ?? input.config.maxOutputTokens, input.sessionId);
  if (!custom) headers['cf-aig-gateway-id'] = endpoint.gatewayId;
  if (input.privateContext) {
    headers['cf-aig-skip-cache'] = 'true';
    headers['cf-aig-collect-log'] = 'false';
  }

  const started = Date.now();
  let res: Response;
  await input.beforeFetch?.();
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.config.timeoutMs),
      redirect: 'error',
    });
  } catch (err) {
    // 网络失败/超时：费用未知，由调用方保留待核对记录
    throw aiUnavailable('模型请求失败或超时', {
      timeout: err instanceof Error && err.name === 'TimeoutError',
      cause: 'network_error',
    });
  }
  const latencyMs = Date.now() - started;

  if (!res.ok) {

    const retryable = res.status === 429 || res.status >= 500;
    throw new AppError('AI_UNAVAILABLE', `模型服务返回 ${res.status}`, retryable ? 503 : 502, retryable, {
      status: res.status,

    });
  }

  const data: unknown = await readProviderJson(res);
  return { ...normalizeProviderResponse(protocol, data), latencyMs };
}

/** 应用层统一的一次额外重试（仅对可重试错误） */
export async function withSingleRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError && err.retryable) {
      return await fn();
    }
    throw err;
  }
}

/** Bound provider payloads and never expose parser snippets from an untrusted response. */
async function readProviderJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new AppError('AI_OUTPUT_INVALID', '模型响应没有 JSON 内容', 502, false);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('too large'); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError('AI_OUTPUT_INVALID', '模型响应不是有效 JSON 或超出大小限制', 502, false);
  } finally { reader.releaseLock(); }
}
