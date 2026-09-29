import type { Env } from '../env';
import { hmacSha256Hex, newId, nowIso, timingSafeEqual } from '../core/db';
import {
  AppError,
  authChallengeExpired,
  authAttemptsExceeded,
  authChallengeInvalid,
  rateLimited,
} from '../core/errors';
import { LIMITS } from '../core/limits';
import type { EmailProvider } from '../email/provider';

export interface ChallengeCreated {
  challengeId: string;
  expiresAt: string;
  resendAfterSeconds: number;
  /** 仅开发回显模式（非生产）返回，用于本地与演示 */
  devCode?: string;
}

function generateCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String((buf[0] ?? 0) % 1_000_000).padStart(6, '0');
}

const codeHmac = async (secret: string, challengeId: string, email: string, code: string): Promise<string> =>
  hmacSha256Hex(secret, `${challengeId}|${email}|${code}`);

/**
 * 创建验证码挑战（PLAN 二.3）：
 * 6 位数字 / 10 分钟 / 最多 5 次尝试 / 单邮箱 60 秒间隔 + IP 每小时限流。
 * 服务端只存 HMAC（绑定邮箱与挑战 ID），不存明文。
 */
export async function createChallenge(
  env: Env,
  params: { email: string; ip: string | null; emailProvider: EmailProvider },
): Promise<ChallengeCreated> {
  const now = new Date();
  const nowStr = now.toISOString();

  // 单邮箱发送间隔
  const recent = await env.DB.prepare(
    'SELECT requested_at FROM auth_challenges WHERE email = ?1 ORDER BY requested_at DESC LIMIT 1',
  )
    .bind(params.email)
    .first<{ requested_at: string }>();
  if (recent) {
    const elapsed = now.getTime() - new Date(recent.requested_at).getTime();
    if (elapsed < LIMITS.challengeResendSeconds * 1000) {
      throw rateLimited('验证码发送间隔过短', { resendAfterSeconds: Math.ceil((LIMITS.challengeResendSeconds * 1000 - elapsed) / 1000) });
    }
  }

  // IP 每小时限流
  if (params.ip) {
    const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
    const ipRow = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM auth_challenges WHERE ip = ?1 AND requested_at > ?2',
    )
      .bind(params.ip, hourAgo)
      .first<{ n: number }>();
    if ((ipRow?.n ?? 0) >= 10) {
      throw rateLimited('该来源请求过于频繁，请一小时后再试');
    }
  }

  const challengeId = newId();
  const code = generateCode();
  const expiresAt = new Date(now.getTime() + LIMITS.challengeTtlMinutes * 60_000).toISOString();
  const codeHmacValue = await codeHmac(env.AUTH_SECRET, challengeId, params.email, code);

  await env.DB.prepare(
    `INSERT INTO auth_challenges (id, email, code_hmac, attempts, ip, requested_at, expires_at)
     VALUES (?1, ?2, ?3, 0, ?4, ?5, ?6)`,
  )
    .bind(challengeId, params.email, codeHmacValue, params.ip, nowStr, expiresAt)
    .run();

  await params.emailProvider.sendVerificationCode(params.email, code, challengeId);

  return {
    challengeId,
    expiresAt,
    resendAfterSeconds: LIMITS.challengeResendSeconds,
    ...(env.EMAIL_MODE === 'echo' && env.ENV_NAME !== 'production' ? { devCode: code } : {}),
  };
}

export interface ChallengeRow {
  id: string;
  email: string;
  code_hmac: string;
  attempts: number;
  expires_at: string;
}

export interface VerifyResult {
  challengeId: string;
  email: string;
}

/**
 * 校验并一次性消费验证码：
 * 1. 条件更新尝试次数（并发安全）；2. HMAC 常数时间比对；3. 条件更新一次性消费。
 */
export async function verifyAndConsumeChallenge(
  env: Env,
  params: { challengeId: string; email: string; code: string },
): Promise<VerifyResult> {
  const nowStr = nowIso();
  const row = await env.DB.prepare(
    'SELECT id, email, code_hmac, attempts, expires_at FROM auth_challenges WHERE id = ?1 AND email = ?2',
  )
    .bind(params.challengeId, params.email)
    .first<ChallengeRow>();
  if (!row) throw authChallengeInvalid();

  if (row.expires_at <= nowStr) throw authChallengeExpired();
  if (row.attempts >= LIMITS.challengeMaxAttempts) throw authAttemptsExceeded();

  // 条件更新尝试次数：changes=0 说明并发下已被耗尽/过期
  const bump = await env.DB.prepare(
    'UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?1 AND consumed_at IS NULL AND expires_at > ?2 AND attempts < ?3',
  )
    .bind(row.id, nowStr, LIMITS.challengeMaxAttempts)
    .run();
  if ((bump.meta?.changes ?? 0) === 0) throw authAttemptsExceeded();

  const computed = await codeHmac(env.AUTH_SECRET, row.id, params.email, params.code);
  if (!(await timingSafeEqual(computed, row.code_hmac))) throw authChallengeInvalid();

  // 一次性消费，防并发重复验证
  const consume = await env.DB.prepare(
    'UPDATE auth_challenges SET consumed_at = ?2 WHERE id = ?1 AND consumed_at IS NULL',
  )
    .bind(row.id, nowIso())
    .run();
  if ((consume.meta?.changes ?? 0) === 0) throw new AppError('INVALID_STATE', '验证码已被使用', 409, false);

  return { challengeId: row.id, email: row.email };
}
