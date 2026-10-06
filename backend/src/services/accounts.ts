import { purposeSecret } from '../ai/secrets';
import { accountRole, type AccountRole } from '../core/account-role';
import type { Env, SessionUser } from '../env';
import { hmacSha256Hex, newId, nowIso, sha256Hex } from '../core/db';
import { invalidState, rateLimited, unauthenticated, validationFailed } from '../core/errors';
import { LIMITS } from '../core/limits';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password';

export const SESSION_TTL_SECONDS = LIMITS.sessionTtlDays * 86_400;
export const normalizeUsername = (value: string): string => value.trim().toLowerCase();
export const normalizeEmail = (value: string | null | undefined): string | null => value?.trim().toLowerCase() || null;

/** Persistent atomic fixed-window allowance; no plaintext account names or client IPs stored. */
export async function consumePasswordRateLimit(env: Env, scope: string, identity: string, limit: number, seconds: number): Promise<void> {
  await env.DB.prepare('DELETE FROM auth_password_rate_limits WHERE bucket_key IN (SELECT bucket_key FROM auth_password_rate_limits WHERE expires_at <= ?1 LIMIT 100)').bind(nowIso()).run();
  const window = Math.floor(Date.now() / (seconds * 1000));
  const message = `${scope}|${identity.toLowerCase()}|${window}`;
  const legacyKey = await hmacSha256Hex(env.AUTH_SECRET, message);
  // Honor an existing legacy window until expiry; no fresh allowance on upgrade.
  const legacy = await env.DB.prepare('SELECT attempts FROM auth_password_rate_limits WHERE bucket_key = ?1').bind(legacyKey).first();
  const key = legacy ? legacyKey : await hmacSha256Hex(await purposeSecret(env, 'rate-limit'), message);
  const expiresAt = new Date((window + 1) * seconds * 1000).toISOString();
  const claim = await env.DB.prepare(`INSERT INTO auth_password_rate_limits (bucket_key, attempts, expires_at) VALUES (?1, 1, ?2)
    ON CONFLICT (bucket_key) DO UPDATE SET attempts = attempts + 1 WHERE attempts < ?3 RETURNING attempts`)
    .bind(key, expiresAt, limit).first<{ attempts: number }>();
  if (!claim) throw rateLimited('认证请求过于频繁，请稍后重试', { retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000)) });
}

async function sessionValues(userId: string) {
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return { id: newId(), userId, token, hash: await sha256Hex(token), expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(), createdAt: nowIso() };
}

