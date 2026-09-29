import type { EmailProvider } from './provider';
import { verificationEmailSubject } from './provider';

/**
 * 开发回显实现：验证码只写日志，不真实发信。
 * 仅限 ENV_NAME=local/staging 与 EMAIL_MODE=echo 时使用；
 * 生产环境 EMAIL_MODE 必须为 resend。
 */
export const echoEmailProvider: EmailProvider = {
  async sendVerificationCode(to, code, challengeId) {
    console.info(`[email:echo] challenge=${challengeId} to=${to} subject=${verificationEmailSubject} code=${code}`);
  },
};
