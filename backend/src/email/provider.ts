/** 邮件发送适配器接口（PLAN 二.1：首个实现为开发回显，预留 Resend HTTP API） */
export interface EmailProvider {
  /** 发送验证码邮件。实现方负责记录投递失败日志；失败抛 AppError(EMAIL_UNAVAILABLE) */
  sendVerificationCode(to: string, code: string, challengeId: string): Promise<void>;
}

export const verificationEmailSubject = '「补位」AI 项目办公室 — 登录验证码';

export function verificationEmailHtml(code: string, ttlMinutes: number): string {
  return [
    `<p>你的登录验证码是：</p>`,
    `<p style="font-size:28px;letter-spacing:8px;font-weight:700">${code}</p>`,
    `<p>${ttlMinutes} 分钟内有效。若非本人操作，请忽略本邮件。</p>`,
  ].join('\n');
}
