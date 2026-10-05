import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env, BASE } from './helpers/env';
import { ADMIN_TOKEN } from './helpers/constants';
import { aiModelConfigSchema, loadAiConfig, type AiModelConfig } from '../src/ai/config';
import { seal } from '../src/ai/secrets';
import { gatewayChat } from '../src/ai/gateway';
import { normalizeProviderResponse } from '../src/ai/transport';
import { aiJsonCall } from '../src/services/agent';
import { probeModel } from '../src/ai/probe';
import { classifyFetchFailure, readAiDiagnostics, safeDiagnosticTarget } from '../src/ai/diagnostics';
import { reserveAiSlot } from '../src/services/ai-reservations';
import { seedProject, seedUser } from './helpers/seed';
import { FIXED_MAX_OUTPUT_TOKENS, presetEndpoint, protocolForConfig, providerPresets, sameCredentialDestination, type ProviderPreset, type ApiProtocol } from '../../shared/ai-providers';
import { z } from 'zod';

const endpoint = { accountId: 'account', apiToken: 'workers-key', gatewayId: 'gateway', authSecret: env.AUTH_SECRET, envName: 'local' };
const encrypted = await seal('fixture-provider-key', env.AUTH_SECRET);
function config(preset: ProviderPreset, model: string, extra: Partial<AiModelConfig> = {}): AiModelConfig {
  return aiModelConfigSchema.parse({ provider: 'openai-compatible', providerPreset: preset, model, apiUrl: presetEndpoint(preset, model, extra.apiProtocol), apiKeyEncrypted: encrypted, timeoutMs: 90000, maxInputChars: 48000, supportsJson: providerPresets[preset].supportsJson, supportsVision: true, goUsageAcknowledged: preset === 'opencode-go', ...extra });
}
function response(protocol: ApiProtocol) {
  if (protocol === 'responses') return { status: 'completed', output: [{ type: 'reasoning', summary: [{ text: 'not the answer' }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}' }] }], usage: { input_tokens: 9, output_tokens: 6, output_tokens_details: { reasoning_tokens: 4 } } };
  if (protocol === 'messages') return { content: [{ type: 'thinking', thinking: 'not the answer' }, { type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', usage: { input_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 4, output_tokens: 6 } };
  if (protocol === 'gemini') return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not the answer', thought: true }, { text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2, thoughtsTokenCount: 4, totalTokenCount: 15, cachedContentTokenCount: 4 } };
  return { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 9, completion_tokens: 6 } };
}
const messages = [{ role: 'system' as const, content: 'Only JSON' }, { role: 'user' as const, content: 'Reply JSON' }];
afterEach(() => vi.unstubAllGlobals());

it.each([
  ['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'], ['ECONNRESET', 'connection'], ['UND_ERR_REDIRECT', 'redirect'], ['fixture-secret-code', 'network_unknown'],
] as const)('safely classifies fetch cause %s as %s without storing exception strings', async (code, failureKind) => {
  const error = new TypeError('fetch failed with fixture-provider-key', { cause: { code, private: 'fixture-private-cause' } });
  expect(classifyFetchFailure(error, false)).toEqual({ failureKind, exceptionType: 'type_error' });
  const requestId = crypto.randomUUID();
  const mock = vi.fn(async () => { throw error; });
  await expect(gatewayChat({ ...endpoint, diagnostics: env }, { config: config('deepseek', 'deepseek-flash'), messages, diagnosticRequestId: requestId }, mock)).rejects.toMatchObject({ details: { failureKind, exceptionType: 'type_error', finalHost: 'api.deepseek.com', finalPath: '/chat/completions' } });
  const events = (await readAiDiagnostics(env)).items.filter(entry => entry.requestId === requestId);
  expect(events.find(entry => entry.phase === 'fetch_failed')).toMatchObject({ failureKind, errorCode: 'FETCH_FAILED', finalHost: 'api.deepseek.com', finalPath: '/chat/completions' });
  expect(JSON.stringify(events)).not.toMatch(/fixture-provider-key|fixture-private-cause|fixture-secret-code/);
  expect(mock).toHaveBeenCalledOnce();
});

it('a provider redirect is observed once and rejected without following or forwarding credentials', async () => {
  const requestId = crypto.randomUUID();
  const mock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe('manual');
    return new Response('', { status: 302, headers: { location: 'https://api.deepseek.com/v1/chat/completions?key=fixture-provider-key' } });
  });
  await expect(gatewayChat({ ...endpoint, diagnostics: env }, { config: config('deepseek', 'deepseek-flash'), messages, diagnosticRequestId: requestId }, mock)).rejects.toMatchObject({ retryable: false, details: { status: 302, failureKind: 'redirect', finalHost: 'api.deepseek.com', finalPath: '/chat/completions', redirectHost: 'api.deepseek.com', redirectPath: 'custom-path-redacted' } });
  expect(mock).toHaveBeenCalledOnce();
  const events = (await readAiDiagnostics(env)).items.filter(entry => entry.requestId === requestId);
  expect(events.find(entry => entry.phase === 'fetch_received')).toMatchObject({ httpStatus: 302, errorCode: 'REDIRECT_BLOCKED', failureKind: 'redirect' });
  expect(JSON.stringify(events)).not.toContain('fixture-provider-key');
  expect(safeDiagnosticTarget('https://api.deepseek.com/chat/completions/chat/completions')).toMatchObject({ finalPath: 'duplicate-operation-suffix' });
  expect(safeDiagnosticTarget('https://custom.example/private-key')).toEqual({ finalHost: 'custom-host-redacted', finalPath: 'custom-path-redacted' });
});

describe('outgoing provider protocol contracts (mocked only)', () => {
  it.each([
    ['openai', 'gpt-5.4', 'responses'], ['openai', 'gpt-4.1-mini', 'chat-completions'],
    ['anthropic', 'claude-sonnet-5-5', 'messages'], ['gemini', 'gemini-3.8-flash', 'gemini'],
    ['deepseek', 'deepseek-flash', 'chat-completions'], ['openrouter', 'openai/gpt-5', 'chat-completions'],
    ['opencode-go', 'glm-5.2', 'chat-completions'], ['opencode-go', 'gpt-6-luna', 'responses'], ['opencode-go', 'minimax-m3', 'messages'], ['opencode-go', 'qwen3.8-max', 'messages'],
    ['opencode-zen', 'minimax-m3', 'chat-completions'], ['opencode-zen', 'qwen3.8-max', 'chat-completions'], ['opencode-zen', 'claude-sonnet-5', 'messages'], ['opencode-zen', 'gpt-5.4', 'responses'],
  ] as const)('%s %s uses %s wire format and normalizes total usage', async (preset, model, protocol) => {
    const cfg = config(preset, model);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response(protocol))));
    const beforeFetch = vi.fn(async () => {});
    const out = await gatewayChat(endpoint, { config: cfg, messages, jsonMode: true, sessionId: 'stable-job-123', beforeFetch }, fetchMock);
    expect(out).toMatchObject({ content: '{"ok":true}', promptTokens: 9, completionTokens: 6 });
    expect(beforeFetch).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(presetEndpoint(preset, model));
    expect(init.redirect).toBe('manual');
    const headers = new Headers(init.headers); const body = JSON.parse(String(init.body));
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('cf-aig-gateway-id')).toBeNull();
    if (protocol === 'messages') {
      expect(headers.get('x-api-key')).toBe('fixture-provider-key'); expect(headers.get('anthropic-version')).toBe('2023-06-01'); expect(headers.has('authorization')).toBe(false);
      expect(body).toMatchObject({ model, max_tokens: FIXED_MAX_OUTPUT_TOKENS, system: 'Only JSON', messages: [{ role: 'user', content: 'Reply JSON' }] }); expect(body.response_format).toBeUndefined();
    } else if (protocol === 'gemini') {
      expect(headers.get('x-goog-api-key')).toBe('fixture-provider-key'); expect(headers.has('authorization')).toBe(false);
      expect(body).toMatchObject({ generationConfig: { maxOutputTokens: FIXED_MAX_OUTPUT_TOKENS, responseMimeType: 'application/json' }, systemInstruction: { parts: [{ text: 'Only JSON' }] }, contents: [{ role: 'user', parts: [{ text: 'Reply JSON' }] }] });
    } else {
      expect(headers.get('authorization')).toBe('Bearer fixture-provider-key');
      if (protocol === 'responses') { expect(body).toMatchObject({ model, max_output_tokens: FIXED_MAX_OUTPUT_TOKENS, store: false, input: messages }); expect(body.messages).toBeUndefined(); }
      else { expect(body.messages).toEqual(messages); expect(body.max_tokens ?? body.max_completion_tokens).toBe(FIXED_MAX_OUTPUT_TOKENS); }
    }
    if (preset === 'opencode-go') { expect(headers.get('user-agent')).toBe('AI-Collaboration-Seminar/1.0'); expect(headers.get('x-opencode-session')).toBe('stable-job-123'); }
    else expect(headers.has('x-opencode-session')).toBe(false);
    expect(body.temperature).toBeUndefined(); expect(body.top_p).toBeUndefined(); expect(body.reasoning_effort).toBeUndefined();
  });

  it.each([
    ['openai', 'gpt-5', { reasoningEffort: 'low', apiProtocol: 'chat-completions' }, { reasoning_effort: 'low', max_completion_tokens: FIXED_MAX_OUTPUT_TOKENS }],
    ['openai', 'gpt-5.4', { reasoningEffort: 'none', temperature: 0.2, topP: 0.9 }, { reasoning: { effort: 'none' }, temperature: 0.2, top_p: 0.9 }],
    ['deepseek', 'deepseek-flash', { reasoningEffort: 'high', topP: 0.98 }, { reasoning_effort: 'high', top_p: 0.98 }],
    ['deepseek', 'deepseek-flash', { reasoningEffort: 'none', temperature: 0.5 }, { thinking: { type: 'disabled' }, temperature: 0.5 }],
    ['openrouter', 'openai/gpt-5', { reasoningEffort: 'minimal' }, { reasoning: { effort: 'minimal' }, provider: { require_parameters: true } }],
    ['anthropic', 'claude-sonnet-5-5', { reasoningEffort: 'xhigh' }, { output_config: { effort: 'xhigh' } }],
    ['gemini', 'gemini-3.8-flash', { reasoningEffort: 'medium' }, { generationConfig: { thinkingConfig: { thinkingLevel: 'medium' } } }],
    ['opencode-go', 'gpt-6-luna', { reasoningEffort: 'high' }, { reasoning: { effort: 'high' } }],
    ['opencode-go', 'gpt-5.6-luna', { reasoningEffort: 'max' }, { reasoning: { effort: 'max' } }],
    ['opencode-go', 'grok-4.7', { reasoningEffort: 'xhigh' }, { reasoning: { effort: 'xhigh' } }],
    ['opencode-go', 'deepseek-v4-pro', { reasoningEffort: 'high' }, { reasoning_effort: 'high' }],
    ['opencode-go', 'deepseek-v4-pro', { reasoningEffort: 'none' }, { thinking: { type: 'disabled' } }],
    ['opencode-go', 'deepseek-v4.1-flash', { reasoningEffort: 'high' }, { reasoning_effort: 'high' }],
    ['opencode-go', 'deepseek-v4-flash', { reasoningEffort: 'max' }, { reasoning_effort: 'max' }],
    ['opencode-go', 'deepseek-v4-flash-vision-exp', { reasoningEffort: 'none' }, { thinking: { type: 'disabled' } }],
    ['opencode-zen', 'deepseek-v4-pro', { reasoningEffort: 'none' }, { thinking: { type: 'disabled' } }],
    ['deepseek', 'deepseek-v4.1-flash', { reasoningEffort: 'high' }, { reasoning_effort: 'high' }],
    ['deepseek-anthropic', 'deepseek-v4-pro', { reasoningEffort: 'max' }, { output_config: { effort: 'max' } }],
  ] as const)('%s %s serializes only supported option names', async (preset, model, options, expected) => {
    const cfg = config(preset, model, options);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response(protocolForConfig(cfg)))));
    await gatewayChat(endpoint, { config: cfg, messages }, fetchMock);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject(expected);
    if (preset === 'openrouter' || protocolForConfig(cfg) === 'responses' || preset === 'gemini') expect(body.reasoning_effort).toBeUndefined();
    expect(body.apiKeyEncrypted).toBeUndefined();
    if ((preset === 'deepseek' || preset === 'opencode-go' || preset === 'opencode-zen') && model.startsWith('deepseek-') && options.reasoningEffort === 'none') expect(body.reasoning_effort).toBeUndefined();
  });

  it('DeepSeek uses the fixed output cap and extracts only a completed answer', async () => {
    const cfg = config('deepseek', 'deepseek-flash', { reasoningEffort: 'high' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}', reasoning_content: 'synthetic private thought' } }],
      usage: { prompt_tokens: 9, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 94 } },
    })));
    expect(await gatewayChat(endpoint, { config: cfg, messages, jsonMode: true }, fetchMock)).toMatchObject({ content: '{"ok":true}', completionTokens: 100 });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ max_tokens: FIXED_MAX_OUTPUT_TOKENS, reasoning_effort: 'high', response_format: { type: 'json_object' } });
    expect(body.response_format).not.toHaveProperty('json_schema');
    expect(() => normalizeProviderResponse('chat-completions', {
      choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'synthetic private thought' } }],
      usage: { prompt_tokens: 9, completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } },
    })).toThrow('token 上限');
  });

  it('reports timeout and network failure separately without echoing the exception', async () => {
    const cfg = config('deepseek', 'deepseek-flash');
    const timedOut = vi.fn(async () => { throw new DOMException('synthetic-secret', 'TimeoutError'); });
    await expect(gatewayChat(endpoint, { config: cfg, messages }, timedOut)).rejects.toMatchObject({ message: expect.stringContaining('90 秒'), details: { timeout: true, cause: 'timeout' } });
    const unreachable = vi.fn(async () => { throw new TypeError('synthetic-secret'); });
    await expect(gatewayChat(endpoint, { config: cfg, messages }, unreachable)).rejects.toMatchObject({ message: expect.stringContaining('网络请求失败'), details: { timeout: false, cause: 'network_error' } });
  });

  it.each([
    ['openai', 'gpt-5', { temperature: 0.2 }], ['openai', 'gpt-5.4', { reasoningEffort: 'high', topP: 0.8 }], ['openai', 'gpt-4.1-mini', { reasoningEffort: 'low' }],
    ['openrouter', 'openai/o3', { reasoningEffort: 'low' }], ['deepseek', 'deepseek-flash', { reasoningEffort: 'medium' }], ['deepseek', 'deepseek-flash', { topP: 0.5 }],
    ['opencode-go', 'glm-5.2', { goUsageAcknowledged: false }], ['opencode-go', 'not-verified-model', {}], ['opencode-go', 'minimax-m3', { supportsJson: true }],
    ['gemini', 'gemini-3.8-flash', { reasoningEffort: 'minimal' }], ['anthropic', 'claude-sonnet-5-5', { temperature: 0.7 }],
  ] as const)('%s %s invalid options fail before reservation attempt/fetch', async (preset, model, options) => {
    const fetchMock = vi.fn(); const beforeFetch = vi.fn(async () => {});
    await expect(gatewayChat(endpoint, { config: config(preset, model, options), messages, sessionId: 'job', beforeFetch }, fetchMock)).rejects.toThrow();
    expect(beforeFetch).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires new credentials for manually changed preset destinations', () => {
    const original = config('opencode-go', 'minimax-m3');
    const proxy = { ...original, apiUrl: 'https://proxy.example/v1/messages' };
    expect(sameCredentialDestination(proxy, original)).toBe(false);
    expect(sameCredentialDestination(proxy, { ...proxy, apiUrl: 'https://other.example/v1/messages' })).toBe(false);
    expect(sameCredentialDestination(proxy, proxy)).toBe(true);
  });

  it('uses a manually configured preset URL while retaining Go protocol and headers', async () => {
    const cfg = config('opencode-go', 'minimax-m3', { apiUrl: 'https://proxy.example/v1/messages', apiProtocol: 'messages', goHeaders: { userAgent: 'MyOffice/1.2', sessionPrefix: 'office' } });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(cfg.apiUrl);
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBe('MyOffice/1.2');
      expect(headers.get('x-opencode-session')).toBe('office:job');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('minimax-m3');
      expect(body.max_tokens).toBe(FIXED_MAX_OUTPUT_TOKENS);
      return Response.json(response('messages'));
    });
    await gatewayChat(endpoint, { config: cfg, messages, sessionId: 'job' }, fetchMock);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('legacy worker/custom configs keep exact Chat behavior and omit all new options', async () => {
    const cfg = aiModelConfigSchema.parse({ provider: 'legacy-provider-name', model: 'old-model', apiUrl: 'https://legacy.example/v1/chat/completions', apiKeyEncrypted: encrypted, timeoutMs: 60000, maxInputChars: 10000, maxOutputTokens: 1024, supportsJson: true, supportsVision: false, temperature: 0.3 });
    for (const c of [cfg, { ...cfg, provider: 'workers-ai' }]) {
      const mock = vi.fn(async () => new Response(JSON.stringify(response('chat-completions'))));
      await gatewayChat(endpoint, { config: c, messages, jsonMode: true }, mock);
      const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(c.provider === 'workers-ai' ? 'https://api.cloudflare.com/client/v4/accounts/account/ai/v1/chat/completions' : cfg.apiUrl);
      expect(JSON.parse(String(init.body))).toEqual({ model: 'old-model', messages, max_tokens: FIXED_MAX_OUTPUT_TOKENS, temperature: 0.3, response_format: { type: 'json_object' } });
      expect(new Headers(init.headers).get('cf-aig-gateway-id')).toBe(c.provider === 'workers-ai' ? 'gateway' : null);
    }
  });

  it.each(['responses', 'messages', 'gemini'] as const)('%s preserves OCR data images', async protocol => {
    const preset = protocol === 'messages' ? 'anthropic' : protocol === 'gemini' ? 'gemini' : 'openai';
    const model = providerPresets[preset].models[0]!; const cfg = config(preset, model, { apiProtocol: protocol });
    const mock = vi.fn(async () => new Response(JSON.stringify(response(protocol))));
    await gatewayChat(endpoint, { config: cfg, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }, { type: 'text', text: 'OCR JSON' }] }] }, mock);
    const body = JSON.parse(String((mock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(JSON.stringify(body)).toContain('aGVsbG8='); expect(JSON.stringify(body)).toContain('OCR JSON');
    if (protocol === 'messages') expect(body.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
    if (protocol === 'gemini') expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } });
  });

  it('invalid session IDs, redirects, and missing totals never leak secrets or fabricate usage', async () => {
    const mock = vi.fn();
    await expect(gatewayChat(endpoint, { config: config('opencode-go', 'glm-5.2'), messages, sessionId: 'bad\r\nx-api-key: injected' }, mock)).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
    expect(normalizeProviderResponse('gemini', { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] })).toMatchObject({ promptTokens: null, completionTokens: null });
    expect(() => normalizeProviderResponse('responses', { ...response('responses'), status: 'incomplete' })).toThrow('未完成');
    expect(() => normalizeProviderResponse('messages', { ...response('messages'), stop_reason: 'max_tokens' })).toThrow('截断');
  });
});

