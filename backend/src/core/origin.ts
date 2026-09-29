import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { permissionDenied } from './errors';

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * 写请求（非 GET/HEAD/OPTIONS）的 Origin 白名单校验（PLAN 二.3）。
 * 无 Origin 头（服务间调用/命令行）放行；local 环境放行任意 localhost 端口。
 */
export const requireAllowedOrigin = createMiddleware<AppEnv>(async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    await next();
    return;
  }
  const origin = c.req.header('origin');
  if (!origin) {
    await next();
    return;
  }
  if (c.env.ENV_NAME === 'local' && LOCAL_ORIGIN_RE.test(origin)) {
    await next();
    return;
  }
  const allowed = (c.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.includes(origin)) {
    throw permissionDenied('请求来源不在允许列表中');
  }
  await next();
});
