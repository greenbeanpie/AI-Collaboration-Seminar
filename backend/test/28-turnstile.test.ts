import { afterEach, expect, it, vi } from 'vitest';
import { env } from './helpers/env';
import { verifyTurnstile } from '../src/services/turnstile';
import { createApp } from '../src/app';
import { consumePasswordRateLimit, createAccountInvitation, loginPasswordAccount, registerPasswordAccount } from '../src/services/accounts';
const config = () => ({ ...env, TURNSTILE_REQUIRED: 'true', TURNSTILE_SITE_KEY: 'public-key', TURNSTILE_SECRET_KEY: 'secret-key', TURNSTILE_HOSTNAMES: 'app.example.test' });
const valid = () => ({ success: true, action: 'login', hostname: 'app.example.test', challenge_ts: new Date().toISOString() });
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
afterEach(() => vi.unstubAllGlobals());
it('allows disabled protection without fetching siteverify', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await verifyTurnstile({ ...config(), TURNSTILE_REQUIRED: 'false' }, undefined, 'login', 'unknown');
  expect(fetch).not.toHaveBeenCalled();
});
it.each([undefined, '', ' ', 'x'.repeat(2049)])('rejects empty or oversized token %# before fetching', async token => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(verifyTurnstile(config(), token, 'login', 'unknown')).rejects.toMatchObject({ status: 403 });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([{ success: false }, { action: 'register' }, { hostname: 'attacker.test' }, { challenge_ts: 'invalid' }, { challenge_ts: new Date(Date.now() - 301_000).toISOString() }, { challenge_ts: new Date(Date.now() + 60_000).toISOString() }])('rejects invalid siteverify result %#', async patch => {
  vi.stubGlobal('fetch', vi.fn(async () => reply({ ...valid(), ...patch })));
  await expect(verifyTurnstile(config(), 'token', 'login', 'unknown')).rejects.toMatchObject({ status: 403 });
});
it('redeems once with trusted IP and rejects subsequent replay from siteverify', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(reply(valid())).mockResolvedValueOnce(reply({ success: false, 'error-codes': ['timeout-or-duplicate'] })); vi.stubGlobal('fetch', fetch);
  await verifyTurnstile(config(), 'token', 'login', '192.0.2.1');
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, request] = fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  expect(new URLSearchParams(String(request.body)).get('remoteip')).toBe('192.0.2.1');
  await expect(verifyTurnstile(config(), 'token', 'login', 'unknown')).rejects.toMatchObject({ status: 403 });
});
it.each(['network', 'http', 'json'])('fails closed for %s upstream errors', async kind => {
  vi.stubGlobal('fetch', vi.fn(async () => { if (kind === 'network') throw new DOMException('Timed out', 'TimeoutError'); return kind === 'http' ? reply({}, 503) : new Response('not-json'); }));
  await expect(verifyTurnstile(config(), 'token', 'login', 'unknown')).rejects.toMatchObject({ status: 403 });
});
it('rejects absent hostname config and production loopback before fetching', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(verifyTurnstile({ ...config(), TURNSTILE_HOSTNAMES: '' }, 'token', 'login', 'unknown')).rejects.toMatchObject({ status: 403 });
  await expect(verifyTurnstile({ ...config(), ENV_NAME: 'production', TURNSTILE_HOSTNAMES: 'localhost' }, 'token', 'login', 'unknown')).rejects.toMatchObject({ status: 403 });
  expect(fetch).not.toHaveBeenCalled();
});
it('consumes limits before verification and does not create sessions on failure', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply({ success: false })));
  const account = `turnstile-${crypto.randomUUID()}`;
  const before = await env.DB.prepare('SELECT COUNT(*) AS count FROM sessions').first<{ count: number }>();
  await expect(loginPasswordAccount(config(), { account, password: 'wrong-password', turnstileToken: 'invalid' }, account)).rejects.toMatchObject({ status: 403 });
  await expect(registerPasswordAccount(config(), { username: account, password: 'long-test-password', invitationCode: 'ABCD1234EFGH5678', turnstileToken: 'invalid' }, account)).rejects.toMatchObject({ status: 403 });
  const after = await env.DB.prepare('SELECT COUNT(*) AS count FROM sessions').first<{ count: number }>();
  expect(after?.count).toBe(before?.count);
  const limits = await env.DB.prepare('SELECT COUNT(*) AS count FROM auth_password_rate_limits WHERE attempts = 1').first<{ count: number }>();
  expect(limits!.count).toBeGreaterThanOrEqual(3);
});

it('HTTP capabilities publishes protection and registration requires a fresh correct action', async () => {
  const app = createApp(); const bindings = config();
  const capabilities = await app.fetch(new Request('https://app.example.test/api/v1/capabilities'), bindings);
  expect((await capabilities.json() as { data: { authentication: unknown } }).data.authentication).toMatchObject({ turnstileRequired: true, turnstileSiteKey: 'public-key' });
  const invitation = await createAccountInvitation(env, null);
  const body = { username: `verify_${crypto.randomUUID().slice(0, 8)}`, password: 'long-unique-test-password', invitationCode: invitation.code };
  const request = (token?: string) => app.fetch(new Request('https://app.example.test/api/v1/auth/register', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': crypto.randomUUID() }, body: JSON.stringify({ ...body, ...(token ? { turnstileToken: token } : {}) }) }), bindings);
  expect((await request()).status).toBe(403);
  const unused = await env.DB.prepare('SELECT used_at FROM account_invitations WHERE id = ?1').bind(invitation.id).first<{ used_at: string | null }>();
  expect(unused?.used_at).toBeNull();
  vi.stubGlobal('fetch', vi.fn(async () => reply({ ...valid(), action: 'register' })));
  const registered = await request('fresh-register-token');
  expect(registered.status).toBe(201);
  expect(registered.headers.get('set-cookie')).toContain('HttpOnly');
});
it('exhausted rate limit stops before the external verification call', async () => {
  const ip = crypto.randomUUID();
  for (let attempt = 0; attempt < 30; attempt++) await consumePasswordRateLimit(env, 'login-ip', ip, 30, 3600);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(loginPasswordAccount(config(), { account: ip, password: 'password', turnstileToken: 'token' }, ip)).rejects.toMatchObject({ status: 429 });
  expect(fetch).not.toHaveBeenCalled();
});
