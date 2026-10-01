import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { ADMIN_TOKEN } from './helpers/constants';
import { loadAiConfig } from '../src/ai/config';
import { gatewayChat } from '../src/ai/gateway';
import { estimateCostUsd, withReservedAiJob } from '../src/services/budget';
import { seedProject, seedUser } from './helpers/seed';
const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };
const get = async () => (await (await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { headers })).json() as { data: { version: number; config: Record<string, any> } }).data;
const put = (body: unknown) => SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { method: 'PUT', headers, body: JSON.stringify(body) });
const fixtureConfig = JSON.stringify((await loadAiConfig(env.DB, undefined, false))!.config);
beforeEach(async () => {
  const latest = (await loadAiConfig(env.DB))!;
  await env.DB.prepare('INSERT INTO ai_config_versions (id, version, config_json, enabled, created_by, created_at) VALUES (?1, ?2, ?3, 0, ?4, ?5)').bind(crypto.randomUUID(), latest.version + 1, fixtureConfig, 'test', new Date().toISOString()).run();
});
afterEach(() => vi.unstubAllGlobals());
describe('unified routing', () => {
  it('enables legacy rows without routingMode after their existing probes', async () => {
    const raw = (await loadAiConfig(env.DB, undefined, false))!;
    expect(raw.config.routingMode).toBeUndefined();
    for (const purpose of ['textEconomy', 'visionEconomy', 'review']) {
      await env.DB.prepare('INSERT INTO ai_probes (config_version_id, purpose, passed, report_json, tested_at) VALUES (?1, ?2, 1, ?3, ?4)').bind(raw.id, purpose, '{}', new Date().toISOString()).run();
    }
    const read = await get();
    expect((await put({ ...read.config, enabled: true, expectedVersion: read.version })).status).toBe(201);
  });
  it('uses unified pricing and retains finite-budget guards before creating work', async () => {
    const current = await get();
    const owner = await seedUser();
    const projectId = await seedProject(owner.userId);
    await env.DB.prepare('UPDATE projects SET ai_budget_usd = 100 WHERE id = ?1').bind(projectId).run();
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    for (const provider of ['workers-ai', 'openai-compatible']) {
      const unified = { ...current.config.textEconomy, provider, pricePerMTokens: provider === 'workers-ai' ? null : [2, 4] };
      expect((await put({ ...current.config, routingMode: 'unified', unified })).status).toBe(201);
      const runtime = (await loadAiConfig(env.DB))!;
      expect(estimateCostUsd(runtime, 'textEconomy')).toBe(estimateCostUsd(runtime, 'visionEconomy'));
      expect(estimateCostUsd(runtime, 'review')).toBe(estimateCostUsd(runtime, 'textEconomy'));
      if (provider !== 'workers-ai') expect(estimateCostUsd(runtime, 'review')).toBeGreaterThan(0);
      const create = vi.fn();
      await expect(withReservedAiJob(env, { projectId, purpose: 'review_run' }, create)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
      expect(create).not.toHaveBeenCalled();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('preserves drafts and frozen versions while resolving all runtime purposes and prices', async () => {
    const old = (await loadAiConfig(env.DB))!;
    const current = await get();
    expect((await put({ ...current.config, routingMode: 'unified', unified: { ...current.config.textEconomy, model: 'one-model', pricePerMTokens: [3, 7] }, expectedVersion: current.version })).status).toBe(201);
    const raw = (await loadAiConfig(env.DB, undefined, false))!;
    const runtime = (await loadAiConfig(env.DB))!;
    expect(raw.config.textEconomy.model).toBe(old.config.textEconomy.model);
    for (const purpose of ['textEconomy', 'visionEconomy', 'review'] as const) {
      expect(runtime.config[purpose]).toBe(runtime.config.unified);
      expect(runtime.config[purpose].pricePerMTokens).toEqual([3, 7]);
    }
    expect((await loadAiConfig(env.DB, old.id))!.config.textEconomy.model).toBe(old.config.textEconomy.model);
    const read = await get();
    const { routingMode: _mode, unified: _unified, ...legacy } = read.config;
    expect((await put(legacy)).status).toBe(201);
    const kept = await get();
    expect(kept.config.routingMode).toBe('unified');
    expect(kept.config.unified.model).toBe('one-model');
    expect((await put({ ...kept.config, routingMode: 'advanced' })).status).toBe(201);
    expect((await get()).config.unified.model).toBe('one-model');
    expect((await loadAiConfig(env.DB))!.config.textEconomy.model).toBe(old.config.textEconomy.model);
  });
  it('rejects missing unified and stale/concurrent saves', async () => {
    const current = await get();
    expect((await put({ ...current.config, routingMode: 'unified' })).status).toBe(400);
    expect((await put({ ...current.config, expectedVersion: current.version - 1 })).status).toBe(409);
    const replies = await Promise.all([put({ ...current.config, expectedVersion: current.version }), put({ ...current.config, expectedVersion: current.version })]);
    expect(replies.map(r => r.status).sort()).toEqual([201, 409]);
  });
  it('redacts and destination-binds the independent unified key', async () => {
    const current = await get();
    const unified = { ...current.config.textEconomy, provider: 'openai-compatible', apiUrl: 'https://one.example.com/v1/chat/completions', model: 'one', apiKey: 'fixture-unified-key' };
    expect((await put({ ...current.config, routingMode: 'unified', unified })).status).toBe(201);
    const read = await get();
    expect(read.config.unified.keyConfigured).toBe(true);
    expect(JSON.stringify(read)).not.toContain('apiKeyEncrypted');
    expect(JSON.stringify(read)).not.toContain('fixture-unified-key');
    expect((await put({ ...read.config, unified: { ...read.config.unified, apiUrl: 'https://other.example.com/v1/chat/completions' } })).status).toBe(400);
    expect((await loadAiConfig(env.DB, undefined, false))!.config.textEconomy.apiKeyEncrypted).toBeUndefined();
  });
  it('allows inactive advanced options, but validates them on activation', async () => {
    const current = await get();
    const draft = { ...current.config, routingMode: 'unified', unified: current.config.textEconomy, review: { ...current.config.review, apiProtocol: 'messages' } };
    expect((await put(draft)).status).toBe(201);
    expect((await put({ ...draft, routingMode: 'advanced' })).status).toBe(400);
  });
  it('text-only enables after applicable probes and denies images before decrypt/fetch', async () => {
    const current = await get();
    expect((await put({ ...current.config, routingMode: 'unified', unified: { ...current.config.textEconomy, supportsVision: false, model: 'one-text' } })).status).toBe(201);
    const read = await get();
    expect((await put({ ...read.config, enabled: true })).status).toBe(409);
    const mock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.model).toBe('one-text');
      const content = request.messages[0].content.includes('JSON') ? '{"ok":true,"n":1}' : '你好，测试';
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 4, completion_tokens: 3 } }));
    });
    vi.stubGlobal('fetch', mock);
    for (const purpose of ['textEconomy', 'review']) {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/ai-config/probe`, { method: 'POST', headers, body: JSON.stringify({ purpose }) });
      expect((await res.json() as any).data.passed).toBe(true);
    }
    mock.mockClear();
    const vision = await SELF.fetch(`${BASE}/api/v1/admin/ai-config/probe`, { method: 'POST', headers, body: JSON.stringify({ purpose: 'visionEconomy' }) });
    expect((await vision.json() as any).data.passed).toBe(false);
    expect(mock).not.toHaveBeenCalled();
    expect((await put({ ...read.config, enabled: true })).status).toBe(201);
    const runtime = (await loadAiConfig(env.DB))!;
    const fetchMock = vi.fn();
    await expect(gatewayChat({ accountId: '', apiToken: '', gatewayId: '' }, { config: { ...runtime.config.visionEconomy, provider: 'openai-compatible', apiKeyEncrypted: 'invalid-ciphertext' }, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }] }] }, fetchMock)).rejects.toThrow('不支持图像');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
