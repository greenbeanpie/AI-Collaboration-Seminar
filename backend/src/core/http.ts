import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import type { ApiSuccessBody } from './api';

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
  return {
    error: { code, message, retryable, ...(details ? { details } : {}) },
    requestId,
  };
}
