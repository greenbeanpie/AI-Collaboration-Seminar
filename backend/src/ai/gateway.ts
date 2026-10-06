import { MULTIMODAL_LIMITS } from './multimodal-limits';
import { feedbackForJob } from '../services/project-feedback';
import { applyToolMode, normalizeToolResponse, toolResponseShape, type ToolMode, type ToolOutput } from './tool-transport';
import type { AiModelConfig } from './config';
import { AppError, aiUnavailable } from '../core/errors';
import { GO_DEFAULT_USER_AGENT, protocolForConfig, providerOptionErrors } from '../../../shared/ai-providers';
import { buildProviderRequest, normalizeProviderResponse } from './transport';
import { classifyFetchFailure, diagnosticErrorCode, recordAiDiagnostic, safeBackendErrorReason, safeDiagnosticTarget, safeProviderErrorReason } from './diagnostics';
import type { Env } from '../env';
import { LIMITS } from '../core/limits';
import { unseal } from './secrets';

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

export interface GatewayCallInput {
  projectId?: string;
  jobId?: string;
  /** Durable recovery state when a Workflow continues in another instance. */
  providerRetry?: ProviderRetryState;
  onProviderRetry?: (state: ProviderRetryState) => Promise<void>;
  toolMode?: ToolMode;
  config: AiModelConfig;
  messages: ChatMessage[];
  /** 需要 JSON 输出时置 true；模型不支持结构化约束时由调用方改用 JSON 提示 + Zod 校验 */
  jsonMode?: boolean;
  privateContext?: boolean;
  beforeFetch?: () => Promise<void>;
  /** Resolve sensitive context after all config/key/reservation I/O; no awaited work may follow before fetch. */
  prepareMessages?: () => Promise<ChatMessage[]>;
  /** Synchronous accounting marker only; must not start or await I/O. */
  onDispatch?: () => void;
  /** Stable opaque job/conversation ID; used only by the opt-in Go adapter. */
  sessionId?: string;
  /** HTTP request ID for probes; background calls use their opaque session ID. */
  diagnosticRequestId?: string;
}

export interface ProviderRetryState { attempt: number; deadline: number; nextAttemptAt: number }

