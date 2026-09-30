import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser } from './helpers/seed';
import { ADMIN_TOKEN } from './helpers/constants';
import type { AccountRole } from '../src/core/account-role';
async function account(role: AccountRole) {
  const u = await seedUser();
  await env.DB.prepare('UPDATE auth_accounts SET account_role = ?2, is_admin = ?3 WHERE user_id = ?1').bind(u.userId, role, role === 'user' ? 0 : 1).run();
  return { ...u, cookie: authCookie(u.token) };
}
function request(path: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(BASE + path, { method: body ? 'PATCH' : 'GET', headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
it('role matrix restricts system configuration and accounts, preserving operational bearer scope', async () => {
  for (const role of ['super_admin', 'admin', 'user'] as const) {
    const u = await account(role);
    expect((await request('/api/v1/admin/accounts', u.cookie)).status).toBe(role === 'user' ? 403 : 200);
    expect((await request('/api/v1/admin/ai-config', u.cookie)).status).toBe(role === 'super_admin' ? 200 : 403);
    expect((await request('/api/v1/admin/account-invitations', u.cookie)).status).toBe(role === 'user' ? 403 : 200);
    const session = await request('/api/v1/auth/session', u.cookie);
    expect((await session.json() as { data: { user: { role: string } } }).data.user.role).toBe(role);
  }
  expect((await request('/api/v1/admin/accounts', undefined, undefined, { authorization: `Bearer ${ADMIN_TOKEN}` })).status).toBe(403);
  expect((await request('/api/v1/admin/ai-config', undefined, undefined, { authorization: `Bearer ${ADMIN_TOKEN}` })).status).toBe(200);
});
it('only super-admin sessions assign roles, persisted sessions immediately lose removed privileges', async () => {
  const owner = await account('super_admin'), admin = await account('admin'), user = await account('user');
  const path = `/api/v1/admin/accounts/${user.userId}/role`;
  for (const actor of [admin, user]) expect((await request(path, actor.cookie, { role: 'super_admin' })).status).toBe(403);
  expect((await request(path, undefined, { role: 'super_admin' }, { authorization: `Bearer ${ADMIN_TOKEN}` })).status).toBe(403);
  expect((await request(path, owner.cookie, { role: 'admin' })).status).toBe(200);
  expect((await request('/api/v1/admin/accounts', user.cookie)).status).toBe(200);
  expect((await request(path, owner.cookie, { role: 'user' })).status).toBe(200);
  expect((await request('/api/v1/admin/accounts', user.cookie)).status).toBe(403);
  const audits = await env.DB.prepare('SELECT actor_id, new_role FROM account_role_audit WHERE target_id = ?1').bind(user.userId).all();
  expect(audits.results).toHaveLength(2);
  expect(audits.results.every(row => row.actor_id === owner.userId)).toBe(true);
});
it('ordinary admins can edit only ordinary users, never credentials or levels through profile input', async () => {
  const owner = await account('super_admin'), admin = await account('admin'), user = await account('user');
  for (const target of [owner, admin]) expect((await request(`/api/v1/admin/accounts/${target.userId}/profile`, admin.cookie, { displayName: 'changed' })).status).toBe(403);
  expect((await request(`/api/v1/admin/accounts/${user.userId}/profile`, admin.cookie, { displayName: 'changed' })).status).toBe(200);
  expect((await request(`/api/v1/admin/accounts/${user.userId}/profile`, admin.cookie, { displayName: 'changed', role: 'super_admin' })).status).toBe(400);
});
it('last super-admin protection survives concurrent self-demotions', async () => {
  await env.DB.prepare("UPDATE auth_accounts SET account_role = 'admin' WHERE account_role = 'super_admin'").run();
  const a = await account('super_admin'), b = await account('super_admin');
  const results = await Promise.all([a, b].map(u => request(`/api/v1/admin/accounts/${u.userId}/role`, u.cookie, { role: 'user' })));
  expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_accounts WHERE account_role = 'super_admin'").first<{ n: number }>())?.n).toBe(1);
});
it('all global roles still require project membership; roles never grant access to others projects', async () => {
  const owner = await account('user'); const project = await seedProject(owner.userId);
  for (const role of ['super_admin', 'admin', 'user'] as const) {
    const outsider = await account(role);
    expect((await request(`/api/v1/projects/${project}`, outsider.cookie)).status).toBe(403);
  }
});
it('invalid roles and credential-less super admins are refused', async () => {
  const owner = await account('super_admin'), target = await account('user');
  const path = `/api/v1/admin/accounts/${target.userId}/role`;
  expect((await request(path, owner.cookie, { role: 'owner' })).status).toBe(400);
  await env.DB.prepare('UPDATE auth_accounts SET password_hash = NULL WHERE user_id = ?1').bind(target.userId).run();
  expect((await request(path, owner.cookie, { role: 'super_admin' })).status).toBe(409);
});

it('explicit user role cannot be elevated by a stale legacy admin flag', async () => {
  const u = await account('user');
  await env.DB.prepare('UPDATE auth_accounts SET is_admin = 1 WHERE user_id = ?1').bind(u.userId).run();
  expect((await request('/api/v1/admin/accounts', u.cookie)).status).toBe(403);
  expect((await request('/api/v1/admin/ai-config', u.cookie)).status).toBe(403);
});

it('an unusable account cannot become a super admin or defeat last usable super protection', async () => {
  await env.DB.prepare("UPDATE auth_accounts SET account_role = 'admin' WHERE account_role = 'super_admin'").run();
  const owner = await account('super_admin'), target = await account('user');
  const path = `/api/v1/admin/accounts/${target.userId}/role`;
  for (const column of ['username', 'username_norm', 'password_hash']) {
    const previous = await env.DB.prepare(`SELECT ${column} AS value FROM auth_accounts WHERE user_id = ?1`).bind(target.userId).first<{ value: string }>();
    await env.DB.prepare(`UPDATE auth_accounts SET ${column} = '' WHERE user_id = ?1`).bind(target.userId).run();
    expect((await request(path, owner.cookie, { role: 'super_admin' })).status).toBe(409);
    await env.DB.prepare(`UPDATE auth_accounts SET ${column} = ?2 WHERE user_id = ?1`).bind(target.userId, previous!.value).run();
  }
  await env.DB.prepare("UPDATE auth_accounts SET account_role = 'super_admin', username_norm = '' WHERE user_id = ?1").bind(target.userId).run();
  expect((await request(`/api/v1/admin/accounts/${owner.userId}/role`, owner.cookie, { role: 'admin' })).status).toBe(409);
});