const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };
async function putConfig(model: AiModelConfig, apiKey?: string, enabled = false) {
  const { apiKeyEncrypted: _encrypted, ...editable } = model;
  const withKey = { ...editable, ...(apiKey ? { apiKey } : {}) };
  return SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ textEconomy: withKey, visionEconomy: withKey, review: withKey, enabled }) });
}
describe('versioned configuration, authorization, and reservations', () => {
  it('does not pay for a same-budget repair when DeepSeek exhausts output tokens', async () => {
    const cfg = config('deepseek', 'deepseek-flash', { reasoningEffort: 'high' });
    expect((await putConfig(cfg, 'fixture-provider-key')).status).toBe(201);
    const loaded = (await loadAiConfig(env.DB))!;
    const user = await seedUser(); const projectId = await seedProject(user.userId); const jobId = crypto.randomUUID();
    await reserveAiSlot(env, { projectId, jobId, purpose: 'agent_run', configVersionId: loaded.id });
    const mock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'synthetic thought' } }], usage: { prompt_tokens: 3, completion_tokens: 4096 } })));
    vi.stubGlobal('fetch', mock);
    await expect(aiJsonCall(env, { projectId, jobId, configVersionId: loaded.id, purpose: 'textEconomy', model: cfg.model, modelConfig: cfg, promptVersion: 'fixture', messages, schema: z.object({ ok: z.literal(true) }) })).rejects.toMatchObject({ code: 'AI_OUTPUT_INVALID', details: { cause: 'output_limit' } });
    expect(mock).toHaveBeenCalledOnce();
    expect((await env.DB.prepare('SELECT attempts_started FROM usage_reservations WHERE job_id=?1').bind(jobId).first<{ attempts_started: number }>())?.attempts_started).toBe(1);
  });
  it('new options round-trip without exposing keys and freeze across later edits', async () => {
    const original = config('openai', 'gpt-5', { reasoningEffort: 'low' });
    expect((await putConfig(original, 'fixture-provider-key')).status).toBe(201);
    const frozen = (await loadAiConfig(env.DB))!;
    const read = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { headers: adminHeaders });
    const result = await read.text(); expect(result).toContain('reasoningEffort'); expect(result).not.toContain('fixture-provider-key'); expect(result).not.toContain('apiKeyEncrypted');
    expect((await putConfig({ ...original, reasoningEffort: 'high' })).status).toBe(201);
    expect((await loadAiConfig(env.DB, frozen.id))?.config.textEconomy.reasoningEffort).toBe('low');
    expect((await loadAiConfig(env.DB))?.config.textEconomy.reasoningEffort).toBe('high');
    const mock = vi.fn(async () => new Response(JSON.stringify(response('responses'))));
    await gatewayChat(endpoint, { config: (await loadAiConfig(env.DB, frozen.id))!.config.textEconomy, messages }, mock);
    expect(JSON.parse(String((mock.mock.calls[0] as unknown as [string, RequestInit])[1].body)).reasoning).toEqual({ effort: 'low' });
    expect((await putConfig({ ...original, reasoningEffort: 'high' }, undefined, true)).status).toBe(201);
    expect((await putConfig(config('deepseek', 'deepseek-flash'))).status).toBe(400);
  });

  it('Go repair retains session and 2-call accounting; provider 403 is not retried', async () => {
    const cfg = config('opencode-go', 'glm-5.2');
    expect((await putConfig(cfg, 'fixture-provider-key')).status).toBe(201);
    const loaded = (await loadAiConfig(env.DB))!;
    const user = await seedUser(); const projectId = await seedProject(user.userId); const jobId = crypto.randomUUID();
    await reserveAiSlot(env, { projectId, jobId, purpose: 'agent_run', configVersionId: loaded.id });
    const mock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: mock.mock.calls.length === 1 ? 'bad json' : '{"ok":true}' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })));
    vi.stubGlobal('fetch', mock);
    const args = { projectId, jobId, configVersionId: loaded.id, purpose: 'textEconomy' as const, model: cfg.model, modelConfig: cfg, promptVersion: 'fixture', messages, schema: z.object({ ok: z.literal(true) }) };
    expect((await aiJsonCall(env, args)).repaired).toBe(true); expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls.map(call => new Headers(call[1]?.headers).get('x-opencode-session'))).toEqual([jobId, jobId]);
    expect((await env.DB.prepare('SELECT attempts_started FROM usage_reservations WHERE job_id=?1').bind(jobId).first<{ attempts_started: number }>())?.attempts_started).toBe(2);
    await expect(aiJsonCall(env, args)).rejects.toThrow('次数上限'); expect(mock).toHaveBeenCalledTimes(2);
    const job2 = crypto.randomUUID(); await reserveAiSlot(env, { projectId, jobId: job2, purpose: 'review_run', configVersionId: loaded.id });
    const rejected = vi.fn(async () => new Response('secret body never echoed', { status: 403 })); vi.stubGlobal('fetch', rejected);
    await expect(aiJsonCall(env, { ...args, jobId: job2 })).rejects.toThrow('403'); expect(rejected).toHaveBeenCalledOnce();
  });
});

