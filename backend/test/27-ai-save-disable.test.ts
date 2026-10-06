import { SELF } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { ADMIN_TOKEN } from './helpers/constants';
import { authCookie, seedUser } from './helpers/seed';
import { loadAiConfig } from '../src/ai/config';

const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };
const path = '/api/v1/admin/ai-config';
function request(method: 'PUT' | 'POST', suffix: string, body: unknown, customHeaders: Record<string, string> = headers) {
  return SELF.fetch(BASE + path + suffix, { method, headers: customHeaders, body: JSON.stringify(body) });
}
async function readConfig() {
  const response = await SELF.fetch(BASE + path, { headers });
  return (await response.json() as { data: { version: number; enabled: boolean; config: Record<string, unknown> } }).data;
}
afterEach(() => vi.unstubAllGlobals());

it('ordinary save and explicit enable do not require a successful connection probe', async () => {
  const loaded = await loadAiConfig(env.DB, undefined, false);
  const text = { ...loaded!.config.textEconomy, provider: 'openai-compatible', model: 'fixture-model', apiUrl: 'https://model.example.com/v1/chat/completions', apiKey: 'fixture-only-key' };
  const initial = await request('PUT', '', { ...loaded!.config, routingMode: 'unified', unified: text, enabled: false, expectedVersion: loaded!.version });
  expect(initial.status).toBe(201);
  const network = vi.fn(async () => new Response('unavailable', { status: 500 }));
  vi.stubGlobal('fetch', network);
  const probe = await request('POST', '/probe', { purpose: 'textEconomy' });
  expect((await probe.json() as { data: { passed: boolean } }).data.passed).toBe(false);
  network.mockClear();
  const current = await readConfig();
  const save = await request('PUT', '', { ...current.config, expectedVersion: current.version });
  expect(save.status).toBe(201);
  expect((await save.json() as { data: { enabled: boolean } }).data.enabled).toBe(false);
  expect(network).not.toHaveBeenCalled();
  const newest = await readConfig();
  const enable = await request('PUT', '', { ...newest.config, expectedVersion: newest.version, enabled: true });
  expect(enable.status).toBe(201);
  expect((await enable.json() as { data: { enabled: boolean } }).data.enabled).toBe(true);
  expect(network).not.toHaveBeenCalled();
}, 60_000);

it('saving an unchanged enabled config preserves enabled without probes; changing it saves safely disabled', async () => {
  await env.DB.prepare('UPDATE ai_config_versions SET enabled = 1 WHERE version = (SELECT MAX(version) FROM ai_config_versions)').run();
  const network = vi.fn(async () => { throw new Error('Save must never call a provider'); });
  vi.stubGlobal('fetch', network);
  const current = await readConfig();
  const kept = await request('PUT', '', { ...current.config, expectedVersion: current.version });
  expect(kept.status).toBe(201);
  expect((await kept.json() as { data: { enabled: boolean } }).data.enabled).toBe(true);
  const newest = await readConfig();
  const text = newest.config.textEconomy as Record<string, unknown>;
  const changed = await request('PUT', '', { ...newest.config, unified: { ...(newest.config.unified as Record<string, unknown>), model: 'changed-model' }, expectedVersion: newest.version });
  expect(changed.status).toBe(201);
  expect((await changed.json() as { data: { enabled: boolean } }).data.enabled).toBe(false);
  expect(network).not.toHaveBeenCalled();
});

it('ordinary save retains URL, credential destination and provider option validation', async () => {
  const current = await readConfig();
  const text = current.config.textEconomy as Record<string, unknown>;
  const first = await request('PUT', '', { ...current.config, routingMode: 'unified', unified: { ...text, provider: 'openai-compatible', model: 'fixture-model', apiUrl: 'https://model.example.com/v1/chat/completions', apiKey: 'fixture-only-key' }, expectedVersion: current.version });
  expect(first.status).toBe(201);
  const stored = await readConfig();
  const storedText = stored.config.unified as Record<string, unknown>;
  for (const patch of [
    { apiUrl: 'https://other.example.com/v1/chat/completions' },
    { apiUrl: 'https://model.example.com/v1/chat/completions?key=bad' },
    { providerPreset: 'opencode-go', model: 'minimax-m3', apiProtocol: 'messages', apiUrl: 'https://opencode.ai/zen/go/v1/messages', clearKey: true, goUsageAcknowledged: false },
  ]) {
    const response = await request('PUT', '', { ...stored.config, unified: { ...storedText, ...patch }, expectedVersion: stored.version });
    expect(response.status).toBe(400);
  }
  expect((await readConfig()).version).toBe(stored.version);
});