export async function registerPasswordAccount(env: Env, input: { username: string; password: string; invitationCode: string; email?: string | null }, ip: string): Promise<{ user: SessionUser; token: string }> {
  await consumePasswordRateLimit(env, 'register-ip', ip, 10, 3600);
  const username = input.username.trim(); const usernameNorm = normalizeUsername(username); const email = normalizeEmail(input.email);
  const codeHash = await sha256Hex(input.invitationCode.trim().toUpperCase());
  const invitation = await env.DB.prepare('SELECT id FROM account_invitations WHERE code_hash = ?1 AND used_at IS NULL').bind(codeHash).first();
  if (!invitation) throw validationFailed('邀请码无效或已经使用');
  const existing = await env.DB.prepare('SELECT user_id FROM auth_accounts WHERE username_norm = ?1 OR (?2 IS NOT NULL AND lower(contact_email) = ?2)').bind(usernameNorm, email).first();
  if (existing) throw invalidState('用户名或邮箱已被使用');
  const passwordHash = await hashPassword(input.password);
  const userId = newId(); const session = await sessionValues(userId); const now = session.createdAt;
  // Legacy users.email is an internal opaque identity key for NEW users, never contact information.
  // Both account insertion and single-use consumption depend on the same successful user insertion.
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, email, display_name, created_at, last_login_at)
      SELECT ?1, ?2, ?3, ?4, ?4
       WHERE EXISTS (SELECT 1 FROM account_invitations WHERE code_hash = ?5 AND used_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM auth_accounts WHERE username_norm = ?6 OR (?7 IS NOT NULL AND lower(contact_email) = ?7))`)
      .bind(userId, `account:${userId}`, username, now, codeHash, usernameNorm, email),
    env.DB.prepare(`INSERT INTO auth_accounts (user_id, username, username_norm, contact_email, contact_email_norm, password_hash, is_admin, account_role, created_at)
      SELECT ?1, ?2, ?3, ?4, ?4, ?5, 0, 'user', ?6 WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1)`)
      .bind(userId, username, usernameNorm, email, passwordHash, now),
    env.DB.prepare(`UPDATE account_invitations SET used_at = ?2, used_by = ?3 WHERE code_hash = ?1 AND used_at IS NULL AND EXISTS (SELECT 1 FROM auth_accounts WHERE user_id = ?3)`)
      .bind(codeHash, now, userId),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, auth_method)
      SELECT ?1, ?2, ?3, ?4, ?5, 'password' WHERE EXISTS (SELECT 1 FROM auth_accounts WHERE user_id = ?2)`)
      .bind(session.id, userId, session.hash, session.expiresAt, now),
  ]);
  if ((result[0]?.meta?.changes ?? 0) !== 1) {
    const conflict = await env.DB.prepare('SELECT user_id FROM auth_accounts WHERE username_norm = ?1 OR (?2 IS NOT NULL AND lower(contact_email) = ?2)').bind(usernameNorm, email).first();
    if (conflict) throw invalidState('用户名或邮箱已被使用');
    throw validationFailed('邀请码无效或已经使用');
  }
  return { user: { id: userId, username, email, displayName: username, role: 'user', isAdmin: false }, token: session.token };
}

export async function loginPasswordAccount(env: Env, input: { account: string; password: string }, ip: string): Promise<{ user: SessionUser; token: string }> {
  const identity = input.account.trim().toLowerCase();
  await consumePasswordRateLimit(env, 'login-ip', ip, 30, 3600);
  await consumePasswordRateLimit(env, 'login-account', identity, 10, 900);
  const row = await env.DB.prepare(`SELECT a.user_id, a.username, a.contact_email, a.password_hash, a.is_admin, a.account_role, u.display_name
    FROM auth_accounts a JOIN users u ON u.id = a.user_id
    WHERE (a.username_norm = ?1 OR a.contact_email_norm = ?1) AND a.password_hash IS NOT NULL`)
    .bind(identity).first<{ user_id: string; username: string | null; contact_email: string | null; password_hash: string; is_admin: number; account_role: AccountRole | null; display_name: string }>();
  const valid = await verifyPassword(input.password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || !valid) throw unauthenticated('账号或密码错误');
  const session = await sessionValues(row.user_id);
  const result = await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, auth_method) SELECT ?1, ?2, ?3, ?4, ?5, 'password' WHERE EXISTS (SELECT 1 FROM auth_accounts WHERE user_id = ?2 AND password_hash = ?6)")
      .bind(session.id, row.user_id, session.hash, session.expiresAt, session.createdAt, row.password_hash),
    env.DB.prepare('UPDATE users SET last_login_at = ?2 WHERE id = ?1').bind(row.user_id, session.createdAt),
  ]);
  if (result[0]?.meta.changes !== 1) throw unauthenticated('密码已更改，请重新登录');
  return { user: { id: row.user_id, username: row.username, email: row.contact_email, displayName: row.display_name, role: accountRole(row), isAdmin: accountRole(row) !== 'user' }, token: session.token };
}

/** Codes contain 80 bits of unbiased cryptographic randomness and are disclosed only once. */
export async function createAccountInvitation(env: Env, createdBy: string | null): Promise<{ id: string; code: string; createdAt: string }> {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const code = Array.from(bytes, value => alphabet[value & 31]).join('');
  const id = newId(); const createdAt = nowIso();
  await env.DB.prepare('INSERT INTO account_invitations (id, code_hash, created_by, created_at) VALUES (?1, ?2, ?3, ?4)').bind(id, await sha256Hex(code), createdBy, createdAt).run();
  return { id, code, createdAt };
}
