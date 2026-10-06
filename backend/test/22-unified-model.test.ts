import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { ADMIN_TOKEN } from './helpers/constants';
import { loadAiConfig } from '../src/ai/config';
import { gatewayChat } from '../src/ai/gateway';
import { withReservedAiJob } from '../src/services/ai-reservations';
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
  it('enables a saved legacy row without routingMode or probe evidence', async () => {
    const raw = (await loadAiConfig(env.DB, undefined, false))!;
    expect(raw.config.routingMode).toBeUndefined();
    const read = await get();
    expect(read.config.searchEnabled).toBe(false);
    expect((await put({ ...read.config, searchEnabled: true, enabled: true, expectedVersion: read.version })).status).toBe(409);
    expect((await put({ ...read.config, enabled: true, expectedVersion: read.version })).status).toBe(201);
  });
  it('accepts configurations without price settings and preserves concurrency admission', async () => {
    const current = await get();
    const owner = await seedUser();
    const projectId = await seedProject(owner.userId);
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    for (const provider of ['workers-ai', 'openai-compatible']) {
      const unified = { ...current.config.textEconomy, provider, ...(provider==='openai-compatible'?{providerPreset:'custom',gatewayProviderSlug:'custom-models'}:{}) };
      expect((await put({ ...current.config, routingMode: 'unified', unified })).status).toBe(201);
      const runtime = (await loadAiConfig(env.DB))!;
      for (const purpose of ['unified', 'textEconomy', 'visionEconomy', 'review'] as const) {
      expect(runtime.config[purpose]).not.toHaveProperty('pricePerMTokens');
      expect(runtime.config[purpose]).not.toHaveProperty('cachedInputPricePerMTokens');
      expect(runtime.config[purpose]).not.toHaveProperty('mediaInputPricePerMTokens');
      }
      const create = vi.fn(async () => 'created');
      await expect(withReservedAiJob(env, { projectId, purpose: 'review_run' }, create)).resolves.toBe('created');
      expect(create).toHaveBeenCalledOnce();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('preserves drafts and frozen versions while resolving all runtime purposes without money fields', async () => {
    const old = (await loadAiConfig(env.DB))!;
    const current = await get();
    expect((await put({ ...current.config, routingMode: 'unified', unified: { ...current.config.textEconomy, model: 'one-model' }, expectedVersion: current.version })).status).toBe(201);
    const raw = (await loadAiConfig(env.DB, undefined, false))!;
    const runtime = (await loadAiConfig(env.DB))!;
    expect(raw.config.textEconomy.model).toBe(old.config.textEconomy.model);
    for (const purpose of ['textEconomy', 'visionEconomy', 'review'] as const) {
      expect(runtime.config[purpose]).toBe(runtime.config.unified);
      expect(runtime.config[purpose]).not.toHaveProperty('pricePerMTokens');
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
  it('stores ordinary unified provider keys encrypted and keeps the API URL independent', async () => {
    const current = await get();
    const unified = { ...current.config.textEconomy, provider: 'openai-compatible', providerPreset:'custom', apiUrl: 'https://one.example.com/v1/chat/completions', model: 'one', apiKey: 'fixture-unified-provider-key' };
    expect((await put({ ...current.config, routingMode: 'unified', unified })).status).toBe(201);
    const read = await get();
    expect(read.config.unified.keyConfigured).toBe(true);
    expect(JSON.stringify(read)).not.toContain('apiKeyEncrypted');
    expect((await put({ ...read.config, unified: { ...read.config.unified, apiKey:'', keyConfigured: true } })).status).toBe(201);
    expect((await loadAiConfig(env.DB, undefined, false))!.config.unified!.apiKeyEncrypted).toBeTruthy();
  });
  it('allows inactive advanced options, but validates them on activation', async () => {
    const current = await get();
    const draft = { ...current.config, routingMode: 'unified', unified: current.config.textEconomy, review: { ...current.config.review, apiProtocol: 'messages' } };
    expect((await put(draft)).status).toBe(201);
    expect((await put({ ...draft, routingMode: 'advanced' })).status).toBe(400);
  });
  it('enables text-only config without probes and denies images before decrypt/fetch', async () => {
    const current = await get();
    expect((await put({ ...current.config, routingMode: 'unified', unified: { ...current.config.textEconomy, supportsVision: false, model: 'one-text' } })).status).toBe(201);
    const read = await get();
    expect((await put({ ...read.config, enabled: true })).status).toBe(201);
    const runtime = (await loadAiConfig(env.DB))!;
    const fetchMock = vi.fn();
    await expect(gatewayChat({ accountId: '', apiToken: '', gatewayId: '' }, { config: { ...runtime.config.visionEconomy, provider: 'openai-compatible', apiKeyEncrypted: 'invalid-ciphertext' }, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }] }] }, fetchMock)).rejects.toThrow('不支持图像');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
