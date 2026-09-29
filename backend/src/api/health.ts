import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';

const healthResponse = apiEnvelope(
  z.object({
    status: z.literal('ok'),
    environment: z.string(),
    time: z.string(),
  }),
  'HealthResponse',
);

const depsResponse = apiEnvelope(
  z.object({
    d1: z.enum(['ok', 'error']),
    r2: z.enum(['ok', 'error']),
  }),
  'HealthDepsResponse',
);

const healthRoute = createRoute({
  method: 'get',
  path: '/api/v1/health',
  tags: ['system'],
  summary: '存活检查（不触发付费调用）',
  responses: {
    200: { content: { 'application/json': { schema: healthResponse } }, description: '服务存活' },
  },
});

const depsRoute = createRoute({
  method: 'get',
  path: '/api/v1/health/deps',
  tags: ['system'],
  summary: '内部依赖检查（D1/R2 可达性，不触发付费调用）',
  responses: {
    200: { content: { 'application/json': { schema: depsResponse } }, description: '依赖状态' },
  },
});

/**
 * 路由直接注册到根 OpenAPIHono 实例（带完整 /api/v1 前缀），
 * 保证 getOpenAPI31Document 能收集到全部契约路径。
 */
export function registerSystemRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(healthRoute, (c) =>
    c.json(
      apiData(c, { status: 'ok' as const, environment: c.env.ENV_NAME, time: new Date().toISOString() }),
      200,
    ),
  );

  app.openapi(depsRoute, async (c) => {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return 'ok' as const;
      } catch {
        return 'error' as const;
      }
    };
    const d1 = await check(() => c.env.DB.prepare('SELECT 1').first());
    const r2 = await check(() => c.env.FILES.head('_health/probe'));
    return c.json(apiData(c, { d1, r2 }), 200);
  });
}