it('disable copies persisted encrypted config and notes with an audited new version, without a key or model call', async () => {
  const current = await readConfig();
  const text = current.config.textEconomy as Record<string, unknown>;
  const saved = await request('PUT', '', { ...current.config, routingMode: 'unified', unified: { ...text, provider: 'openai-compatible', model: 'fixture-model', apiUrl: 'https://model.example.com/v1/chat/completions', apiKey: 'fixture-only-key' }, notes: 'retained audit note', expectedVersion: current.version });
  expect(saved.status).toBe(201);
  const before = await env.DB.prepare('SELECT version, config_json, notes FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{ version: number; config_json: string; notes: string }>();
  await env.DB.prepare('UPDATE ai_config_versions SET enabled = 1 WHERE version = ?1').bind(before!.version).run();
  const network = vi.fn(async () => { throw new Error('Disable must never call a provider'); });
  vi.stubGlobal('fetch', network);
  const response = await request('POST', '/disable', { expectedVersion: before!.version, enabled: false });
  expect(response.status).toBe(201);
  expect((await response.json() as { data: { version: number; enabled: boolean } }).data).toMatchObject({ version: before!.version + 1, enabled: false });
  const after = await env.DB.prepare('SELECT config_json, notes, created_by, enabled FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{ config_json: string; notes: string; created_by: string; enabled: number }>();
  expect(after).toMatchObject({ config_json: before!.config_json, notes: before!.notes, created_by: 'operator-token', enabled: 0 });
  expect(after!.config_json).not.toContain('fixture-only-key');
  expect(network).not.toHaveBeenCalled();
});

it('disable rejects draft payloads, enabled true, stale versions and concurrent writes', async () => {
  const current = await readConfig();
  expect((await request('POST', '/disable', { expectedVersion: current.version, enabled: false, unified: { apiKey: 'must-not-save' } })).status).toBe(400);
  expect((await request('POST', '/disable', { expectedVersion: current.version, enabled: true })).status).toBe(400);
  expect((await request('POST', '/disable', { enabled: false })).status).toBe(400);
  expect((await request('POST', '/disable', { expectedVersion: current.version - 1, enabled: false })).status).toBe(409);
  const responses = await Promise.all([1, 2].map(() => request('POST', '/disable', { expectedVersion: current.version, enabled: false })));
  expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
  const latest = await readConfig();
  expect(latest.version).toBe(current.version + 1);
  expect(latest.enabled).toBe(false);
  // A stale ordinary save cannot replace the just-disabled version either.
  expect((await request('PUT', '', { ...current.config, expectedVersion: current.version })).status).toBe(409);
});

it('disable requires the existing super-admin or operator authorization and records the actor', async () => {
  const current = await readConfig();
  const body = { expectedVersion: current.version, enabled: false };
  expect((await request('POST', '/disable', body, { 'content-type': 'application/json' })).status).toBe(401);
  for (const role of ['user', 'admin', 'super_admin'] as const) {
    const user = await seedUser();
    await env.DB.prepare('UPDATE auth_accounts SET account_role = ?2, is_admin = ?3 WHERE user_id = ?1').bind(user.userId, role, role === 'user' ? 0 : 1).run();
    const response = await request('POST', '/disable', body, { cookie: authCookie(user.token), 'content-type': 'application/json' });
    expect(response.status).toBe(role === 'super_admin' ? 201 : 403);
    if (role === 'super_admin') {
      const row = await env.DB.prepare('SELECT created_by FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{ created_by: string }>();
      expect(row?.created_by).toBe(user.userId);
    }
  }
});
