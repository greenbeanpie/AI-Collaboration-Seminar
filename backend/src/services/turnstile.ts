import type { Env } from '../env';
import { emailUnavailable, validationFailed } from '../core/errors';
import { inviteOnly } from './auth-policy';

export const turnstileRequired = (env: Env): boolean => !inviteOnly(env) && (env.TURNSTILE_REQUIRED === 'true' || env.ENV_NAME !== 'local');

export async function verifyTurnstile(env: Env, token: string | undefined, ip: string | null): Promise<void> {
  if (!turnstileRequired(env)) return;
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) throw emailUnavailable('验证码防护服务尚未配置');
  if (!token) throw validationFailed('请先完成安全验证');
  const hosts = (env.ALLOWED_ORIGINS ?? '').split(',').flatMap(origin => {
    try { return [new URL(origin.trim()).hostname]; } catch { return []; }
  });
  let response: Response;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(ip ? { remoteip: ip } : {}), idempotency_key: crypto.randomUUID() }),
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
  } catch { throw emailUnavailable('安全验证暂时无法连接，请重新验证'); }
  if (!response.ok) throw emailUnavailable('安全验证服务暂不可用');
  const result = await response.json().catch(() => null) as { success?: boolean; hostname?: string; action?: string } | null;
  if (result?.success !== true || result.action !== 'email_login' || !result.hostname || !hosts.includes(result.hostname)) throw validationFailed('安全验证失败或已过期，请重新验证');
}
