import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import type { ApiSuccessBody } from './api';
import { errorGuidance, type ErrorStage, type ErrorAction } from './error-guidance';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 为每个请求分配 requestId：优先透传前端带来的合法 X-Request-Id，否则生成新 UUID。
 * 响应统一回写 X-Request-Id，并出现在所有 ApiSuccess/ApiFailure 载荷中。
 */
export const requestIdMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id = incoming && UUID_RE.test(incoming) ? incoming.toLowerCase() : crypto.randomUUID();
  c.set('requestId', id);
  await next();
  c.header('X-Request-Id', id);
});

export type { ApiSuccessBody };

export interface ApiFailureBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    stage: ErrorStage;
    action: ErrorAction;
    requestId: string;
    details?: Record<string, unknown>;
  };
  requestId: string;
}

/** 统一错误响应体构造（app.onError 与 notFound 共用） */
export function failureBody(
  code: string,
  message: string,
  retryable: boolean,
  requestId: string,
  details?: Record<string, unknown>,
): ApiFailureBody {
  const id = UUID_RE.test(requestId) ? requestId.toLowerCase() : crypto.randomUUID();
  const guidance = errorGuidance(code);
  // These failures may originate in a dependency/provider. Detail is available
  // through the existing allowlisted admin diagnostics, never raw public output.
  const fixedMessages: Partial<Record<string,string>> = {
    INTERNAL:'服务器内部错误，请核对操作结果并联系管理员',
    AI_UNAVAILABLE:'模型服务暂不可用，请核对已保存的模型配置',
    EMAIL_UNAVAILABLE:'邮件服务暂不可用，请核对发送状态',
    SOURCE_PARSE_FAILED:'来源处理未完成，请核对来源文件及处理状态',
  };
  const protectedFailure = Object.hasOwn(fixedMessages,code);
  return {
    error: { code, message:fixedMessages[code] ?? message, retryable, ...guidance, requestId:id, ...(!protectedFailure && details ? { details } : {}) },
    requestId:id,
  };
}