it('unknown Go models require explicit supported protocol and retain no speculative options', async () => {
  const cfg = config('opencode-go', 'future-model', { apiProtocol: 'responses', goHeaders: { userAgent: 'MyOffice/2.0', sessionPrefix: 'demo' } });
  const mock = vi.fn(async () => new Response(JSON.stringify(response('responses'))));
  await gatewayChat(endpoint, { config: cfg, messages, sessionId: 'stable-session' }, mock);
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://opencode.ai/zen/go/v1/responses');
  expect(new Headers(init.headers).get('user-agent')).toBe('MyOffice/2.0');
  expect(new Headers(init.headers).get('x-opencode-session')).toBe('demo:stable-session');
  expect(JSON.parse(String(init.body)).reasoning).toBeUndefined();
  await expect(gatewayChat(endpoint, { config: config('opencode-go', 'future-model', { apiProtocol: 'gemini' }), messages, sessionId: 'stable-session' }, mock)).rejects.toThrow('仅支持');
  expect(mock).toHaveBeenCalledOnce();
});

it('always attaches x-opencode-session at dispatch, falling back to the stable job ID when needed', async () => {
  const mock = vi.fn(async () => new Response(JSON.stringify(response('chat-completions'))));
  await gatewayChat(endpoint, { config: config('opencode-go', 'glm-5.2'), jobId: 'stable-job-123', messages }, mock);
  const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
  const headers = new Headers(init.headers);
  expect(headers.get('x-opencode-session')).toBe('stable-job-123');
  expect(headers.get('user-agent')).toBe('AI-Collaboration-Seminar/1.0');
});

