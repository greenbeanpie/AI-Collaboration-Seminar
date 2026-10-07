import { describe, expect, it } from 'vitest';
import { aiModelConfigSchema, loadAiConfig } from '../src/ai/config';
import { recordAiCall, type AiContextMetadata } from '../src/ai/calls';
import { env } from './helpers/env';
import { buildProviderRequest, normalizeProviderResponse } from '../src/ai/transport';
import { applyToolMode, normalizeToolResponse, type ToolContextEntry, type ToolExchange } from '../src/ai/tool-transport';
import { normalizeTokenUsage } from '../src/ai/usage';
import type { ApiProtocol } from '../../shared/ai-providers';

const config = aiModelConfigSchema.parse({ provider: 'openai-compatible', providerPreset: 'deepseek', model: 'deepseek-flash', apiUrl: 'https://api.deepseek.com/chat/completions', timeoutMs: 90000, maxInputChars: 48000, supportsJson: true, supportsVision: false });
const call = { id: 'read-1', name: 'read_file', args: { id: 'file-1' } };
const raw = { choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: 'private reasoning', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] };
const exchange = (protocol: ApiProtocol): ToolExchange => ({
  assistant: protocol === 'messages' ? [{ type: 'thinking', thinking: 'private reasoning', signature: 'sig' }, { type: 'tool_use', id: call.id, name: call.name, input: call.args }]
    : protocol === 'responses' ? [{ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }]
      : protocol === 'gemini' ? { role: 'model', parts: [{ functionCall: { id: call.id, name: call.name, args: call.args } }] }
        : normalizeToolResponse(protocol, raw).assistant,
  results: [{ call, output: { text: 'file evidence' } }],
});

describe('ordered tool context', () => {
  it.each(['chat-completions', 'messages', 'responses', 'gemini'] as const)('appends feedback after complete %s exchanges without rewriting the base', protocol => {
    const cfg = { ...config, apiProtocol: protocol };
    const base = buildProviderRequest(cfg, [{ role: 'system', content: 'rules' }, { role: 'user', content: 'fixed initial input' }], '', false).body;
    const key = protocol === 'responses' ? 'input' : protocol === 'gemini' ? 'contents' : 'messages';
    const timeline: ToolContextEntry[] = [{ kind: 'exchange', exchange: exchange(protocol) }, { kind: 'message', message: { role: 'user', content: 'feedback revision 2' } }];
    const first = structuredClone(base);
    applyToolMode(cfg, protocol, first, { definitions: [], timeline });
    const second = structuredClone(base);
    applyToolMode(cfg, protocol, second, { definitions: [], timeline: [...timeline, { kind: 'message', message: { role: 'user', content: 'clarification answer' } }] });
    expect((second[key] as unknown[]).slice(0, (first[key] as unknown[]).length)).toEqual(first[key]);
    const serialized = JSON.stringify(second);
    expect(serialized.indexOf('file evidence')).toBeLessThan(serialized.indexOf('feedback revision 2'));
    expect(serialized.indexOf('feedback revision 2')).toBeLessThan(serialized.indexOf('clarification answer'));
    expect((first[key] as unknown[]).slice(0, (base[key] as unknown[]).length)).toEqual(base[key]);
    if (protocol === 'messages') expect(serialized).toContain('"signature":"sig"');
  });
  it('keeps backward exchanges and replays reasoning only to applicable DeepSeek providers', () => {
    for (const preset of ['deepseek', 'opencode-zen', 'custom', 'openai'] as const) {
      const body: Record<string, unknown> = { messages: [] };
      applyToolMode({ ...config, providerPreset: preset, model: 'deepseek-v4-pro' }, 'chat-completions', body, { definitions: [], exchanges: [exchange('chat-completions')] });
      expect(JSON.stringify(body).includes('private reasoning')).toBe(preset === 'deepseek' || preset === 'opencode-zen');
    }
    expect(exchange('chat-completions').assistant).toHaveProperty('reasoning_content', 'private reasoning');
  });
  it('rejects incremental system messages', () => {
    expect(() => applyToolMode(config, 'chat-completions', { messages: [] }, { definitions: [], timeline: [{ kind: 'message', message: { role: 'system', content: 'new prefix' } }] })).toThrow();
  });
});

