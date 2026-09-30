import { createMiddleware } from 'hono/factory';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope, apiErrorEnvelope } from '../core/openapi';
import { nowIso, newId, timingSafeEqual } from '../core/db';
import { seal } from '../ai/secrets';
import { loadSessionUser, parseCookies, SESSION_COOKIE } from '../core/auth';
import { createAccountInvitation } from '../services/accounts';
import { permissionDenied, unauthenticated, invalidState, validationFailed, notFound } from '../core/errors';
import { listStuckIdempotencyRecords, releaseIdempotencyRecord } from '../services/idempotency';
import { aiConfigSchema, aiModelConfigSchema, loadAiConfig, type AiPurpose } from '../ai/config';
import { probeModel } from '../ai/probe';
import { isAllowedModelEndpoint } from '../ai/gateway';

const BEARER_PREFIX_RE = /^Bearer\s+/i;

const bearer = (header: string | undefined): string | null => {
  if (!header) return null;
  const trimmed = header.trim();
  if (!BEARER_PREFIX_RE.test(trimmed)) return null;
  const token = trimmed.replace(BEARER_PREFIX_RE, '').trim();
  return token || null;
};

/** System administrators require a password session; operator Bearer remains supported. */
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c.req.header('authorization'));
  if (token) {
    if (!c.env.ADMIN_TOKEN || !await timingSafeEqual(token, c.env.ADMIN_TOKEN)) throw unauthenticated('管理员令牌无效');
  } else {
    const user = await loadSessionUser(c.env, parseCookies(c.req.header('cookie'))[SESSION_COOKIE]);
    if (!user) throw unauthenticated();
    if (!user.isAdmin) throw permissionDenied('需要系统管理员权限');
    c.set('user', user);
  }
  await next();
});