it('generates a valid OpenCode Go session header when no caller ID is available', async () => {
  const mock = vi.fn(async () => new Response(JSON.stringify(response('chat-completions'))));
  await gatewayChat(endpoint, { config: config('opencode-go', 'glm-5.2'), messages }, mock);
  const [, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
  expect(new Headers(init.headers).get('x-opencode-session')).toMatch(/^[0-9a-f-]{36}$/i);
});

it.each([
  ['messages', { ...response('messages'), stop_reason: 'tool_use' }],
  ['chat-completions', { choices: [{ finish_reason: 'tool_calls', message: { content: '{"ok":true}', tool_calls: [] } }] }],
  ['responses', { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: '{"ok":true}' }] }] }],
  ['responses', { status: 'completed', output: [{ type: 'function_call', name: 'tool' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}' }] }] }],
  ['gemini', { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'tool' } }, { text: '{"ok":true}' }] } }] }],
  ['gemini', { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }],
  ['gemini', { ...response('gemini'), promptFeedback: { blockReason: 'SAFETY' } }],
] as const)('%s refuses incomplete/tool/blocked results even when answer-shaped text exists', (protocol, body) => {
  expect(() => normalizeProviderResponse(protocol, body)).toThrow();
});

it('control characters and unsafe Go header keys are rejected and network errors are redacted', async () => {
  const good = config('opencode-go', 'glm-5.2');
  expect((await putConfig(good, 'key\r\ninjected')).status).toBe(400);
  const unsafe = { ...good, goHeaders: { authorization: 'Bearer injected' } } as unknown as AiModelConfig;
  expect((await putConfig(unsafe, 'fixture-key')).status).toBe(400);
  const mock = vi.fn(async () => { throw new Error('network failure contains fixture-provider-key'); });
  try { await gatewayChat(endpoint, { config: good, messages, sessionId: 'job' }, mock); throw new Error('should fail'); }
  catch (error) { expect(JSON.stringify(error)).not.toContain('fixture-provider-key'); expect(String(error)).toContain('网络请求失败'); }
});

