import type { Env } from '../env';

/**
 * Resend HTTP API 实现（PLAN 二.1）。
 * 注意：Resend 免费档需先验证发信域名才能发给任意邮箱；未验证时仅能发给注册邮箱。
 * 启用条件：EMAIL_MODE=resend 且已配置 RESEND_API_KEY 与（验证过的）EMAIL_FROM 域名。
 */
export const resendEmailConfigured = (env: Env): boolean => Boolean(env.RESEND_API_KEY && env.EMAIL_FROM?.trim() && (env.ENV_NAME === 'local' || !/@resend\.dev(?:>|$)/i.test(env.EMAIL_FROM.trim())));

