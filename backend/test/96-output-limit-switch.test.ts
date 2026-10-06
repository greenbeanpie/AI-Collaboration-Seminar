import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env, BASE } from './helpers/env';
import { ADMIN_TOKEN } from './helpers/constants';
import { aiConfigSchema, aiModelConfigSchema, loadAiConfig } from '../src/ai/config';
import { buildProviderRequest } from '../src/ai/transport';
import { providerOptionErrors, FIXED_MAX_OUTPUT_TOKENS, type ApiProtocol } from '../../shared/ai-providers';

const messages = [{ role: 'user' as const, content: 'Fixture' }];
const model = (extra: Record<string, unknown> = {}) => aiModelConfigSchema.parse({ provider: 'openai-compatible', providerPreset: 'custom', gatewayProviderSlug: 'fixture-provider', model: 'fixture', timeoutMs: 10000, maxInputChars: 1000, supportsJson: false, supportsVision: false, ...extra });

describe('fixed output cap', () => {
  it('discards legacy output settings from parsed configs', async () => {
    const legacy = model({ enabledOutputLimit: false, maxOutputTokens: 2048 });
    expect(legacy).not.toHaveProperty('enabledOutputLimit');
    expect(legacy).not.toHaveProperty('maxOutputTokens');
    const loaded = (await loadAiConfig(env.DB, undefined, false))!;
    const old = aiConfigSchema.parse({
      ...loaded.config,
      unified: { ...loaded.config.textEconomy, enabledOutputLimit: false, maxOutputTokens: 2048 },
      textEconomy: { ...loaded.config.textEconomy, enabledOutputLimit: false, maxOutputTokens: 1024 },
      visionEconomy: { ...loaded.config.visionEconomy, maxOutputTokens: 8192 },
      review: { ...loaded.config.review, maxOutputTokens: 16384 },
    });
    for (const config of [old.unified!, old.textEconomy, old.visionEconomy, old.review]) {
      expect(config).not.toHaveProperty('enabledOutputLimit');
      expect(config).not.toHaveProperty('maxOutputTokens');
    }
  });

  it.each(['chat-completions', 'responses', 'messages', 'gemini'] as ApiProtocol[])(
    'sends a fixed 65535 token cap on %s regardless of legacy per-model values', protocol => {
      const config = model({ apiProtocol: protocol, enabledOutputLimit: false, maxOutputTokens: 7 });
      const { body } = buildProviderRequest(config, messages, 'fixture', false);
      if (protocol === 'gemini') expect(body.generationConfig).toMatchObject({ maxOutputTokens: FIXED_MAX_OUTPUT_TOKENS });
      else if (protocol === 'responses') expect(body.max_output_tokens).toBe(FIXED_MAX_OUTPUT_TOKENS);
      else expect(body.max_tokens).toBe(FIXED_MAX_OUTPUT_TOKENS);
    },
  );

  it('uses the fixed value for native OpenAI Chat completion tokens', () => {
    const config = model({ providerPreset: 'openai', apiProtocol: 'chat-completions', enabledOutputLimit: false, maxOutputTokens: 123 });
    expect(buildProviderRequest(config, messages, 'fixture', false).body.max_completion_tokens).toBe(FIXED_MAX_OUTPUT_TOKENS);
  });

  it('provides Messages max_tokens without any output setting', () => {
    const config = model({ apiProtocol: 'messages', enabledOutputLimit: false, maxOutputTokens: 2 });
    expect(providerOptionErrors(config)).toEqual([]);
    expect(buildProviderRequest(config, messages, 'fixture', false).body.max_tokens).toBe(FIXED_MAX_OUTPUT_TOKENS);
  });

  it('omits cap fields from the admin API and normalizes legacy database values', async () => {
    const current = (await loadAiConfig(env.DB, undefined, false))!;
    const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };
    const keylessConfig = Object.fromEntries(Object.entries(current.config).map(([key, value]) => [key, value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([field]) => !['apiKeyEncrypted', 'maxOutputTokens', 'enabledOutputLimit'].includes(field))) : value]));
    const body = {
      ...keylessConfig,
      expectedVersion: current.version,
      unified: keylessConfig.textEconomy,
      textEconomy: keylessConfig.textEconomy,
      visionEconomy: keylessConfig.visionEconomy,
      review: keylessConfig.review,
    };
    const saved = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { method: 'PUT', headers, body: JSON.stringify(body) });
    expect(saved.status, await saved.clone().text()).toBe(201);
    const data = (await saved.json() as { data: { id: string; version: number } }).data;
    const normalized = (await loadAiConfig(env.DB, data.id, false))!.config;
    for (const config of [normalized.unified!, normalized.textEconomy, normalized.visionEconomy, normalized.review]) {
      expect(config).not.toHaveProperty('enabledOutputLimit');
      expect(config).not.toHaveProperty('maxOutputTokens');
    }
    const stored = await env.DB.prepare('SELECT config_json FROM ai_config_versions WHERE id=?1').bind(data.id).first<{config_json:string}>();
    expect(stored!.config_json).not.toContain('maxOutputTokens');
    expect(stored!.config_json).not.toContain('enabledOutputLimit');
    const read = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { headers });
    const text = await read.text();
    expect(text).not.toContain('maxOutputTokens');
    expect(text).not.toContain('enabledOutputLimit');
  });
});
