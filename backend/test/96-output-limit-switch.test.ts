import { describe, expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env, BASE } from './helpers/env';
import { ADMIN_TOKEN } from './helpers/constants';
import { aiModelConfigSchema, loadAiConfig } from '../src/ai/config';
import { buildProviderRequest } from '../src/ai/transport';
import { gatewayChat } from '../src/ai/gateway';
import { reserveAiSlot, estimateCostUsd } from '../src/services/budget';
import { seedProject, seedUser } from './helpers/seed';
import { providerOptionErrors, type ApiProtocol } from '../../shared/ai-providers';

const messages = [{ role: 'user' as const, content: 'Fixture' }];
const model = (extra: Record<string, unknown> = {}) => aiModelConfigSchema.parse({ provider: 'workers-ai', model: 'fixture', timeoutMs: 10000, maxInputChars: 1000, maxOutputTokens: 4096, supportsJson: false, supportsVision: false, ...extra });
describe('optional output limit', () => {
  it('defaults old frozen configurations to their original enabled limit', () => {
    expect(model()).toMatchObject({ enabledOutputLimit: true, maxOutputTokens: 4096 });
  });
  it.each([32769, 65536, Number.MAX_SAFE_INTEGER])('accepts a positive safe integer %s without a business maximum', value => {
    expect(model({ maxOutputTokens: value }).maxOutputTokens).toBe(value);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1n])('rejects nonserializable or invalid numeric limit %s', value => {
    expect(() => model({ maxOutputTokens: value })).toThrow();
  });
  it.each(['chat-completions', 'responses', 'gemini'] as ApiProtocol[])('omits output parameters on disabled %s, even with a call override', apiProtocol => {
    const cfg = model({ provider: 'custom', apiProtocol, enabledOutputLimit: false });
    const { body } = buildProviderRequest(cfg, messages, 'fixture', false, 32768);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body.generationConfig ?? {}).not.toHaveProperty('maxOutputTokens');
  });
  it('omits max_completion_tokens for native OpenAI Chat when disabled', () => {
    const cfg = model({ provider: 'openai-compatible', providerPreset: 'openai', apiProtocol: 'chat-completions', enabledOutputLimit: false });
    expect(buildProviderRequest(cfg, messages, 'fixture', false, 4096).body).not.toHaveProperty('max_completion_tokens');
  });
  it('round trips a disabled configuration and rejects an active disabled Messages save without calling a model', async () => {
    const loaded = (await loadAiConfig(env.DB, undefined, false))!;
    const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };
    const body = { ...loaded.config, routingMode: 'unified', unified: model({ enabledOutputLimit: false, maxOutputTokens: 65536 }), expectedVersion: loaded.version };
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    try {
      const saved = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { method: 'PUT', headers, body: JSON.stringify(body) });
      expect(saved.status).toBe(201);
      const result = await saved.json() as { data: { version: number; enabled: boolean } };
      expect(result.data.enabled).toBe(false);
      expect((await loadAiConfig(env.DB))!.config.textEconomy).toMatchObject({ enabledOutputLimit: false, maxOutputTokens: 65536 });
      const read = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { headers });
      expect(await read.json()).toMatchObject({ data: { config: { unified: { enabledOutputLimit: false, maxOutputTokens: 65536 }, textEconomy: { enabledOutputLimit: true } } } });
      const rejected = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { method: 'PUT', headers, body: JSON.stringify({ ...body, expectedVersion: result.data.version, unified: { ...body.unified, provider: 'openai-compatible', apiProtocol: 'messages', apiUrl: 'https://fixture.test/v1/messages' } }) });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: { message: expect.stringContaining('必填 max_tokens') } });
      expect((await loadAiConfig(env.DB))!.version).toBe(result.data.version);
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it('rejects a disabled Messages limit before dispatch rather than supplying a hidden fallback', async () => {
    const cfg = model({ provider: 'custom', apiProtocol: 'messages', enabledOutputLimit: false });
    expect(providerOptionErrors(cfg).join(' ')).toContain('必填 max_tokens');
    expect(() => buildProviderRequest(cfg, messages, 'fixture', false, undefined)).toThrow('必填 max_tokens');
    const fetch = vi.fn();
    await expect(gatewayChat({ accountId: 'fixture', apiToken: 'fixture', gatewayId: 'fixture' }, { config: cfg, messages }, fetch)).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('gateway sends no default cap when switched off and retains actual usage', async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).not.toHaveProperty('max_tokens');
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Fixture result' } }], usage: { prompt_tokens: 2, completion_tokens: 7 } });
    });
    const result = await gatewayChat({ accountId: 'fixture', apiToken: 'fixture', gatewayId: 'fixture' }, { config: model({ enabledOutputLimit: false }), messages }, fetch);
    expect(result.completionTokens).toBe(7); expect(fetch).toHaveBeenCalledOnce();
  });
  it('reads a frozen old version unchanged after a new disabled version is stored', async () => {
    const current = (await loadAiConfig(env.DB))!;
    const initial = await env.DB.prepare('SELECT id FROM ai_config_versions ORDER BY version LIMIT 1').first<{ id: string }>();
    const old = (await loadAiConfig(env.DB, initial!.id))!;
    const latest = structuredClone(old.config);
    for (const cfg of [latest.textEconomy, latest.visionEconomy, latest.review]) { cfg.enabledOutputLimit = false; cfg.maxOutputTokens = 65536; }
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO ai_config_versions (id, version, config_json, enabled, created_at) VALUES (?1, ?2, ?3, 0, ?4)').bind(id, current.version + 1, JSON.stringify(latest), new Date().toISOString()).run();
    expect((await loadAiConfig(env.DB, old.id))!.config.textEconomy).toMatchObject({ enabledOutputLimit: true, maxOutputTokens: old.config.textEconomy.maxOutputTokens });
    expect((await loadAiConfig(env.DB, id))!.config.textEconomy).toMatchObject({ enabledOutputLimit: false, maxOutputTokens: 65536 });
  });
  it('rejects finite monetary budgets without a cap and admits unbounded budgets with actual-use accounting', async () => {
    const owner = await seedUser(); const projectId = await seedProject(owner.userId);
    const loaded = (await loadAiConfig(env.DB))!;
    loaded.config.textEconomy.enabledOutputLimit = false;
    loaded.config.textEconomy.pricePerMTokens = [1, 1];
    await env.DB.prepare('UPDATE ai_config_versions SET config_json = ?2 WHERE id = ?1').bind(loaded.id, JSON.stringify(loaded.config)).run();
    expect(estimateCostUsd(loaded, 'textEconomy')).toBe(0);
    await env.DB.prepare('UPDATE projects SET ai_budget_usd = 100 WHERE id = ?1').bind(projectId).run();
    await expect(reserveAiSlot(env, { projectId, jobId: crypto.randomUUID(), purpose: 'source_summary', configVersionId: loaded.id })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await env.DB.prepare('UPDATE projects SET ai_budget_usd = NULL WHERE id = ?1').bind(projectId).run();
    const jobId = crypto.randomUUID();
    await reserveAiSlot(env, { projectId, jobId, purpose: 'source_summary', configVersionId: loaded.id });
    expect(await env.DB.prepare('SELECT estimated_cost, status FROM usage_reservations WHERE job_id = ?1').bind(jobId).first()).toEqual({ estimated_cost: 0, status: 'reserved' });
  });
});
