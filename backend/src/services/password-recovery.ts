import type { Env, SessionUser } from '../env';
import { newId, nowIso, sha256Hex } from '../core/db';
import { permissionDenied, validationFailed } from '../core/errors';
import { consumePasswordRateLimit } from './accounts';
import { hashPassword } from './password';

const unavailable = () => validationFailed('恢复代码无效或已过期，请联系管理员重新核实。');

/** An operator verifies ownership outside this API. Unverified email is never recovery evidence. */
export async function issuePasswordRecovery(env: Env, actor: SessionUser, userId: string, reason: string) {
  if (actor.role !== 'super_admin') throw permissionDenied('需要超级管理员账户登录');
  await consumePasswordRateLimit(env, 'password-recovery-issue', actor.id, 20, 3600);
  const target = await env.DB.prepare('SELECT password_hash FROM auth_accounts WHERE user_id = ?1 AND password_hash IS NOT NULL').bind(userId).first<{ password_hash: string }>();
  if (!target) throw validationFailed('此账户尚无可恢复的密码登录，请核对账户。');
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  const id = newId(), createdAt = nowIso(), expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const inserted = await env.DB.prepare(`INSERT INTO password_recovery_tokens
    (id,user_id,token_hash,password_fingerprint,created_by,reason,created_at,expires_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8
    WHERE EXISTS (SELECT 1 FROM auth_accounts WHERE user_id = ?5 AND account_role = 'super_admin')
      AND EXISTS (SELECT 1 FROM auth_accounts WHERE user_id = ?2 AND password_hash = ?9)`)
    .bind(id, userId, await sha256Hex(token), await sha256Hex(target.password_hash), actor.id, reason.trim(), createdAt, expiresAt, target.password_hash).run();
  if (inserted.meta.changes !== 1) throw permissionDenied('账户权限或密码已变化，请重新核实');
  return { id, token, expiresAt };
}

export async function redeemPasswordRecovery(env: Env, token: string, newPassword: string, ip: string): Promise<void> {
  await consumePasswordRateLimit(env, 'password-recovery-ip', ip, 20, 900);
  await consumePasswordRateLimit(env, 'password-recovery-token', token, 10, 900);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unavailable();
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`SELECT r.id,r.user_id,r.password_fingerprint,a.password_hash
    FROM password_recovery_tokens r JOIN auth_accounts a ON a.user_id = r.user_id
    WHERE r.token_hash = ?1 AND r.used_at IS NULL AND r.expires_at > ?2 AND a.password_hash IS NOT NULL`)
    .bind(tokenHash, nowIso()).first<{ id: string; user_id: string; password_fingerprint: string; password_hash: string }>();
  if (!row || await sha256Hex(row.password_hash) !== row.password_fingerprint) throw unavailable();
  const hash = await hashPassword(newPassword), claimedAt = nowIso(), claimId = newId();
  // D1 batch is transactional. A unique claim gates every effect, including session revocation.
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE password_recovery_tokens SET used_at = ?2, claim_id = ?3
      WHERE id = ?1 AND token_hash = ?4 AND used_at IS NULL AND expires_at > ?2
      AND EXISTS (SELECT 1 FROM auth_accounts WHERE user_id = ?5 AND password_hash = ?6)`)
      .bind(row.id, claimedAt, claimId, tokenHash, row.user_id, row.password_hash),
    env.DB.prepare(`UPDATE auth_accounts SET password_hash = ?2 WHERE user_id = ?1 AND password_hash = ?3
      AND EXISTS (SELECT 1 FROM password_recovery_tokens WHERE id = ?4 AND claim_id = ?5)`)
      .bind(row.user_id, hash, row.password_hash, row.id, claimId),
    env.DB.prepare(`UPDATE sessions SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM password_recovery_tokens WHERE id = ?3 AND claim_id = ?4)`)
      .bind(row.user_id, claimedAt, row.id, claimId),
    env.DB.prepare(`UPDATE password_recovery_tokens SET used_at = ?2 WHERE user_id = ?1 AND used_at IS NULL
      AND EXISTS (SELECT 1 FROM password_recovery_tokens WHERE id = ?3 AND claim_id = ?4)`)
      .bind(row.user_id, claimedAt, row.id, claimId),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) throw unavailable();
}
