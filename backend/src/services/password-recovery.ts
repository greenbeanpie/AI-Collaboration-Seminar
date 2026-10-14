import type { Env, SessionUser } from '../env';
import { newId, nowIso, sha256Hex } from '../core/db';
import { permissionDenied, validationFailed } from '../core/errors';
import { consumePasswordRateLimit } from './accounts';
import { hashPassword } from './password';
import { emailFingerprint, recoveryAccount, recoveryToken, type RecoveryAccount } from './recovery-email';
import { verifyTurnstile } from './turnstile';
import { sendRecoveryEmail } from '../email/resend';

const unavailable = () => validationFailed('恢复代码无效或已过期，请重新申请邮件恢复或联系管理员核实。');

/** An operator verifies ownership outside this API. Unverified email is never recovery evidence. */
export async function issuePasswordRecovery(env: Env, actor: SessionUser, userId: string, reason: string) {
  if (actor.role !== 'super_admin') throw permissionDenied('需要超级管理员账户登录');
  await consumePasswordRateLimit(env, 'password-recovery-issue', actor.id, 20, 3600);
  const target = await recoveryAccount(env,userId);
  if (!target) throw validationFailed('此账户尚无可恢复的密码登录，请核对账户。');
  const token = recoveryToken();
  const id = newId(), createdAt = nowIso(), expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const inserted = await env.DB.prepare(`INSERT INTO password_recovery_tokens
    (id,user_id,token_hash,password_fingerprint,created_by,reason,created_at,expires_at,email_fingerprint)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?10
    WHERE EXISTS (SELECT 1 FROM auth_accounts WHERE user_id = ?5 AND account_role = 'super_admin')
      AND EXISTS (SELECT 1 FROM auth_accounts WHERE user_id = ?2 AND password_hash = ?9 AND COALESCE(contact_email_norm,'')=?11 AND email_verified=?12 AND recovery_email_version=?13)`)
    .bind(id, userId, await sha256Hex(token), await sha256Hex(target.password_hash), actor.id, reason.trim(), createdAt, expiresAt, target.password_hash,await emailFingerprint(target),target.contact_email_norm??'',target.email_verified,target.recovery_email_version).run();
  if (inserted.meta.changes !== 1) throw permissionDenied('账户权限或密码已变化，请重新核实');
  return { id, token, expiresAt };
}

/** The same accepted response is returned for missing, unverified, limited and delivered accounts. */
export async function requestEmailPasswordRecovery(env:Env,input:{account:string;turnstileToken?:string},ip:string,schedule:(work:Promise<void>)=>void){
  const challenge=env.TURNSTILE_REQUIRED==='true';
  await consumePasswordRateLimit(env,'recovery-request-ip',ip,challenge?120:20,challenge?600:3600);
  await verifyTurnstile(env,input.turnstileToken,'password_recovery',ip);
  if(challenge)await consumePasswordRateLimit(env,'recovery-request-verified-ip',ip,120,3600);
  const identity=input.account.trim().toLowerCase();
  await consumePasswordRateLimit(env,'recovery-request-account',identity,5,900);
  schedule((async()=>{try {
  const target=await env.DB.prepare(`SELECT user_id,password_hash,contact_email_norm,email_verified,recovery_email_version FROM auth_accounts
    WHERE (username_norm=?1 OR contact_email_norm=?1) AND email_verified=1 AND contact_email_norm IS NOT NULL AND password_hash IS NOT NULL`).bind(identity).first<RecoveryAccount>();
  if(target){
    // Username and verified-email aliases share the actual account allowance.
    await consumePasswordRateLimit(env,'recovery-request-user',target.user_id,5,900);
    const id=newId(),token=recoveryToken(),created=nowIso(),expires=new Date(Date.now()+30*60_000).toISOString();
    const issued=await env.DB.prepare(`INSERT INTO password_recovery_tokens(id,user_id,token_hash,password_fingerprint,created_by,reason,created_at,expires_at,issuance_source,email_fingerprint)
      SELECT ?1,?2,?3,?4,?2,'verified email self-service',?5,?6,'email',?7 WHERE EXISTS (SELECT 1 FROM auth_accounts
      WHERE user_id=?2 AND password_hash=?8 AND contact_email_norm=?9 AND email_verified=1 AND recovery_email_version=?10)`)
      .bind(id,target.user_id,await sha256Hex(token),await sha256Hex(target.password_hash),created,expires,await emailFingerprint(target),target.password_hash,target.contact_email_norm,target.recovery_email_version).run();
    if(issued.meta.changes===1)await sendRecoveryEmail(env,{id,userId:target.user_id,recipient:target.contact_email_norm!,kind:'recovery',token});
  }
  } catch { console.warn(JSON.stringify({event:'email_recovery_background_failed',category:'storage_or_delivery'})); }})());
  return {accepted:true as const};
}

export async function redeemPasswordRecovery(env: Env, token: string, newPassword: string, ip: string): Promise<void> {
  await consumePasswordRateLimit(env, 'password-recovery-ip', ip, 20, 900);
  await consumePasswordRateLimit(env, 'password-recovery-token', token, 10, 900);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unavailable();
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`SELECT r.id,r.user_id,r.password_fingerprint,r.email_fingerprint,r.issuance_source,a.password_hash,a.contact_email_norm,a.email_verified,a.recovery_email_version
    FROM password_recovery_tokens r JOIN auth_accounts a ON a.user_id = r.user_id
    WHERE r.token_hash = ?1 AND r.used_at IS NULL AND r.expires_at > ?2 AND a.password_hash IS NOT NULL`)
    .bind(tokenHash, nowIso()).first<RecoveryAccount & { id: string; password_fingerprint: string; email_fingerprint:string|null;issuance_source:string }>();
  if (!row || await sha256Hex(row.password_hash) !== row.password_fingerprint || await emailFingerprint(row)!==row.email_fingerprint || (row.issuance_source==='email'&&row.email_verified!==1)) throw unavailable();
  const hash = await hashPassword(newPassword), claimedAt = nowIso(), claimId = newId();
  // D1 batch is transactional. A unique claim gates every effect, including session revocation.
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE password_recovery_tokens SET used_at = ?2, claim_id = ?3
      WHERE id = ?1 AND token_hash = ?4 AND used_at IS NULL AND expires_at > ?2
      AND EXISTS (SELECT 1 FROM auth_accounts WHERE user_id = ?5 AND password_hash = ?6 AND COALESCE(contact_email_norm,'')=?7 AND email_verified=?8 AND recovery_email_version=?9)`)
      .bind(row.id, claimedAt, claimId, tokenHash, row.user_id, row.password_hash,row.contact_email_norm??'',row.email_verified,row.recovery_email_version),
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
