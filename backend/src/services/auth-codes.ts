import type { Env } from '../env';
import { hmacSha256Hex, nowIso, timingSafeEqual } from '../core/db';
import {
  AppError,
  authChallengeExpired,
  authAttemptsExceeded,
  authChallengeInvalid,
} from '../core/errors';
import { LIMITS } from '../core/limits';

export interface ChallengeCreated {
  challengeId: string;
  expiresAt: string;
  resendAfterSeconds: number;
  /** 仅开发回显模式（非生产）返回，用于本地与演示 */
  devCode?: string;
}


const codeHmac = async (secret: string, challengeId: string, email: string, code: string): Promise<string> =>
  hmacSha256Hex(secret, `${challengeId}|${email}|${code}`);

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
