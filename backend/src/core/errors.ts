/** 统一错误码目录（见 backend_plan.md 4.1） */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'AUTH_CHALLENGE_INVALID',
  'AUTH_CHALLENGE_EXPIRED',
  'AUTH_ATTEMPTS_EXCEEDED',
  'RATE_LIMITED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_STATE',
  'FILE_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'SOURCE_PARSE_FAILED',
  'PAGE_INVALID',
  'QUOTA_EXCEEDED',
  'AI_OUTPUT_INVALID',
  'AI_UNAVAILABLE',
  'EMAIL_UNAVAILABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const validationFailed = (message = '请求参数不合法', details?: Record<string, unknown>) =>
  new AppError('VALIDATION_FAILED', message, 400, false, details);
export const unauthenticated = (message = '未登录或会话已失效') =>
  new AppError('UNAUTHENTICATED', message, 401, false);
export const authChallengeInvalid = (message = '验证码错误') =>
  new AppError('AUTH_CHALLENGE_INVALID', message, 400, false);
export const authChallengeExpired = (message = '验证码已过期，请重新获取') =>
  new AppError('AUTH_CHALLENGE_EXPIRED', message, 410, false);
export const authAttemptsExceeded = (message = '验证码尝试次数过多，请重新获取') =>
  new AppError('AUTH_ATTEMPTS_EXCEEDED', message, 429, false);
export const permissionDenied = (message = '没有执行该操作的权限') =>
  new AppError('PERMISSION_DENIED', message, 403, false);
export const notFound = (message = '资源不存在') => new AppError('NOT_FOUND', message, 404, false);
export const versionConflict = (currentRevision: number) =>
  new AppError('VERSION_CONFLICT', '内容已被他人更新，请获取最新版本后重试', 409, false, {
    currentRevision,
  });
export const invalidState = (message = '当前状态不允许该操作') =>
  new AppError('INVALID_STATE', message, 409, false);
export const fileTooLarge = (maxBytes: number) =>
  new AppError('FILE_TOO_LARGE', `文件超过大小限制`, 413, false, { maxBytes });
export const unsupportedMediaType = (message = '文件类型校验未通过') =>
  new AppError('UNSUPPORTED_MEDIA_TYPE', message, 415, false);
export const rateLimited = (message = '请求过于频繁，请稍后再试', details?: Record<string, unknown>) =>
  new AppError('RATE_LIMITED', message, 429, true, details);
export const quotaExceeded = (message = '配额不足', details?: Record<string, unknown>) =>
  new AppError('QUOTA_EXCEEDED', message, 429, true, details);
export const aiUnavailable = (message = '模型服务暂不可用', details?: Record<string, unknown>) =>
  new AppError('AI_UNAVAILABLE', message, 503, true, details);
export const emailUnavailable = (message = '邮件服务暂不可用', details?: Record<string, unknown>) =>
  new AppError('EMAIL_UNAVAILABLE', message, 503, true, details);
export const internalError = (message = '服务器内部错误') =>
  new AppError('INTERNAL', message, 500, false);
