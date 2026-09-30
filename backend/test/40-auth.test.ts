import { SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { ADMIN_TOKEN } from './helpers/constants';
import { consumePasswordRateLimit, createAccountInvitation } from '../src/services/accounts';
import { createApp } from '../src/app';
import type { Env } from '../src/env';

const PASSWORD = 'fixture-password-very-long-123';
const post = (path: string, body: unknown, cookie?: string) => SELF.fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const get = (path: string, cookie?: string) => SELF.fetch(BASE + path, { headers: cookie ? { cookie } : {} });
async function invitation() { return createAccountInvitation(env, null); }
async function register(username: string, email?: string | null) { const invite = await invitation(); return post('/api/v1/auth/register', { username, password: PASSWORD, invitationCode: invite.code, email }); }
beforeEach(async () => { await env.DB.prepare('DELETE FROM auth_password_rate_limits').run(); });
afterEach(() => vi.unstubAllGlobals());

describe('Password account authentication', () => {
  it('no-email registration returns null contact, password login reuses identity and logout revokes session', async () => {
    const res = await register('No_Email_Account'); expect(res.status).toBe(201);
    const user = (await res.json() as { data: { user: { id: string; username: string; email: string | null; isAdmin: boolean } } }).data.user;
    expect(user).toMatchObject({ username: 'No_Email_Account', email: null, isAdmin: false });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Lax');
    const db = await env.DB.prepare('SELECT u.email, a.password_hash, a.contact_email, a.email_verified FROM users u JOIN auth_accounts a ON a.user_id = u.id WHERE u.id = ?1').bind(user.id).first<{ email: string; password_hash: string; contact_email: string | null; email_verified: number }>();
    expect(db?.email).toBe(`account:${user.id}`); expect(db?.contact_email).toBeNull(); expect(db?.email_verified).toBe(0);
    expect(db?.password_hash).toMatch(/^scrypt\$32768\$8\$3\$/); expect(db?.password_hash).not.toContain(PASSWORD);
    const login = await post('/api/v1/auth/sessions', { account: 'no_email_account', password: PASSWORD }); expect(login.status).toBe(201);
    expect((await login.json() as { data: { user: { id: string } } }).data.user.id).toBe(user.id);
    const sessionCookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await get('/api/v1/auth/session', sessionCookie)).status).toBe(200);
    const logout = await SELF.fetch(BASE + '/api/v1/auth/session', { method: 'DELETE', headers: { cookie: sessionCookie } }); expect(logout.status).toBe(200);
    expect((await get('/api/v1/auth/session', sessionCookie)).status).toBe(401);
  });

  it('optional email is a contact login alias, never automatically verified', async () => {
    const res = await register('contact_account', 'Person@Example.test'); expect(res.status).toBe(201);
    const user = (await res.json() as { data: { user: { id: string; email: string } } }).data.user;
    expect(user.email).toBe('person@example.test');
    expect((await env.DB.prepare('SELECT email_verified FROM auth_accounts WHERE user_id = ?1').bind(user.id).first<{ email_verified: number }>())?.email_verified).toBe(0);
    const login = await post('/api/v1/auth/sessions', { account: 'PERSON@example.TEST', password: PASSWORD }); expect(login.status).toBe(201);
    expect((await login.json() as { data: { user: { id: string } } }).data.user.id).toBe(user.id);
  });

  it('wrong password and unknown account return the same generic failure', async () => {
    await register('known_account');
    for (const account of ['known_account', 'missing_account']) {
      const res = await post('/api/v1/auth/sessions', { account, password: 'wrong-password-123' }); expect(res.status).toBe(401);
      expect((await res.json() as { error: { code: string; message: string } }).error).toMatchObject({ code: 'UNAUTHENTICATED', message: '账号或密码错误' });
    }
  });

  it('registration requires an unused 16-character code and 12+ character password', async () => {
    const invite = await invitation();
    for (const fields of [{ password: 'short' }, { invitationCode: 'short' }, { username: 'ab' }, { username: 'with@email' }]) {
      expect((await post('/api/v1/auth/register', { username: 'valid_name', password: PASSWORD, invitationCode: invite.code, ...fields })).status).toBe(400);
    }
    expect((await env.DB.prepare('SELECT used_at FROM account_invitations WHERE id = ?1').bind(invite.id).first<{ used_at: string | null }>())?.used_at).toBeNull();
  });

  it('concurrent registration consumes one invitation only once', async () => {
    const invite = await invitation();
    const results = await Promise.all(['race_one', 'race_two'].map(username => post('/api/v1/auth/register', { username, password: PASSWORD, invitationCode: invite.code })));
    expect(results.map(res => res.status).sort()).toEqual([201, 400]);
    const row = await env.DB.prepare('SELECT used_at, used_by FROM account_invitations WHERE id = ?1').bind(invite.id).first<{ used_at: string; used_by: string }>();
    expect(row?.used_by).toBeTruthy();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_accounts WHERE username_norm IN ('race_one', 'race_two')").first<{ n: number }>())?.n).toBe(1);
  });

  it('username/email conflicts do not consume an invitation or bind the existing account', async () => {
    await register('occupied_name', 'occupied@example.test'); const invite = await invitation();
    expect((await post('/api/v1/auth/register', { username: 'OCCUPIED_NAME', password: PASSWORD, invitationCode: invite.code })).status).toBe(409);
    expect((await post('/api/v1/auth/register', { username: 'other_name', email: 'OCCUPIED@example.test', password: PASSWORD, invitationCode: invite.code })).status).toBe(409);
    expect((await env.DB.prepare('SELECT used_at FROM account_invitations WHERE id = ?1').bind(invite.id).first<{ used_at: string | null }>())?.used_at).toBeNull();
    expect((await post('/api/v1/auth/register', { username: 'fresh_account', password: PASSWORD, invitationCode: invite.code })).status).toBe(201);
  });

  it('concurrent username conflict consumes only the winning invitation', async () => {
    const invitations = await Promise.all([invitation(), invitation()]);
    const results = await Promise.all(invitations.map(invite => post('/api/v1/auth/register', { username: 'same_concurrent_name', email: 'same_concurrent@example.test', password: PASSWORD, invitationCode: invite.code })));
    expect(results.map(res => res.status).sort()).toEqual([201, 409]);
    const used = await env.DB.prepare('SELECT used_at FROM account_invitations WHERE id IN (?1, ?2)').bind(invitations[0]!.id, invitations[1]!.id).all<{ used_at: string | null }>();
    expect(used.results.filter(row => row.used_at !== null)).toHaveLength(1);
    expect(used.results.filter(row => row.used_at === null)).toHaveLength(1);
  });

  it('registration does not bind or claim a legacy user by matching contact email', async () => {
    const legacy = await seedUser('legacy@example.test'); const pid = await seedProject(legacy.userId);
    await env.DB.prepare('UPDATE auth_accounts SET username = NULL, username_norm = NULL, password_hash = NULL WHERE user_id = ?1').bind(legacy.userId).run();
    const invite = await invitation();
    expect((await post('/api/v1/auth/register', { username: 'legacy_claim', email: legacy.email, password: PASSWORD, invitationCode: invite.code })).status).toBe(409);
    expect((await env.DB.prepare('SELECT used_at FROM account_invitations WHERE id = ?1').bind(invite.id).first<{ used_at: string | null }>())?.used_at).toBeNull();
    expect((await env.DB.prepare('SELECT password_hash FROM auth_accounts WHERE user_id = ?1').bind(legacy.userId).first<{ password_hash: string | null }>())?.password_hash).toBeNull();
    expect((await env.DB.prepare('SELECT created_by FROM projects WHERE id = ?1').bind(pid).first<{ created_by: string }>())?.created_by).toBe(legacy.userId);
  });

  it('login and registration endpoints enforce persistent limits before costly password work', async () => {
    const identity = 'limited_account';
    for (let i = 0; i < 10; i++) await consumePasswordRateLimit(env, 'login-account', identity, 10, 900);
    expect((await post('/api/v1/auth/sessions', { account: identity, password: PASSWORD })).status).toBe(429);
    for (let i = 0; i < 10; i++) await consumePasswordRateLimit(env, 'register-ip', 'unknown', 10, 3600);
    const invite = await invitation();
    expect((await post('/api/v1/auth/register', { username: 'limited_registration', password: PASSWORD, invitationCode: invite.code })).status).toBe(429);
    expect((await env.DB.prepare('SELECT used_at FROM account_invitations WHERE id = ?1').bind(invite.id).first<{ used_at: string | null }>())?.used_at).toBeNull();
  });

  it('project/member DTOs never expose the internal opaque users.email key', async () => {
    const res = await register('member_no_email'); const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const user = (await res.json() as { data: { user: { id: string } } }).data.user; const pid = await seedProject(user.id);
    for (const path of [`/api/v1/projects/${pid}/members`, `/api/v1/projects/${pid}/members/me`]) {
      const response = await get(path, cookie); expect(response.status).toBe(200); const text = await response.text();
      expect(text).not.toContain('account:'); const data = JSON.parse(text).data; const member = data.items?.[0] ?? data;
      expect(member).toMatchObject({ email: null, username: 'member_no_email', isAdmin: false });
    }
  });

  it('persistent atomic rate limits permit exactly the allowance under concurrent requests', async () => {
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => consumePasswordRateLimit(env, 'test-login-account', 'private-account', 5, 900)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(5);
    expect((await env.DB.prepare('SELECT SUM(attempts) AS n FROM auth_password_rate_limits').first<{ n: number }>())?.n).toBe(5);
    const rows = await env.DB.prepare('SELECT bucket_key FROM auth_password_rate_limits').all<{ bucket_key: string }>();
    expect(JSON.stringify(rows)).not.toContain('private-account');
  });

  it('legacy OTP sessions cannot access projects or admin even after account promotion', async () => {
    const seeded = await seedUser(); const pid = await seedProject(seeded.userId);
    await env.DB.batch([env.DB.prepare("UPDATE sessions SET auth_method = 'legacy' WHERE user_id = ?1").bind(seeded.userId), env.DB.prepare('UPDATE auth_accounts SET is_admin = 1 WHERE user_id = ?1').bind(seeded.userId)]);
    expect((await get('/api/v1/auth/session', authCookie(seeded.token))).status).toBe(401);
    expect((await get(`/api/v1/projects/${pid}`, authCookie(seeded.token))).status).toBe(401);
    expect((await get('/api/v1/admin/account-invitations', authCookie(seeded.token))).status).toBe(401);
    expect((await env.DB.prepare('SELECT created_by FROM projects WHERE id = ?1').bind(pid).first<{ created_by: string }>())?.created_by).toBe(seeded.userId);
  });

  it('system admin password session can generate codes; project owner cannot; list never returns codes/hashes', async () => {
    const owner = await seedUser(); await seedProject(owner.userId);
    expect((await post('/api/v1/admin/account-invitations', {}, authCookie(owner.token))).status).toBe(403);
    await env.DB.prepare('UPDATE auth_accounts SET is_admin = 1 WHERE user_id = ?1').bind(owner.userId).run();
    const created = await post('/api/v1/admin/account-invitations', {}, authCookie(owner.token)); expect(created.status).toBe(201);
    const data = (await created.json() as { data: { id: string; code: string; createdAt: string } }).data; expect(data.code).toMatch(/^[A-Z0-9]{16}$/);
    const stored = await env.DB.prepare('SELECT code_hash FROM account_invitations WHERE id = ?1').bind(data.id).first<{ code_hash: string }>(); expect(stored?.code_hash).not.toBe(data.code); expect(stored?.code_hash).toHaveLength(64);
    const listed = await get('/api/v1/admin/account-invitations', authCookie(owner.token)); const text = await listed.text(); expect(text).not.toContain(data.code); expect(text).not.toContain(stored!.code_hash);
    expect((await get('/api/v1/admin/ai-config', authCookie(owner.token))).status).toBe(403);
    const operator = await SELF.fetch(BASE + '/api/v1/admin/account-invitations', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' }, body: '{}' }); expect(operator.status).toBe(201);
  });

  it('OTP is disabled in every environment regardless of old mail/allowlist configuration', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    for (const environment of ['local', 'staging', 'production'] as const) {
      const response = await createApp().fetch(new Request(BASE + '/api/v1/auth/challenges', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test' }) }), { ...env, ENV_NAME: environment } as Env);
      expect(response.status).toBe(410);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect((await post('/api/v1/auth/sessions', { email: 'owner@example.test', challengeId: crypto.randomUUID(), code: '123456' })).status).toBe(400);
  });

  it('write origin validation still protects password login/register', async () => {
    const response = await SELF.fetch(BASE + '/api/v1/auth/sessions', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ account: 'user', password: PASSWORD }) }); expect(response.status).toBe(403);
  });
});