describe('cache token normalization', () => {
  it('prefers explicit Chat cache hit usage instead of double counting', () => {
    const usage = { prompt_tokens: 100, completion_tokens: 12, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40, prompt_tokens_details: { cached_tokens: 60 } };
    const expected = { promptTokens: 100, completionTokens: 12, cachedTokens: 60, cacheMissTokens: 40 };
    expect(normalizeToolResponse('chat-completions', { ...raw, usage })).toMatchObject(expected);
    expect(normalizeProviderResponse('chat-completions', { choices: [{ finish_reason: 'stop', message: { content: 'answer' } }], usage })).toMatchObject(expected);
  });
  it('counts Messages cache creation and reads in the total input exactly once', () => {
    expect(normalizeTokenUsage('messages', { usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70, output_tokens: 12 } }))
      .toEqual({ promptTokens: 100, completionTokens: 12, cachedTokens: 70, cacheMissTokens: 30 });
  });
  it('uses nested cache detail fields and safe total semantics for other protocols', () => {
    expect(normalizeTokenUsage('responses', { usage: { input_tokens: 100, output_tokens: 12, input_tokens_details: { cached_tokens: 75 } } })).toMatchObject({ promptTokens: 100, cachedTokens: 75, cacheMissTokens: 25 });
    expect(normalizeTokenUsage('gemini', { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, thoughtsTokenCount: 7, cachedContentTokenCount: 75 } })).toMatchObject({ promptTokens: 100, completionTokens: 12, cachedTokens: 75, cacheMissTokens: 25 });
  });
  it('keeps absent and invalid usage unknown, including malformed optional Messages components', () => {
    expect(normalizeTokenUsage('chat-completions', {})).toEqual({ promptTokens: null, completionTokens: null, cachedTokens: null, cacheMissTokens: null });
    for (const value of [-1, 1.5, '8', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(normalizeTokenUsage('chat-completions', { usage: { prompt_tokens: 100, prompt_cache_hit_tokens: value, prompt_tokens_details: { cached_tokens: 80 } } }).cachedTokens).toBeNull();
      expect(normalizeTokenUsage('messages', { usage: { input_tokens: 10, cache_creation_input_tokens: value, cache_read_input_tokens: 70 } })).toMatchObject({ promptTokens: null, cacheMissTokens: null });
    }
    expect(normalizeTokenUsage('chat-completions', { usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 101 } }).cachedTokens).toBeNull();
    expect(normalizeTokenUsage('chat-completions', { usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 40 } }).cacheMissTokens).toBeNull();
  });
});

it('persists nullable cache columns and only whitelisted context metadata for old and new callers', async () => {
  await env.DB.prepare('UPDATE ai_config_versions SET enabled = 1').run();
  const cfg = (await loadAiConfig(env.DB))!;
  const params = { purpose: 'textEconomy' as const, configVersionId: cfg.id, promptVersion: 'cache-test', model: cfg.config.textEconomy.model, input: {}, output: {}, promptTokens: 100, completionTokens: 12, latencyMs: 1, status: 'ok' as const };
  const oldId = await recordAiCall(env, params);
  expect(await env.DB.prepare('SELECT cached_tokens, cache_miss_tokens, context_metadata_json FROM ai_calls WHERE id=?1').bind(oldId).first()).toEqual({ cached_tokens: null, cache_miss_tokens: null, context_metadata_json: null });
  const metadata: AiContextMetadata & { private: string } = { protocol: 'chat-completions', step: 2, stage: 0, compactionCount: 0, baseHash: 'a'.repeat(64), baseChars: 100, inputHash: 'b'.repeat(64), inputChars: 150, repeatedReads: 1, private: 'must not be logged' };
  const newId = await recordAiCall(env, { ...params, cachedTokens: 80, cacheMissTokens: 20, contextMetadata: metadata });
  const row = (await env.DB.prepare('SELECT cached_tokens, cache_miss_tokens, context_metadata_json FROM ai_calls WHERE id=?1').bind(newId).first<{ cached_tokens: number; cache_miss_tokens: number; context_metadata_json: string }>())!;
  expect(row).toMatchObject({ cached_tokens: 80, cache_miss_tokens: 20 });
  expect(JSON.parse(row.context_metadata_json)).toMatchObject({ stage: 0, step: 2, repeatedReads: 1 });
  expect(row.context_metadata_json).not.toContain('must not be logged');
});