it('malformed provider bodies never expose parser snippets and oversized bodies are bounded', async () => {
  for (const body of ['{"echo":"fixture-secret" invalid', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    const mock = vi.fn(async () => new Response(body));
    try { await gatewayChat(endpoint, { config: config('openai', 'gpt-4.1-mini'), messages }, mock); throw new Error('should fail'); }
    catch (error) { expect(String(error)).toContain('有效 JSON'); expect(JSON.stringify(error)).not.toContain('fixture-secret'); }
  }
});


it('an explicit Go capability probe shares one stable session across text, JSON and vision requests', async () => {
  expect((await putConfig(config('opencode-go', 'glm-5.2'), 'fixture-provider-key')).status).toBe(201);
  const loaded = (await loadAiConfig(env.DB))!;
  const mock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const prompt = body.messages[0].content;
    const content = Array.isArray(prompt) ? '{"seen":true}' : String(prompt).includes('你好') ? '你好，测试成功' : '{"ok":true,"n":1}';
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  });
  vi.stubGlobal('fetch', mock);
  expect((await probeModel(env, 'visionEconomy', loaded)).passed).toBe(true);
  expect(mock).toHaveBeenCalledTimes(3);
  const sessions = mock.mock.calls.map(call => new Headers(call[1]?.headers).get('x-opencode-session'));
  expect(sessions[0]).toMatch(/^probe-/); expect(new Set(sessions).size).toBe(1);
});
