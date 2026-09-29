import type { Env } from '../env';
import type { AiModelConfig } from './config';
import { AppError, aiUnavailable } from '../core/errors';

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
  maxOutputTokens?: number;
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
  if (!endpoint.apiToken || !endpoint.accountId || !endpoint.gatewayId) {
    throw aiUnavailable('AI Gateway 未配置（缺少 Account/Gateway/Token）');
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${endpoint.accountId}/ai/v1/chat/completions`;
  const body: Record<string, unknown> = {
    model: input.config.model,
    messages: input.messages,
    max_tokens: input.maxOutputTokens ?? input.config.maxOutputTokens,
  };
  if (typeof input.config.temperature === 'number') body.temperature = input.config.temperature;
  if (input.jsonMode && input.config.supportsJson) body.response_format = { type: 'json_object' };

  const started = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpoint.apiToken}`,
        'cf-aig-gateway-id': endpoint.gatewayId,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.config.timeoutMs),
    });
  } catch (err) {
    // 网络失败/超时：费用未知，由调用方保留待核对记录
    throw aiUnavailable('模型请求失败或超时', { cause: err instanceof Error ? err.message : String(err) });
  }
  const latencyMs = Date.now() - started;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status >= 500;
    throw new AppError('AI_UNAVAILABLE', `模型服务返回 ${res.status}`, retryable ? 503 : 502, retryable, {
      status: res.status,
      body: text.slice(0, 500),
    });
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new AppError('AI_OUTPUT_INVALID', '模型响应缺少内容', 502, false);
  }
  return {
    content,
    promptTokens: data.usage?.prompt_tokens ?? null,
    completionTokens: data.usage?.completion_tokens ?? null,
    latencyMs,
  };
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
