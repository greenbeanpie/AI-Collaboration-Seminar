import { beforeEach, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { registerPasswordRecoveryRoutes } from '../src/api/password-recovery';
import { env, BASE } from './helpers/env';
import { seedUser, seedProject, authCookie } from './helpers/seed';
import { sha256Hex } from '../src/core/db';
import { verifyPassword } from '../src/services/password';

const app = createApp(); registerPasswordRecoveryRoutes(app);
const send = (path: string, body: unknown, cookie?: string, headers: Record<string, string> = {}) => app.request(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) }, env);
const replacement = 'new-recovery-password-123456';
async function setup() {
  const actor = await seedUser(), target = await seedUser();
  await env.DB.prepare("UPDATE auth_accounts SET account_role='super_admin',is_admin=1 WHERE user_id=?1").bind(actor.userId).run();
  return { actor, target };
}
async function issue(actor: Awaited<ReturnType<typeof seedUser>>, userId: string) {
  const response = await send(`/api/v1/admin/accounts/${userId}/password-recovery`, { reason: '已通过线下身份及原项目归属人工核实', ownershipVerified: true }, authCookie(actor.token), { 'X-Password-Recovery': '1' });
  expect(response.status).toBe(201);
  return (await response.json() as { data: { id: string; token: string; expiresAt: string } }).data;
}
beforeEach(async () => { await env.DB.prepare('DELETE FROM auth_password_rate_limits').run(); });
it('requires super-admin password session, confirmation and recorded ownership reason', async () => {
  const { actor, target } = await setup(), path = `/api/v1/admin/accounts/${target.userId}/password-recovery`;
  const body = { reason: '人工核实账户归属后允许恢复', ownershipVerified: true };
  expect((await send(path, body, undefined, { authorization: 'Bearer test-admin-token', 'X-Password-Recovery': '1' })).status).toBeGreaterThanOrEqual(400);
  expect((await send(path, body, authCookie(target.token), { 'X-Password-Recovery': '1' })).status).toBe(403);
  await env.DB.prepare("UPDATE auth_accounts SET account_role='admin',is_admin=1 WHERE user_id=?1").bind(actor.userId).run();
  expect((await send(path, body, authCookie(actor.token), { 'X-Password-Recovery': '1' })).status).toBe(403);
  await env.DB.prepare("UPDATE auth_accounts SET account_role='super_admin' WHERE user_id=?1").bind(actor.userId).run();
  expect((await send(path, body, authCookie(actor.token))).status).toBe(403);
  expect((await send(path, { reason: 'short', ownershipVerified: false }, authCookie(actor.token), { 'X-Password-Recovery': '1' })).status).toBe(400);
});
it('stores only token hash and audit reason; one atomic redemption changes password and revokes sessions while preserving projects', async () => {
  const { actor, target } = await setup(), project = await seedProject(target.userId);
  const recovery = await issue(actor, target.userId), other = await issue(actor, target.userId);
  expect(recovery.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const record = await env.DB.prepare('SELECT * FROM password_recovery_tokens WHERE id=?1').bind(recovery.id).first();
  expect(record?.token_hash).toBe(await sha256Hex(recovery.token)); expect(JSON.stringify(record)).not.toContain(recovery.token);
  expect(record?.reason).toContain('人工核实');
  const responses = await Promise.all([replacement, replacement + '-other'].map(newPassword => send('/api/v1/auth/password-recovery/redeem', { token: recovery.token, newPassword })));
  expect(responses.filter(response => response.status === 200)).toHaveLength(1);
  expect(responses.find(response => response.status === 200)?.headers.get('set-cookie')).toContain('Max-Age=0');
  expect((await send('/api/v1/auth/password-recovery/redeem', { token: other.token, newPassword: replacement })).status).toBe(400);
  const hash = (await env.DB.prepare('SELECT password_hash FROM auth_accounts WHERE user_id=?1').bind(target.userId).first<{ password_hash: string }>())!.password_hash;
  expect(await verifyPassword(replacement, hash) || await verifyPassword(replacement + '-other', hash)).toBe(true);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?1 AND revoked_at IS NULL').bind(target.userId).first<{ n: number }>())?.n).toBe(0);
  expect((await env.DB.prepare('SELECT id FROM projects WHERE id=?1').bind(project).first())?.id).toBe(project);
});
it('expiry, unknown token and password change produce generic refusal without consuming valid unrelated tokens', async () => {
  const { actor, target } = await setup(), recovery = await issue(actor, target.userId);
  await env.DB.prepare("UPDATE password_recovery_tokens SET expires_at='2000-01-01' WHERE id=?1").bind(recovery.id).run();
  const expired = await send('/api/v1/auth/password-recovery/redeem', { token: recovery.token, newPassword: replacement });
  const unknown = await send('/api/v1/auth/password-recovery/redeem', { token: 'a'.repeat(43), newPassword: replacement });
  expect(expired.status).toBe(400); expect(unknown.status).toBe(400);
  expect((await expired.json() as { error: { message: string } }).error.message).toBe((await unknown.json() as { error: { message: string } }).error.message);
  const stale = await issue(actor, target.userId);
  await env.DB.prepare("UPDATE auth_accounts SET password_hash='changed' WHERE user_id=?1").bind(target.userId).run();
  expect((await send('/api/v1/auth/password-recovery/redeem', { token: stale.token, newPassword: replacement })).status).toBe(400);
  expect((await env.DB.prepare('SELECT used_at FROM password_recovery_tokens WHERE id=?1').bind(stale.id).first())?.used_at).toBeNull();
});
it('limits anonymous guessing and never returns target account information', async () => {
  for (let index = 0; index < 20; index++) {
    const response = await send('/api/v1/auth/password-recovery/redeem', { token: 'invalid-' + index, newPassword: replacement });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('user_id');
  }
  expect((await send('/api/v1/auth/password-recovery/redeem', { token: 'invalid-next', newPassword: replacement })).status).toBe(429);
});
