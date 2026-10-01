import { SELF } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { ADMIN_TOKEN } from './helpers/constants';
import { authCookie, seedUser } from './helpers/seed';
import { diagnosticErrorCode, readAiDiagnostics, recordAiDiagnostic, type DiagnosticInput } from '../src/ai/diagnostics';

const event: DiagnosticInput = { requestId: 'e4cc34b8-b74c-4719-bef0-a716055aa5cb', operation: 'config_save', phase: 'request_finished', status: 'failed', durationMs: 42, errorCode: 'VERSION_CONFLICT', httpStatus: 409, configVersion: 3, expectedVersion: 2 };
const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };
afterEach(() => vi.unstubAllGlobals());

it('diagnostics writes and reads only fixed, content-free fields and never raw exceptions', async () => {
  await env.DB.prepare('DELETE FROM ai_diagnostics').run();
  const input = { ...event, requestId: 'private-key-in-invalid-id', apiKey: 'private-key', ciphertext: 'private-ciphertext', prompt: 'private-prompt', response: 'private-response', headers: { authorization: 'private-token' }, profile: 'private-profile', error: 'private-stack' };
  expect(await recordAiDiagnostic(env, input as DiagnosticInput)).toBe(true);
  const row = await env.DB.prepare('SELECT entry_json, byte_size FROM ai_diagnostics ORDER BY id DESC LIMIT 1').first<{ entry_json: string; byte_size: number }>();
  expect(row!.entry_json).not.toMatch(/private-|apiKey|ciphertext|prompt|response|headers|profile|stack/);
  expect(row!.byte_size).toBe(new TextEncoder().encode(row!.entry_json).byteLength + 1);
  const report = await readAiDiagnostics(env);
  expect(report.items[0]).toMatchObject({ operation: 'config_save', errorCode: 'VERSION_CONFLICT', durationMs: 42 });
  expect(report.items[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(diagnosticErrorCode(new Error('private-secret-exception'))).toBe('INTERNAL');
});

it('concurrent atomic writers retain the newest 1000 records and the byte ceiling', async () => {
  await env.DB.prepare('DELETE FROM ai_diagnostics').run();
  const json = JSON.stringify({ ...event, timestamp: '2026-10-01T11:00:00.000Z' });
  const bytes = new TextEncoder().encode(json).byteLength + 1;
  await env.DB.prepare('WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 1000) INSERT INTO ai_diagnostics(entry_json,byte_size) SELECT ?1,?2 FROM n').bind(json, bytes).run();
  const ids = Array.from({ length: 12 }, () => crypto.randomUUID());
  const outcomes = await Promise.all(ids.map(requestId => recordAiDiagnostic(env, { ...event, requestId })));
  expect(outcomes.every(Boolean)).toBe(true);
  const stats = await env.DB.prepare('SELECT COUNT(*) AS count, SUM(byte_size) AS bytes FROM ai_diagnostics').first<{ count: number; bytes: number }>();
  expect(stats?.count).toBe(1000);
  expect(stats!.bytes).toBeLessThanOrEqual(1_000_000);
  const report = await readAiDiagnostics(env);
  for (const id of ids) expect(report.items.some(entry => entry.requestId === id)).toBe(true);
});

it('UTF-8 byte retention trims below 1MB independently of the 1000-record bound', async () => {
  await env.DB.prepare('DELETE FROM ai_diagnostics').run();
  // Seed a historical oversized UTF-8 representation to exercise the independent
  // byte bound. Unknown fields are also stripped by the read-side allowlist.
  const json = JSON.stringify({ ...event, timestamp: '2026-10-01T11:00:00.000Z', padding: '中'.repeat(5000) });
  const bytes = new TextEncoder().encode(json).byteLength + 1;
  expect(bytes).toBeGreaterThan(json.length + 5000);
  await env.DB.prepare('WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 120) INSERT INTO ai_diagnostics(entry_json,byte_size) SELECT ?1,?2 FROM n').bind(json, bytes).run();
  expect(await recordAiDiagnostic(env, event)).toBe(true);
  const stats = await env.DB.prepare('SELECT COUNT(*) AS count, SUM(byte_size) AS bytes FROM ai_diagnostics').first<{ count: number; bytes: number }>();
  expect(stats!.count).toBeLessThan(120);
  expect(stats!.bytes).toBeLessThanOrEqual(1_000_000);
  const report = await readAiDiagnostics(env);
  expect(JSON.stringify(report)).not.toContain('padding');
  expect(new TextEncoder().encode(JSON.stringify(report)).byteLength).toBeLessThanOrEqual(1_000_000);
});

it('only a super-admin session can read diagnostics; operator and other roles are denied with no-store', async () => {
  const path = `${BASE}/api/v1/admin/ai-diagnostics`;
  const anonymous = await SELF.fetch(path);
  expect(anonymous.status).toBe(401); expect(anonymous.headers.get('cache-control')).toBe('no-store');
  const operator = await SELF.fetch(path, { headers });
  expect(operator.status).toBe(403); expect(operator.headers.get('cache-control')).toBe('no-store');
  for (const role of ['user', 'admin', 'super_admin'] as const) {
    const user = await seedUser();
    await env.DB.prepare('UPDATE auth_accounts SET account_role=?2,is_admin=?3 WHERE user_id=?1').bind(user.userId, role, role === 'user' ? 0 : 1).run();
    const response = await SELF.fetch(path, { headers: { cookie: authCookie(user.token) } });
    expect(response.status).toBe(role === 'super_admin' ? 200 : 403);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
});

it('save conflict logs fixed request-correlated phases and a safe current version, never the request draft', async () => {
  await env.DB.prepare('DELETE FROM ai_diagnostics').run();
  const currentResponse = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { headers });
  const current = (await currentResponse.json() as { data: { version: number; config: Record<string, unknown> } }).data;
  const requestId = crypto.randomUUID();
  const response = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { method: 'PUT', headers: { ...headers, 'x-request-id': requestId }, body: JSON.stringify({ ...current.config, expectedVersion: current.version - 1, notes: 'private-draft-note' }) });
  expect(response.status).toBe(409);
  const report = await readAiDiagnostics(env);
  const events = report.items.filter(entry => entry.requestId === requestId);
  expect(events.map(entry => entry.phase)).toContain('request_started');
  expect(events.find(entry => entry.phase === 'request_finished')).toMatchObject({ status: 'failed', errorCode: 'VERSION_CONFLICT', httpStatus: 409, configVersion: current.version });
  expect(JSON.stringify(report)).not.toContain('private-draft-note');
});

it('failed probes are diagnosed without recording model responses, prompts, keys or private error text', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('private-provider-failure', { status: 500 })));
  const requestId = crypto.randomUUID();
  const response = await SELF.fetch(`${BASE}/api/v1/admin/ai-config/probe`, { method: 'POST', headers: { ...headers, 'x-request-id': requestId }, body: JSON.stringify({ purpose: 'textEconomy' }) });
  expect(response.status).toBe(200);
  const report = await readAiDiagnostics(env);
  expect(report.items.filter(entry => entry.requestId === requestId).find(entry => entry.phase === 'probe_result')).toMatchObject({ status: 'failed', errorCode: 'PROBE_FAILED', purpose: 'textEconomy' });
  expect(JSON.stringify(report)).not.toMatch(/private-provider|prompt|apiKey|authorization|ciphertext|你好/);
});

it('diagnostics storage failures cannot replace either a successful save or its real CAS error', async () => {
  const response = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { headers });
  const current = (await response.json() as { data: { version: number; config: Record<string, unknown> } }).data;
  await env.DB.prepare('ALTER TABLE ai_diagnostics RENAME TO ai_diagnostics_unavailable').run();
  try {
    const save = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { method: 'PUT', headers, body: JSON.stringify({ ...current.config, expectedVersion: current.version }) });
    expect(save.status).toBe(201);
    const conflict = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { method: 'PUT', headers, body: JSON.stringify({ ...current.config, expectedVersion: current.version }) });
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as { error: { code: string } }).error.code).toBe('VERSION_CONFLICT');
  } finally {
    await env.DB.prepare('ALTER TABLE ai_diagnostics_unavailable RENAME TO ai_diagnostics').run();
  }
});
