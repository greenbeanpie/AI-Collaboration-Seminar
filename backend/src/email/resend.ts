import type { Env } from '../env';
import { AppError } from '../core/errors';
import type { EmailProvider } from './provider';
import { verificationEmailHtml, verificationEmailSubject } from './provider';

/**
 * Resend HTTP API 实现（PLAN 二.1）。
 * 注意：Resend 免费档需先验证发信域名才能发给任意邮箱；未验证时仅能发给注册邮箱。
 * 启用条件：EMAIL_MODE=resend 且已配置 RESEND_API_KEY 与（验证过的）EMAIL_FROM 域名。
 */
export const resendEmailConfigured = (env: Env): boolean => Boolean(env.RESEND_API_KEY && env.EMAIL_FROM?.trim() && (env.ENV_NAME === 'local' || !/@resend\.dev(?:>|$)/i.test(env.EMAIL_FROM.trim())));

export function createResendEmailProvider(env: Env): EmailProvider {
  return {
    async sendVerificationCode(to, code, challengeId) {
      if (!env.RESEND_API_KEY) {
        throw new AppError('EMAIL_UNAVAILABLE', '邮件服务未配置（缺少 RESEND_API_KEY）', 503, true);
      }
      if (!env.EMAIL_FROM?.trim()) throw new AppError('EMAIL_UNAVAILABLE', '请配置已验证域名的 EMAIL_FROM', 503, false);
      if (env.ENV_NAME !== 'local' && /@resend\.dev(?:>|$)/i.test(env.EMAIL_FROM.trim())) throw new AppError('EMAIL_UNAVAILABLE', '正式验证码邮件需要已验证的自有发信域名', 503, false);
      let res: Response;
      try {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: [to],
          subject: verificationEmailSubject,
          html: verificationEmailHtml(code, 10),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      } catch { throw new AppError('EMAIL_UNAVAILABLE', '验证码邮件发送超时或网络不可用', 503, true); }
      if (!res.ok) {
        console.error(`[email:resend] 发送失败 challenge=${challengeId} status=${res.status}`);
        throw new AppError('EMAIL_UNAVAILABLE', '验证码邮件发送失败', 503, true, { status: res.status });
      }
    },
  };
}