const editableModel = aiModelConfigSchema.omit({ apiKeyEncrypted: true }).extend({ apiKey: z.string().max(4096).optional(), clearKey: z.boolean().optional() });
const configShape = z.object({
  textEconomy: editableModel,
  visionEconomy: editableModel,
  review: editableModel,
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

const stuckQuery = z.object({ olderThanMinutes: z.string().optional(), limit: z.string().optional() });

const stuckResponse = apiEnvelope(
  z.object({
    olderThanMinutes: z.number().int(),
    items: z.array(
      z.object({
        idempotencyKey: z.string(),
        userId: z.string(),
        operation: z.string(),
        requestHash: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
  'IdempotencyStuckResponse',
);

const stuckRoute = createRoute({
  method: 'get',
  path: '/api/v1/admin/idempotency/stuck',
  tags: ['admin'],
  summary: '列出滞留的幂等 processing 记录（运维核对后释放）',
  request: { query: stuckQuery },
  responses: { 200: { content: { 'application/json': { schema: stuckResponse } }, description: '滞留记录' } },
});

const releaseBody = z.object({
  idempotencyKey: z.string().min(1).max(200),
  userId: z.string().uuid(),
  operation: z.string().min(1).max(100),
});

const releaseResponse = apiEnvelope(z.object({ released: z.boolean() }), 'IdempotencyReleaseResponse');

const releaseRoute = createRoute({
  method: 'post',
  path: '/api/v1/admin/idempotency/release',
  tags: ['admin'],
  summary: '释放滞留的幂等 processing 记录（人工确认业务状态后允许同键重试）',
  request: { body: { content: { 'application/json': { schema: releaseBody } }, required: true } },
  responses: {
    200: { content: { 'application/json': { schema: releaseResponse } }, description: '已释放' },
    404: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '没有处理中的同键记录' },
  },
});

const accountInvitationResponse = apiEnvelope(z.object({ id: z.string().uuid(), code: z.string(), createdAt: z.string() }), 'AccountInvitationCreateResponse');
const accountInvitationListResponse = apiEnvelope(z.object({ items: z.array(z.object({ id: z.string().uuid(), createdAt: z.string(), usedAt: z.string().nullable(), usedBy: z.string().nullable() })), nextCursor: z.string().nullable() }), 'AccountInvitationListResponse');
const createAccountInvitationRoute = createRoute({ method: 'post', path: '/api/v1/admin/account-invitations', tags: ['admin'], summary: '系统管理员生成16位单次注册码（仅此响应回显明文）', request: { body: { content: { 'application/json': { schema: z.object({}) } }, required: true } }, responses: { 201: { content: { 'application/json': { schema: accountInvitationResponse } }, description: '注册码' } } });
const listAccountInvitationsRoute = createRoute({ method: 'get', path: '/api/v1/admin/account-invitations', tags: ['admin'], summary: '注册码使用状态（无明文码和哈希）', responses: { 200: { content: { 'application/json': { schema: accountInvitationListResponse } }, description: '最近100个注册码' } } });

export function registerAdminRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/admin/*', requireAdmin);
  app.openapi(createAccountInvitationRoute, async c => c.json(apiData(c, await createAccountInvitation(c.env, c.get('user')?.id ?? null)), 201));
  app.openapi(listAccountInvitationsRoute, async c => {
    const rows = await c.env.DB.prepare('SELECT id, created_at, used_at, used_by FROM account_invitations ORDER BY created_at DESC, id DESC LIMIT 100').all<{ id: string; created_at: string; used_at: string | null; used_by: string | null }>();
    return c.json(apiData(c, { items: rows.results.map(row => ({ id: row.id, createdAt: row.created_at, usedAt: row.used_at, usedBy: row.used_by })), nextCursor: null }), 200);
  });


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
        config: Object.fromEntries(Object.entries(loaded.config).map(([purpose, { apiKeyEncrypted, ...model }]) => [purpose, { ...model, keyConfigured: Boolean(apiKeyEncrypted) }])),
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
    const { enabled, notes } = body;
    const config = aiConfigSchema.parse(body);
    for (const purpose of ['textEconomy', 'visionEconomy', 'review'] as const) {
      const input = body[purpose];
      if (input.apiUrl && !isAllowedModelEndpoint(input.apiUrl, c.env.ENV_NAME)) {
        throw validationFailed('API URL 必须使用公开 HTTPS 域名且不能包含查询参数（本地环境允许回环地址）');
      }
      config[purpose].apiKeyEncrypted = input.clearKey ? undefined : input.apiKey ? await seal(input.apiKey, c.env.AUTH_SECRET) : latest?.config[purpose].apiKeyEncrypted;
    }
    if (enabled) {
      if (!latest || JSON.stringify(aiConfigSchema.parse(config)) !== JSON.stringify(latest.config)) throw invalidState('请先保存配置并测试全部模型，配置变化后必须重新测试');
      const probes = await c.env.DB.prepare('SELECT purpose FROM ai_probes WHERE config_version_id = ?1 AND passed = 1').bind(latest.id).all<{ purpose: string }>();
      if (probes.results.length !== 3) throw invalidState('三个用途的模型测试全部通过后才能启用 AI');
    }
    await c.env.DB.prepare(
      'INSERT INTO ai_config_versions (id, version, config_json, enabled, notes, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    )
      .bind(id, version, JSON.stringify(config), enabled ? 1 : 0, notes ?? null, 'admin', nowIso())
      .run();
    return c.json(apiData(c, { id, version, enabled }), 201);
  });

  app.openapi(probeRoute, async (c) => {
    const body = c.req.valid('json');
    const loaded = await loadAiConfig(c.env.DB);
    if (!loaded) throw invalidState('请先保存模型配置');
    const report = await probeModel(c.env, body.purpose as AiPurpose, loaded);
    await c.env.DB.prepare('INSERT INTO ai_probes (config_version_id, purpose, passed, report_json, tested_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(config_version_id, purpose) DO UPDATE SET passed = excluded.passed, report_json = excluded.report_json, tested_at = excluded.tested_at')
      .bind(loaded.id, report.purpose, report.passed ? 1 : 0, JSON.stringify(report), nowIso()).run();
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

  app.openapi(stuckRoute, async (c) => {
    const query = c.req.valid('query');
    // 注意 0 是合法值（列出全部滞留记录），不能用 `|| 10` 兜底
    const parsedOlder = Number.parseInt(query.olderThanMinutes ?? '10', 10);
    const olderThanMinutes = Number.isFinite(parsedOlder) && parsedOlder >= 0 ? parsedOlder : 10;
    const parsedLimit = Number.parseInt(query.limit ?? '50', 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(200, parsedLimit) : 50;
    const items = await listStuckIdempotencyRecords(c.env, olderThanMinutes, limit);
    return c.json(apiData(c, { olderThanMinutes, items }), 200);
  });

  app.openapi(releaseRoute, async (c) => {
    const body = c.req.valid('json');
    const released = await releaseIdempotencyRecord(c.env, body);
    if (!released) throw notFound('没有处理中的同键记录');
    return c.json(apiData(c, { released: true }), 200);
  });
}
