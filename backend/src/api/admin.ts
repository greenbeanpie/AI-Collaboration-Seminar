import { createMiddleware } from 'hono/factory';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { nowIso, newId, timingSafeEqual } from '../core/db';
import { unauthenticated } from '../core/errors';
import { aiConfigSchema, aiModelConfigSchema, loadAiConfig, type AiPurpose } from '../ai/config';
import { probeModel } from '../ai/probe';

const BEARER_PREFIX_RE = /^Bearer\s+/i;

const bearer = (header: string | undefined): string | null => {
  if (!header) return null;
  const trimmed = header.trim();
  if (!BEARER_PREFIX_RE.test(trimmed)) return null;
  const token = trimmed.replace(BEARER_PREFIX_RE, '').trim();
  return token || null;
};

/** 运维管理员鉴权：Bearer ADMIN_TOKEN（常数时间比较） */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c.req.header('authorization'));
  if (!token) throw unauthenticated('缺少管理员令牌');
  const ok = await timingSafeEqual(token, c.env.ADMIN_TOKEN);
  if (!ok) throw unauthenticated('管理员令牌无效');
  await next();
});

const configShape = z.object({
  textEconomy: aiModelConfigSchema,
  visionEconomy: aiModelConfigSchema,
  review: aiModelConfigSchema,
  enabled: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
});

const getResponse = apiEnvelope(
  z.object({
    id: z.string(),
    version: z.number().int(),
    enabled: z.boolean(),
    config: z.record(z.string(), z.unknown()),
    notes: z.string().nullable(),
  }),
  'AiConfigResponse',
);

const putResponse = apiEnvelope(
  z.object({
    id: z.string(),
    version: z.number().int(),
    enabled: z.boolean(),
  }),
  'AiConfigPutResponse',
);

const probeBody = z.object({
  purpose: z.enum(['textEconomy', 'visionEconomy', 'review']).default('textEconomy'),
});

const probeResponse = apiEnvelope(
  z.object({
    purpose: z.string(),
    model: z.string(),
    configVersion: z.number().int(),
    passed: z.boolean(),
    checks: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() })),
  }),
  'AiProbeResponse',
);

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/admin/ai-config',
  tags: ['admin'],
  summary: '读取当前 AI 配置版本（运维管理员）',
  responses: { 200: { content: { 'application/json': { schema: getResponse } }, description: '当前配置' } },
});

const putRoute = createRoute({
  method: 'put',
  path: '/api/v1/admin/ai-config',
  tags: ['admin'],
  summary: '写入新的 AI 配置版本（只增不改；启用前须通过探测）',
  request: { body: { content: { 'application/json': { schema: configShape } }, required: true } },
  responses: { 201: { content: { 'application/json': { schema: putResponse } }, description: '新版本已创建' } },
});

const probeRoute = createRoute({
  method: 'post',
  path: '/api/v1/admin/ai-config/probe',
  tags: ['admin'],
  summary: '对当前配置执行能力探测（中文/JSON/图片/用量字段）',
  request: { body: { content: { 'application/json': { schema: probeBody } }, required: true } },
  responses: { 200: { content: { 'application/json': { schema: probeResponse } }, description: '探测报告' } },
});

export function registerAdminRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/admin/*', requireAdmin);

  app.openapi(getRoute, async (c) => {
    const loaded = await loadAiConfig(c.env.DB);
    if (!loaded) {
      return c.json(apiData(c, { id: '', version: 0, enabled: false, config: {}, notes: null }), 200);
    }
    return c.json(
      apiData(c, {
        id: loaded.id,
        version: loaded.version,
        enabled: loaded.enabled,
        config: loaded.config,
        notes: null,
      }),
      200,
    );
  });

  app.openapi(putRoute, async (c) => {
    const body = c.req.valid('json');
    const latest = await loadAiConfig(c.env.DB);
    const version = (latest?.version ?? 0) + 1;
    const id = `cfg-v${version}-${newId().slice(0, 8)}`;
    const { enabled, notes, ...config } = body;
    await c.env.DB.prepare(
      'INSERT INTO ai_config_versions (id, version, config_json, enabled, notes, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    )
      .bind(id, version, JSON.stringify(config), enabled ? 1 : 0, notes ?? null, 'admin', nowIso())
      .run();
    return c.json(apiData(c, { id, version, enabled }), 201);
  });

  app.openapi(probeRoute, async (c) => {
    const body = c.req.valid('json');
    const report = await probeModel(c.env, body.purpose as AiPurpose);
    return c.json(
      apiData(c, {
        purpose: report.purpose,
        model: report.model,
        configVersion: report.configVersion,
        passed: report.passed,
        checks: report.checks,
      }),
      200,
    );
  });
}
