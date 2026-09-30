import type { Env } from '../env';
import { emailUnavailable, permissionDenied } from '../core/errors';

export const inviteOnly = (env: Env): boolean => env.AUTH_MODE === 'invite-only';
export function assertInvitedEmail(env: Env, email: string): void {
  if (!inviteOnly(env)) return;
  const allowed = (env.AUTH_ALLOWED_EMAILS ?? '').split(/[\s,;]+/).filter(Boolean).map(value => value.toLowerCase());
  if (!allowed.length) throw emailUnavailable('邀请邮箱名单尚未配置');
  if (!allowed.includes(email.toLowerCase())) throw permissionDenied('当前仅对受邀邮箱开放，请联系负责人加入名单');
}
export function dailyEmailLimit(env: Env): number {
  const value = Number(env.EMAIL_DAILY_LIMIT ?? 30);
  return Number.isSafeInteger(value) && value > 0 && value <= 100 ? value : 30;
}
