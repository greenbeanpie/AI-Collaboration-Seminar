import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from './env';
import { AppError } from './core/errors';
import { failureBody, requestIdMiddleware } from './core/http';
import { registerSystemRoutes } from './api/health';
import { registerCapabilitiesRoutes } from './api/capabilities';

export function createApp(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.use('*', requestIdMiddleware);

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? crypto.randomUUID();
    if (err instanceof AppError) {
      if (err.status >= 500) {
        console.error(`[error] ${requestId} ${err.code}: ${err.message}`, err.details ?? '');
      }
      return c.json(failureBody(err.code, err.message, err.retryable, requestId, err.details), err.status as 400);
    }
    console.error(`[error] ${requestId} unhandled:`, err);
    return c.json(failureBody('INTERNAL', '服务器内部错误', false, requestId), 500);
  });

  app.notFound((c) => {
    const requestId = c.get('requestId') ?? crypto.randomUUID();
    return c.json(failureBody('NOT_FOUND', '接口不存在', false, requestId), 404);
  });

  // 所有域路由直接注册到本实例（带完整 /api/v1 前缀），保证契约文档完整
  registerSystemRoutes(app);
  registerCapabilitiesRoutes(app);

  app.doc31('/api/v1/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: '「补位」AI 项目办公室 API',
      version: '0.1.0',
      description:
        '契约唯一来源：前端 MSW 以此为依据。接口契约由双方共同确认，不得单方面修改（见 backend_plan.md 第 1 节）。',
    },
    servers: [{ url: '/' }],
  });

  return app;
}
