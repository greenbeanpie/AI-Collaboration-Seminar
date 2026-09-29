import type { Env } from '../env';
import { AppError } from '../core/errors';
import type { EmailProvider } from './provider';
import { verificationEmailHtml, verificationEmailSubject } from './provider';

/**
 * Resend HTTP API 实现（PLAN 二.1）。
 * 注意：Resend 免费档需先验证发信域名才能发给任意邮箱；未验证时仅能发给注册邮箱。
 * 启用条件：EMAIL_MODE=resend 且已配置 RESEND_API_KEY 与（验证过的）EMAIL_FROM 域名。
 */
export function createResendEmailProvider(env: Env): EmailProvider {
  return {
    async sendVerificationCode(to, code, challengeId) {
      if (!env.RESEND_API_KEY) {
        throw new AppError('EMAIL_UNAVAILABLE', '邮件服务未配置（缺少 RESEND_API_KEY）', 503, true);
      }
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM || 'onboarding@resend.dev',
          to: [to],
          subject: verificationEmailSubject,
          html: verificationEmailHtml(code, 10),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error(`[email:resend] 发送失败 challenge=${challengeId} status=${res.status} ${detail.slice(0, 200)}`);
        throw new AppError('EMAIL_UNAVAILABLE', '验证码邮件发送失败', 503, true, { status: res.status });
      }
    },
  };
}
