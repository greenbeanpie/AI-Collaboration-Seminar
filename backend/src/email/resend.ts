import type { Env } from '../env';
import { hmacSha256Hex, nowIso } from '../core/db';
import { purposeSecret } from '../ai/secrets';
import { dailyEmailLimit } from '../services/auth-policy';

/**
 * Resend HTTP API 实现（PLAN 二.1）。
 * 注意：Resend 免费档需先验证发信域名才能发给任意邮箱；未验证时仅能发给注册邮箱。
 * 启用条件：EMAIL_MODE=resend 且已配置 RESEND_API_KEY 与（验证过的）EMAIL_FROM 域名。
 */
export const resendEmailConfigured = (env: Env): boolean => Boolean(env.RESEND_API_KEY && env.EMAIL_FROM?.trim() && (env.ENV_NAME === 'local' || !/@resend\.dev(?:>|$)/i.test(env.EMAIL_FROM.trim())));

export function recoveryLinkOrigin(env: Env & {APP_ORIGIN?:string}): string | null {
  const candidates = env.APP_ORIGIN ? [env.APP_ORIGIN.trim()] : env.ALLOWED_ORIGINS.split(',').map(value => value.trim()).filter(Boolean);
  if (candidates.length !== 1) return null;
  try {
    const candidate = candidates[0]!, url = new URL(candidate);
    const local = env.ENV_NAME === 'local' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      (!local && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) || candidate.replace(/\/$/,'') !== url.origin) return null;
    return url.origin;
  } catch { return null; }
}

export type EmailDelivery = 'sent' | 'failed' | 'unknown' | 'limited' | 'unavailable';
/** No retries: a transport interruption may have delivered the message. Never log its body. */
export async function sendRecoveryEmail(env: Env & {APP_ORIGIN?:string}, input: { id: string; userId: string; recipient: string; kind: 'verification' | 'recovery'; token: string }): Promise<EmailDelivery> {
  const origin = recoveryLinkOrigin(env);
  if (env.EMAIL_MODE !== 'resend' || !resendEmailConfigured(env) || !origin || !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(input.recipient)) return 'unavailable';
  const now = nowIso(), day = new Date(Date.now()+8*3600_000).toISOString().slice(0,10);
  const recipientHash = await hmacSha256Hex(await purposeSecret(env,'rate-limit'), input.recipient.toLowerCase());
  const cutoff = new Date(Date.now()-60_000).toISOString();
  const admitted = await env.DB.prepare(`INSERT INTO auth_email_dispatches(id,user_id,day,recipient_hash,kind,status,created_at)
    SELECT ?1,?2,?3,?4,?5,'reserved',?6
    WHERE COALESCE((SELECT sends FROM auth_email_daily_usage WHERE day=?3),0) < ?7
      AND COALESCE((SELECT sends FROM auth_email_recipient_usage WHERE day=?3 AND email_hash=?4),0) < 5
      AND NOT EXISTS (SELECT 1 FROM auth_email_dispatches WHERE recipient_hash=?4 AND created_at>?8) RETURNING id`)
    .bind(input.id,input.userId,day,recipientHash,input.kind,now,Math.min(30,dailyEmailLimit(env)),cutoff).first<{id:string}>();
  if (!admitted) return 'limited';
  const verification = input.kind === 'verification';
  const link = `${origin}/${verification?'email-verify':'password-reset'}#token=${input.token}`;
  let status: 'sent' | 'failed' | 'unknown' = 'unknown';
  const controller = new AbortController(), timer = setTimeout(()=>controller.abort(),15_000);
  try {
    const response = await fetch('https://api.resend.com/emails', { method:'POST',redirect:'error',signal:controller.signal,
      headers:{'Authorization':`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`recovery-email/${input.id}`},
      body:JSON.stringify({from:env.EMAIL_FROM,to:[input.recipient],subject:verification?'验证补位账户恢复邮箱':'恢复补位账户密码',
        text:`${verification?'请先登录申请绑定的原账户，再打开链接确认恢复邮箱（15分钟有效）':'打开链接设置新密码（30分钟有效），成功后全部旧设备会话退出'}：\n${link}\n\n如果不是您本人申请，请忽略此邮件。不要转发链接或恢复代码。`}) });
    status = response.ok ? 'sent' : response.status >= 500 ? 'unknown' : 'failed';
    // No response body is needed, so a slow body cannot extend the sender deadline.
    void response.body?.cancel().catch(()=>{});
  } catch { status='unknown'; }
  finally { clearTimeout(timer); }
  await env.DB.prepare('UPDATE auth_email_dispatches SET status=?2 WHERE id=?1').bind(input.id,status).run();
  return status;
}

