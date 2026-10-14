import type { Env } from '../env';
import { newId, nowIso, sha256Hex } from '../core/db';
import { emailUnavailable, unauthenticated, validationFailed } from '../core/errors';
import { consumePasswordRateLimit, normalizeEmail } from './accounts';
import { verifyPassword, DUMMY_PASSWORD_HASH } from './password';
import { verifyTurnstile } from './turnstile';
import { sendRecoveryEmail } from '../email/resend';

export type RecoveryAccount = {user_id:string;password_hash:string;contact_email_norm:string|null;email_verified:number;recovery_email_version:number};
export const recoveryToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export const emailFingerprint = (account:RecoveryAccount) => sha256Hex(JSON.stringify([account.recovery_email_version,account.email_verified,account.contact_email_norm]));
export const recoveryAccount = (env:Env,userId:string) => env.DB.prepare('SELECT user_id,password_hash,contact_email_norm,email_verified,recovery_email_version FROM auth_accounts WHERE user_id=?1 AND password_hash IS NOT NULL').bind(userId).first<RecoveryAccount>();
export async function recoveryEmailStatus(env:Env,userId:string){
  const row=await recoveryAccount(env,userId);
  if(!row)throw unauthenticated();
  return {email:row.contact_email_norm,verified:row.email_verified===1};
}

export async function requestRecoveryEmailVerification(env:Env,userId:string,input:{email:string;currentPassword:string;turnstileToken?:string},ip:string){
  await consumePasswordRateLimit(env,'recovery-email-ip',ip,20,3600);
  await verifyTurnstile(env,input.turnstileToken,'recovery_email',ip);
  await consumePasswordRateLimit(env,'recovery-email-user',userId,5,900);
  const row=await recoveryAccount(env,userId),email=normalizeEmail(input.email)!;
  if(!await verifyPassword(input.currentPassword,row?.password_hash??DUMMY_PASSWORD_HASH)||!row)throw validationFailed('当前密码不正确');
  const token=recoveryToken(),id=newId(),created=nowIso(),expires=new Date(Date.now()+15*60_000).toISOString();
  const inserted=await env.DB.prepare(`INSERT INTO recovery_email_verifications(id,user_id,token_hash,pending_email,password_fingerprint,email_fingerprint,created_at,expires_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS (SELECT 1 FROM auth_accounts WHERE user_id=?2 AND password_hash=?9
      AND COALESCE(contact_email_norm,'')=?10 AND email_verified=?11 AND recovery_email_version=?12)
      AND NOT EXISTS(SELECT 1 FROM auth_accounts WHERE contact_email_norm=?4 AND user_id<>?2)`)
    .bind(id,userId,await sha256Hex(token),email,await sha256Hex(row.password_hash),await emailFingerprint(row),created,expires,row.password_hash,row.contact_email_norm??'',row.email_verified,row.recovery_email_version).run();
  if(inserted.meta.changes!==1)throw validationFailed('账户状态或邮箱已变化，请核对后重新申请');
  const delivery=await sendRecoveryEmail(env,{id,userId,recipient:email,kind:'verification',token});
  if(delivery==='unavailable'||delivery==='failed'||delivery==='limited')throw emailUnavailable('邮件暂时无法发送，请稍后重新申请；当前恢复邮箱未改变。');
  return {accepted:true as const};
}

export async function verifyRecoveryEmail(env:Env,userId:string,token:string,ip:string){
  await consumePasswordRateLimit(env,'recovery-email-verify-ip',ip,20,900);
  await consumePasswordRateLimit(env,'recovery-email-verify-user',userId,10,900);
  const invalid=()=>validationFailed('验证链接无效或已过期，请登录申请绑定的原账户后重新申请。');
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw invalid();
  const row=await recoveryAccount(env,userId),tokenHash=await sha256Hex(token),now=nowIso();
  const verification=await env.DB.prepare('SELECT id,pending_email,password_fingerprint,email_fingerprint FROM recovery_email_verifications WHERE user_id=?1 AND token_hash=?2 AND used_at IS NULL AND expires_at>?3')
    .bind(userId,tokenHash,now).first<{id:string;pending_email:string;password_fingerprint:string;email_fingerprint:string}>();
  if(!row||!verification||await sha256Hex(row.password_hash)!==verification.password_fingerprint||await emailFingerprint(row)!==verification.email_fingerprint)throw invalid();
  const claim=newId();
  const results=await env.DB.batch([
    env.DB.prepare(`UPDATE recovery_email_verifications SET used_at=?2,claim_id=?3 WHERE id=?1 AND user_id=?4 AND token_hash=?5 AND used_at IS NULL AND expires_at>?2
      AND EXISTS (SELECT 1 FROM auth_accounts WHERE user_id=?4 AND password_hash=?6 AND COALESCE(contact_email_norm,'')=?7 AND email_verified=?8 AND recovery_email_version=?9)
      AND NOT EXISTS(SELECT 1 FROM auth_accounts WHERE contact_email_norm=?10 AND user_id<>?4)`)
      .bind(verification.id,now,claim,userId,tokenHash,row.password_hash,row.contact_email_norm??'',row.email_verified,row.recovery_email_version,verification.pending_email),
    env.DB.prepare(`UPDATE auth_accounts SET contact_email=?2,contact_email_norm=?2,email_verified=1,recovery_email_version=recovery_email_version+1
      WHERE user_id=?1 AND EXISTS (SELECT 1 FROM recovery_email_verifications WHERE id=?3 AND claim_id=?4)`)
      .bind(userId,verification.pending_email,verification.id,claim),
    env.DB.prepare(`UPDATE recovery_email_verifications SET used_at=?2 WHERE user_id=?1 AND used_at IS NULL
      AND EXISTS (SELECT 1 FROM recovery_email_verifications WHERE id=?3 AND claim_id=?4)`).bind(userId,now,verification.id,claim),
  ]);
  if(results[0]?.meta.changes!==1||results[1]?.meta.changes!==1)throw invalid();
  return {verified:true as const};
}

export async function removeRecoveryEmail(env:Env,userId:string,currentPassword:string){
  await consumePasswordRateLimit(env,'recovery-email-user',userId,5,900);
  const row=await recoveryAccount(env,userId);
  if(!row||!await verifyPassword(currentPassword,row.password_hash))throw validationFailed('当前密码不正确');
  const changed=await env.DB.prepare(`UPDATE auth_accounts SET contact_email=NULL,contact_email_norm=NULL,email_verified=0,recovery_email_version=recovery_email_version+1
    WHERE user_id=?1 AND password_hash=?2 AND recovery_email_version=?3`).bind(userId,row.password_hash,row.recovery_email_version).run();
  if(changed.meta.changes!==1)throw validationFailed('账户状态已变化，请重新核对');
  return {removed:true as const};
}
