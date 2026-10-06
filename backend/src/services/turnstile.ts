import type { Env } from '../env';
import { AppError } from '../core/errors';

const rejected = () => new AppError('PERMISSION_DENIED', '人机验证失败，请重新验证后重试', 403, false);

/** Siteverify enforces single use; never cache a successful token or retry its redemption. */
export async function verifyTurnstile(env: Env & { TURNSTILE_HOSTNAMES?: string }, token: string | undefined, action: 'login' | 'register', ip: string): Promise<void> {
  if (env.TURNSTILE_REQUIRED !== 'true') return;
  const hosts = new Set((env.TURNSTILE_HOSTNAMES ?? '').split(',').map(host => host.trim()).filter(Boolean));
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY || !token?.trim() || token.length > 2048 || !hosts.size ||
    (env.ENV_NAME === 'production' && (hosts.has('localhost') || hosts.has('127.0.0.1')))) throw rejected();
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(ip !== 'unknown' ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw rejected();
    const result = await response.json() as { success?: boolean; hostname?: string; action?: string; challenge_ts?: string };
    const created = Date.parse(result.challenge_ts ?? '');
    const age = Date.now() - created;
    if (result.success !== true || result.action !== action || !hosts.has(result.hostname ?? '') || !Number.isFinite(created) || age < -30_000 || age > 300_000) throw rejected();
  } catch {
    throw rejected();
  }
}
