import { SELF } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { seedUser, seedProject, authCookie } from './helpers/seed';
import { createAccountInvitation } from '../src/services/accounts';
const oldPassword = 'fixture-original-password-123';
const newPassword = 'fixture-replacement-password-456';
const send = (path: string, body: unknown, cookie?: string, method = 'POST', extra: Record<string, string> = { 'X-Account-Settings': '1' }) => SELF.fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra }, body: JSON.stringify(body) });
async function account() {
  const invite = await createAccountInvitation(env, null);
  const username = 'fixture_' + crypto.randomUUID().slice(0, 8);
  const response = await send('/api/v1/auth/register', { username, password: oldPassword, invitationCode: invite.code });
  expect(response.status).toBe(201);
  return { username, cookie: response.headers.get('set-cookie')!.split(';')[0]!, user: (await response.json() as { data: { user: { id: string } } }).data.user };
}
const session = (cookie: string) => SELF.fetch(BASE + '/api/v1/auth/session', { headers: { cookie } });
beforeEach(async () => { await env.DB.prepare('DELETE FROM auth_password_rate_limits').run(); });
it('updates display name without changing identity or login account', async () => {
  const a = await account();
  const response = await send('/api/v1/auth/profile', { displayName: '  新昵称  ' }, a.cookie, 'PATCH');
  expect(response.status).toBe(200);
  expect((await response.json() as { data: { user: unknown } }).data.user).toMatchObject({ id: a.user.id, username: a.username, displayName: '新昵称' });
  expect((await session(a.cookie)).status).toBe(200);
});
it('rejects unauthenticated, form-like, foreign origin and invalid display names', async () => {
  const a = await account();
  expect((await send('/api/v1/auth/profile', { displayName: 'ok' }, undefined, 'PATCH')).status).toBe(401);
  expect((await send('/api/v1/auth/profile', { displayName: 'ok' }, a.cookie, 'PATCH', {})).status).toBe(403);
  expect((await send('/api/v1/auth/password', { currentPassword: oldPassword, newPassword }, a.cookie, 'POST', { 'X-Account-Settings': '1', origin: 'https://evil.example' })).status).toBe(403);
  for (const displayName of [' ', 'x'.repeat(65), 'control\nname']) expect((await send('/api/v1/auth/profile', { displayName }, a.cookie, 'PATCH')).status).toBe(400);
});
it('wrong current password and weak or unchanged new password leave sessions intact; failures are limited', async () => {
  const a = await account();
  expect((await send('/api/v1/auth/password', { currentPassword: oldPassword, newPassword: 'short' }, a.cookie)).status).toBe(400);
  expect((await send('/api/v1/auth/password', { currentPassword: oldPassword, newPassword: oldPassword }, a.cookie)).status).toBe(400);
  for (let i = 0; i < 4; i++) expect((await send('/api/v1/auth/password', { currentPassword: 'wrong', newPassword }, a.cookie)).status).toBe(400);
  expect((await send('/api/v1/auth/password', { currentPassword: oldPassword, newPassword }, a.cookie)).status).toBe(429);
  expect((await session(a.cookie)).status).toBe(200);
});
it('changes hash, revokes current and other sessions, rejects old password and allows new password', async () => {
  const a = await account();
  const login = await send('/api/v1/auth/sessions', { account: a.username, password: oldPassword });
  const other = login.headers.get('set-cookie')!.split(';')[0]!;
  const response = await send('/api/v1/auth/password', { currentPassword: oldPassword, newPassword }, a.cookie);
  expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  expect((await session(a.cookie)).status).toBe(401); expect((await session(other)).status).toBe(401);
  expect((await send('/api/v1/auth/sessions', { account: a.username, password: oldPassword })).status).toBe(401);
  expect((await send('/api/v1/auth/sessions', { account: a.username, password: newPassword })).status).toBe(201);
  const row = await env.DB.prepare('SELECT password_hash FROM auth_accounts WHERE user_id = ?1').bind(a.user.id).first<{ password_hash: string }>();
  expect(row?.password_hash).toMatch(/^scrypt\$32768\$8\$3\$/); expect(row?.password_hash).not.toContain(newPassword);
});
it('concurrent password changes only accept one verified old password', async () => {
  const a = await account();
  const responses = await Promise.all([newPassword, newPassword + '-other'].map(value => send('/api/v1/auth/password', { currentPassword: oldPassword, newPassword: value }, a.cookie)));
  expect(responses.filter(response => response.status === 200)).toHaveLength(1);
  expect(responses.every(response => [200, 400, 401, 409].includes(response.status))).toBe(true);
});

it('legacy account nickname appears in project members without changing membership', async () => {
  const fixture = await seedUser(); const project = await seedProject(fixture.userId);
  await env.DB.prepare('UPDATE auth_accounts SET username = NULL, username_norm = NULL WHERE user_id = ?1').bind(fixture.userId).run();
  const cookie = authCookie(fixture.token);
  expect((await send('/api/v1/auth/profile', { displayName: '原有成员新昵称' }, cookie, 'PATCH')).status).toBe(200);
  const response = await SELF.fetch(BASE + '/api/v1/projects/' + project + '/members', { headers: { cookie } });
  expect(response.status).toBe(200);
  expect((await response.json() as { data: { items: unknown[] } }).data.items).toEqual(expect.arrayContaining([expect.objectContaining({ userId: fixture.userId, displayName: '原有成员新昵称', role: 'owner' })]));
});