export interface GatewayCallOutput {
  toolOutput?: ToolOutput;
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
  diagnostics?: Pick<Env, 'DB'>;
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
 * 明确的临时 HTTP 错误最多额外重试三次；不重放受理状态未知的请求。
 * fetchImpl 参数供测试注入 mock。
 */
export async function gatewayChat(
  endpoint: GatewayEndpoint,
  input: GatewayCallInput,
  fetchImpl: typeof fetch = fetch,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<GatewayCallOutput> {
  if(input.projectId && endpoint.diagnostics){
    const feedback=await feedbackForJob(endpoint.diagnostics,input.projectId,input.jobId);
    const append=(messages:ChatMessage[]):ChatMessage[]=>feedback.feedback ? [...messages,{role:'user',content:JSON.stringify({contextType:'持续项目反馈',version:feedback.version,versionId:feedback.versionId,feedback:feedback.feedback,rule:'在系统规则、权限、审批和证据要求范围内，将这些项目反馈作为后续判断的持续上下文。'})}] : messages;
    const prepare=input.prepareMessages;
    input={...input,messages:append(input.messages),...(prepare?{prepareMessages:async()=>append(await prepare())}:{})};
  }
  if (input.config.providerPreset === 'opencode-go') {
    const sessionId = input.sessionId ?? input.jobId ?? crypto.randomUUID();
    input = { ...input, sessionId: requireOpenCodeGoSessionId(sessionId) };
  }
  const started = Date.now();
  let recoveryDeadline = input.providerRetry?.deadline;
  if (input.providerRetry && input.providerRetry.nextAttemptAt > Date.now()) await wait(input.providerRetry.nextAttemptAt - Date.now());
  for (let attempt = input.providerRetry?.attempt ?? 0; ; attempt++) {
    try {
      const remaining = recoveryDeadline === undefined ? input.config.timeoutMs : Math.min(input.config.timeoutMs, recoveryDeadline - Date.now());
      if (remaining <= 0) throw new AppError('AI_UNAVAILABLE', '模型服务在一分钟恢复窗口内未恢复', 503, false);
      const output = await gatewayChatAttempt(endpoint, {
        ...input, config: { ...input.config, timeoutMs: remaining },
      }, fetchImpl, recoveryDeadline);
      return { ...output, latencyMs: Date.now() - started };
    } catch (error) {
      if (endpoint.diagnostics) {
        const appError = error instanceof AppError ? error : undefined;
        const providerReason = appError?.details?.providerReason;
        await recordAiDiagnostic(endpoint.diagnostics, {
          requestId: input.diagnosticRequestId ?? input.sessionId, operation: 'model_call', phase: 'model_result', status: 'failed',
          durationMs: Math.min(3_600_000, Date.now() - started), errorCode: diagnosticErrorCode(error),
          errorReason: typeof providerReason === 'string' ? providerReason.slice(0, 240) : safeBackendErrorReason(appError) ?? '后端模型调用失败，未能提取明确错误说明',
          ...(typeof appError?.details?.status === 'number' && appError.details.status >= 100 && appError.details.status <= 599 ? { httpStatus: appError.details.status } : {}),
        });
      }
      // Only a received HTTP response proves this is a provider rejection.
      // Network/timeouts, parser errors and quota/permission guards are never replayed.
      const status = error instanceof AppError ? error.details?.status : undefined;
      if (!(error instanceof AppError) || error.code !== 'AI_UNAVAILABLE' || !error.retryable ||
          ![429, 500, 502, 503, 504].includes(status as number) || attempt >= LIMITS.aiCallExtraRetries) throw error;
      recoveryDeadline ??= Date.now() + 60_000;
      const delay = [1000, 5000, 15000][attempt]!;
      if (Date.now() + delay >= recoveryDeadline) throw error;
      await input.onProviderRetry?.({ attempt: attempt + 1, deadline: recoveryDeadline, nextAttemptAt: Date.now() + delay });
      await wait(delay);
      // The next attempt repeats beforeFetch and prepareMessages, including reservation,
      // config, permissions and freshly authorized sensitive context.
    }
  }
}

function requireOpenCodeGoSessionId(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) {
    throw new AppError('AI_UNAVAILABLE', 'OpenCode Go 缺少有效的稳定会话标识', 503, false);
  }
  return value;
}

async function gatewayChatAttempt(
  endpoint: GatewayEndpoint,
  input: GatewayCallInput,
  fetchImpl: typeof fetch,
  recoveryDeadline?: number,
): Promise<GatewayCallOutput> {
  if (!input.config.supportsVision && input.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))) {
    throw new AppError('AI_UNAVAILABLE', '当前模型不支持图像；不会回落到其他端点', 503, false);
  }
  const optionErrors = providerOptionErrors(input.config);
  if (optionErrors.length) throw new AppError('AI_UNAVAILABLE', optionErrors.join('；'), 503, false);
  const workersAi = input.config.provider === 'workers-ai';
  if (workersAi && (!endpoint.apiToken || !endpoint.accountId || !endpoint.gatewayId)) {
    throw aiUnavailable('AI Gateway 未配置（缺少 Account/Gateway/Token）');
  }
  const url = workersAi ? `https://api.cloudflare.com/client/v4/accounts/${endpoint.accountId}/ai/v1/chat/completions` : input.config.apiUrl;
  if (!workersAi && (!url || !input.config.apiKeyEncrypted || !isAllowedModelEndpoint(url, endpoint.envName))) {
    throw aiUnavailable('请填写公开 HTTPS API URL、供应商 API key 和模型名称');
  }
  let token = endpoint.apiToken;
  if (!workersAi) {
    try { token = await unseal(input.config.apiKeyEncrypted!, endpoint.authSecret ?? ''); }
    catch { throw new AppError('AI_UNAVAILABLE', '模型密钥解密失败，请重新配置', 503, false); }
    if (!token || /[\x00-\x1f\x7f]/.test(token)) throw new AppError('AI_UNAVAILABLE', '模型密钥含无效控制字符，请重新配置', 503, false);
  }
  const textChars = input.messages.reduce((total, message) => total + (typeof message.content === 'string' ? message.content.length : message.content.reduce((n, part) => n + (part.type === 'text' ? part.text.length : 0), 0)), 0);
  if (textChars > input.config.maxInputChars || input.messages.length > 32) {
    throw new AppError('QUOTA_EXCEEDED', '模型输入（含完整持续项目反馈）超过已预占的文本上限，请缩短反馈或提高输入上限', 429, false);
  }
  const started = Date.now();
  let res: Response;
  await input.beforeFetch?.();
  const messages = input.prepareMessages ? await input.prepareMessages() : input.messages;
  const dispatchChars = messages.reduce((total, message) => total + (typeof message.content === 'string' ? message.content.length : message.content.reduce((n, part) => n + (part.type === 'text' ? part.text.length : 0), 0)), 0);
  if (dispatchChars > input.config.maxInputChars || messages.length > 32) {
    throw new AppError('QUOTA_EXCEEDED', '模型输入（含完整持续项目反馈）超过已预占的文本上限，请缩短反馈或提高输入上限', 429, false);
  }
  // Everything from this point to fetch is synchronous: never add config/key/reservation reads here.
  const { protocol, headers, body } = buildProviderRequest(input.config, messages, token, Boolean(input.jsonMode));
  if (input.toolMode) applyToolMode(input.config, protocol, body, input.toolMode);
  const serializedBody = JSON.stringify(body);
  const images = messages.flatMap(message => typeof message.content === 'string' ? [] : message.content.filter(part => part.type === 'image_url'));
  if (images.length && !input.config.supportsVision) throw new AppError('AI_UNAVAILABLE','当前模型不支持图像；不会回落到其他端点',503,false);
  if (images.length > MULTIMODAL_LIMITS.images) throw new AppError('QUOTA_EXCEEDED', '单次视觉请求最多包含3张图片', 422, false);
  let encodedImages = 0;
  for (const image of images) {
    if (image.type !== 'image_url') continue;
    const url = image.image_url.url;
    if (url.startsWith('data:')) {
      const match = /^data:[^;,]+;base64,([A-Za-z0-9+/]*={0,2})$/u.exec(url);
      if (!match || match[1]!.length % 4 !== 0) throw new AppError('VALIDATION_FAILED', '页面图片不是有效的base64数据URL', 422, false);
      const base64 = match[1]!;
      const bytes = base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
      if (bytes > MULTIMODAL_LIMITS.imageBytes) throw new AppError('QUOTA_EXCEEDED', '单张视觉图片超过2 MiB处理边界', 422, false);
      encodedImages += base64.length;
    }
  }
  if (encodedImages > MULTIMODAL_LIMITS.imagePayloadBytes || serializedBody.length - encodedImages > input.config.maxInputChars * 6 + 32000) throw new AppError('QUOTA_EXCEEDED', '工具或文字上下文超过当前模型输入限制', 429, false);
  if (images.length && new TextEncoder().encode(serializedBody).length > MULTIMODAL_LIMITS.requestBytes) throw new AppError('QUOTA_EXCEEDED', '视觉请求超过9 MiB传输边界', 422, false);
  if (input.config.providerPreset === 'opencode-go') {
    const sessionId = requireOpenCodeGoSessionId(input.sessionId);
    headers['user-agent'] = input.config.goHeaders?.userAgent ?? GO_DEFAULT_USER_AGENT;
    headers['x-opencode-session'] = input.config.goHeaders?.sessionPrefix ? `${input.config.goHeaders.sessionPrefix}:${sessionId}` : sessionId;
  }
  if (workersAi) headers['cf-aig-gateway-id'] = endpoint.gatewayId;
  if (workersAi && input.privateContext) {
    headers['cf-aig-skip-cache'] = 'true';
    headers['cf-aig-collect-log'] = 'false';
  }

  const liveTimeout = recoveryDeadline === undefined ? input.config.timeoutMs : Math.min(input.config.timeoutMs, recoveryDeadline - Date.now());
  if (liveTimeout <= 0) throw new AppError('AI_UNAVAILABLE', '模型服务在一分钟恢复窗口内未恢复', 503, false);
  const timeoutSignal = AbortSignal.timeout(liveTimeout);
  try {
    input.onDispatch?.();
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: serializedBody,
      signal: timeoutSignal,
      // Inspect a redirect response, but never follow it or forward credentials.
      redirect: 'manual',
    });
  } catch (err) {
    // 网络失败/超时：结果未知，由调用方保留尝试状态并避免自动重放。
    const timeout = timeoutSignal.aborted || (err instanceof Error && err.name === 'TimeoutError');
    const classification = classifyFetchFailure(err, timeout);
    if (endpoint.diagnostics) await recordAiDiagnostic(endpoint.diagnostics, { requestId: input.diagnosticRequestId ?? input.sessionId, operation: 'model_call', phase: 'fetch_failed', status: 'failed', durationMs: Math.min(3_600_000, Date.now() - started), errorCode: timeout ? 'TIMEOUT' : 'FETCH_FAILED', errorReason: timeout ? `请求超过 ${Math.ceil(liveTimeout / 1000)} 秒仍未收到响应` : '网络层未收到供应商 HTTP 响应；请检查 DNS、TLS、出口网络和 API 地址', protocol, method: 'POST', redirectMode: 'manual', ...safeDiagnosticTarget(url), ...classification });
    throw aiUnavailable(timeout
      ? `模型请求超时（${input.config.timeoutMs / 1000} 秒）；尚未收到 HTTP 响应，请检查超时设置及供应商服务状态`
      : '模型网络请求失败，尚未收到 HTTP 响应；请检查 API 地址、重定向和供应商服务可达性', {
      timeout,
      timeoutMs: input.config.timeoutMs,
      cause: timeout ? 'timeout' : 'network_error',
      ...classification,
      ...safeDiagnosticTarget(url),
    });
  }
  const latencyMs = Date.now() - started;

  const redirect = res.status >= 300 && res.status < 400;
  let redirected: { redirectHost?: ReturnType<typeof safeDiagnosticTarget>['finalHost']; redirectPath?: ReturnType<typeof safeDiagnosticTarget>['finalPath'] } = {};
  if (redirect) {
    try { const target = safeDiagnosticTarget(new URL(res.headers.get('location') ?? '', url).href); redirected = { redirectHost: target.finalHost, redirectPath: target.finalPath }; } catch { /* Never retain an untrusted Location header. */ }
  }
  if (redirect) {
    if (endpoint.diagnostics) await recordAiDiagnostic(endpoint.diagnostics, { requestId: input.diagnosticRequestId ?? input.sessionId, operation: 'model_call', phase: 'fetch_received', status: 'failed', durationMs: Math.min(3_600_000, latencyMs), errorCode: 'REDIRECT_BLOCKED', errorReason: `供应商返回 HTTP ${res.status} 重定向；为避免转发凭据，后端未跟随跳转`, httpStatus: res.status, protocol, method: 'POST', redirectMode: 'manual', ...safeDiagnosticTarget(url), ...redirected, failureKind: 'redirect' });
    await res.body?.cancel();
    throw new AppError('AI_UNAVAILABLE', `模型地址返回重定向（HTTP ${res.status}）；未跟随跳转或转发密钥，请核对完整 API 地址`, 502, false, { status: res.status, failureKind: 'redirect', ...safeDiagnosticTarget(url), ...redirected });
  }

  if (!res.ok) {
    const errorBody = await readProviderErrorBody(res);
    await res.body?.cancel();
    const providerReason = safeProviderErrorReason(errorBody, token);
    const multipleImagesRejected = [400, 422].includes(res.status) && /(?:only|maximum|max(?:imum)?|at most)\s+(?:one|1)\s+image|multiple\s+images?\s+(?:(?:are|is)\s+)?(?:not\s+supported|unsupported)|不支持多(?:张|个)图|最多.{0,3}(?:1|一)张/u.test(JSON.stringify(errorBody).toLowerCase());
    const retryable = res.status === 429 || res.status >= 500;
    if (endpoint.diagnostics) await recordAiDiagnostic(endpoint.diagnostics, { requestId: input.diagnosticRequestId ?? input.sessionId, operation: 'model_call', phase: 'fetch_received', status: 'failed', durationMs: Math.min(3_600_000, latencyMs), errorCode: 'PROVIDER_FAILED', errorReason: providerReason ?? `供应商返回 HTTP ${res.status}，但响应中没有可读取的结构化错误原因`, httpStatus: res.status, protocol, method: 'POST', redirectMode: 'manual', ...safeDiagnosticTarget(url) });
    throw new AppError('AI_UNAVAILABLE', `模型服务返回 ${res.status}`, retryable ? 503 : 502, retryable, {
      status: res.status,
      ...(providerReason ? { providerReason } : {}),
      ...(multipleImagesRejected ? { multipleImagesRejected: true } : {}),
    });
  }

  if (endpoint.diagnostics) await recordAiDiagnostic(endpoint.diagnostics, { requestId: input.diagnosticRequestId ?? input.sessionId, operation: 'model_call', phase: 'fetch_received', status: 'succeeded', durationMs: Math.min(3_600_000, latencyMs), errorCode: 'NONE', httpStatus: res.status, protocol, method: 'POST', redirectMode: 'manual', ...safeDiagnosticTarget(url) });

  let data: unknown;
  try { data = await readProviderJson(res); }
  catch (error) {
    if (endpoint.diagnostics) await recordAiDiagnostic(endpoint.diagnostics, { requestId: input.diagnosticRequestId ?? input.sessionId, operation: 'model_call', phase: 'model_result', status: 'failed', durationMs: Math.min(3_600_000, Date.now() - started), errorCode: 'AI_OUTPUT_INVALID', errorReason: '模型响应 JSON 解析失败；未记录响应正文或解析异常片段', httpStatus: res.status, protocol, method: 'POST', redirectMode: 'manual', ...safeDiagnosticTarget(url) });
    throw error;
  }
  if(input.toolMode) {
    try {const output=normalizeToolResponse(protocol,data,input.toolMode.nativeSearch);return {...output,toolOutput:output,latencyMs};}
    catch {throw new AppError('AI_OUTPUT_INVALID','模型工具响应未通过校验：'+JSON.stringify(toolResponseShape(data)),502,false);}
  }
  return { ...normalizeProviderResponse(protocol, data), latencyMs };
}

async function readProviderErrorBody(response: Response): Promise<unknown> {
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
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder().decode(bytes));
    } finally { reader.releaseLock(); }
  } catch { return null; }
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
