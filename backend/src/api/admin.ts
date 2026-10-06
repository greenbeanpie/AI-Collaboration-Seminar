import { normalizeProcessingStrategies } from '../../../shared/audio-settings';
import { validateMediaModel, GeminiMediaClient } from '../ai/gemini-media';
import { validateMimoMediaModel, MimoMediaClient } from '../ai/mimo-media';
import { registerAdminAccountRoutes } from './admin-accounts';
import { createMiddleware } from 'hono/factory';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope, apiErrorEnvelope } from '../core/openapi';
import { nowIso, newId, timingSafeEqual } from '../core/db';
import { seal, unseal } from '../ai/secrets';
import { loadSessionUser, parseCookies, SESSION_COOKIE } from '../core/auth';
import { createAccountInvitation } from '../services/accounts';
import { AppError, versionConflict, permissionDenied, unauthenticated, invalidState, validationFailed, notFound } from '../core/errors';
import { listStuckIdempotencyRecords, releaseIdempotencyRecord } from '../services/idempotency';
import { aiConfigSchema, aiModelConfigSchema, audioFileTranscriptionSchema, realtimeAudioTranscriptionSchema, processingStrategiesSchema, rehearsalSpeechSchema, loadAiConfig, type AiPurpose } from '../ai/config';
import { probeModel } from '../ai/probe';
import { isAllowedModelEndpoint } from '../ai/gateway';
import { providerOptionErrors } from '../../../shared/ai-providers';
import { diagnosticErrorCode, recordAiDiagnostic, type DiagnosticEntry } from '../ai/diagnostics';

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
    const systemPath = c.req.path.startsWith('/api/v1/admin/ai-config') || c.req.path.startsWith('/api/v1/admin/idempotency');
    if (systemPath && user.role !== 'super_admin') throw permissionDenied('需要超级管理员权限');
    c.set('user', user);
  }
  await next();
});

const editableModel = aiModelConfigSchema.omit({ apiKeyEncrypted: true }).extend({ apiKey: z.string().max(4096).regex(/^[^\x00-\x1f\x7f]*$/).optional(), clearKey: z.boolean().optional() });
const editableMediaModel = editableModel;
const editableRealtimeTranscription = realtimeAudioTranscriptionSchema.omit({apiKeyEncrypted:true,gatewayTokenEncrypted:true}).extend({gatewayToken:z.string().max(4096).regex(/^[^\x00-\x1f\x7f]*$/).optional(),clearGatewayToken:z.boolean().optional()}).strict();
const configShape = z.object({
  rehearsalSpeech:rehearsalSpeechSchema.optional(),
  audioFileTranscription:audioFileTranscriptionSchema.optional(),
  realtimeAudioTranscription:editableRealtimeTranscription.optional(),
  clearRealtimeAudioTranscription:z.boolean().optional(),
  processingStrategies:processingStrategiesSchema.optional(),
  audioProcessingStrategy: z.enum(['whisper-first', 'gemini-only']).optional(),
  searchEnabled: z.boolean().optional(),
  routingMode: z.enum(['advanced', 'unified']).optional(),
  unified: editableModel.optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
  textEconomy: editableModel.optional(),
  visionEconomy: editableModel.optional(),
  review: editableModel.optional(),
  mediaUnderstanding: editableMediaModel.optional(),
  clearMediaUnderstanding:z.boolean().optional(),
  mimoMediaUnderstanding: editableMediaModel.optional(),
  clearMimoMediaUnderstanding:z.boolean().optional(),
  // Omitted for ordinary saves: retain an already-enabled unchanged config only.
  // Explicit true remains the separate, probe-gated activation action.
  enabled: z.boolean().optional(),
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
  summary: '保存 AI 配置新版本（探测为可选诊断；变更后停用，保存后可显式启用）',
  request: { body: { content: { 'application/json': { schema: configShape } }, required: true } },
  responses: { 201: { content: { 'application/json': { schema: putResponse } }, description: '新版本已创建' } },
});

const disableRoute = createRoute({
  method: 'post',
  path: '/api/v1/admin/ai-config/disable',
  tags: ['admin'],
  summary: '停用当前已保存 AI 配置（不提交表单草稿，不调用模型）',
  request: { body: { content: { 'application/json': { schema: z.object({ expectedVersion: z.number().int().nonnegative(), enabled: z.literal(false) }).strict() } }, required: true } },
  responses: { 201: { content: { 'application/json': { schema: putResponse } }, description: '停用版本已创建' } },
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
  app.use('/api/v1/admin/*', async (c, next) => {
    if (!/^\/api\/v1\/admin\/ai-config(?:\/probe|\/disable)?$/.test(c.req.path)) return next();
    const started = Date.now(), requestId = c.get('requestId');
    const operation: DiagnosticEntry['operation'] = c.req.path.endsWith('/probe') ? 'probe' : c.req.path.endsWith('/disable') ? 'config_disable' : c.req.method === 'PUT' ? 'config_save' : 'config_read';
    await recordAiDiagnostic(c.env, { requestId, operation, phase: 'request_started', status: 'started', durationMs: 0, errorCode: 'NONE' });
    await next();
    const failed = c.res.status >= 400;
    const current = c.error instanceof AppError ? c.error.details?.currentRevision : undefined;
    await recordAiDiagnostic(c.env, { requestId, operation, phase: 'request_finished', status: failed ? 'failed' : 'succeeded', durationMs: Math.min(3_600_000, Date.now() - started), httpStatus: c.res.status, errorCode: failed ? diagnosticErrorCode(c.error) : 'NONE', ...(typeof current === 'number' && Number.isSafeInteger(current) && current >= 0 ? { configVersion: current } : {}) });
  });
  app.use('/api/v1/admin/*', requireAdmin);
  app.openapi(createRoute({method:'post',path:'/api/v1/admin/ai-config/media-probe',tags:['admin'],summary:'只读检查官方 Gemini 模型元数据（不上传媒体，不产生生成费用）',responses:{200:{description:'模型元数据检查，不等同真实媒体质量验证',content:{'application/json':{schema:apiEnvelope(z.object({passed:z.boolean(),model:z.string(),configVersion:z.number().int(),detail:z.string()}),'MediaProbeResponse')}}}}}),async c=>{
    const loaded=await loadAiConfig(c.env.DB),model=loaded?.config.mediaUnderstanding;
    const encrypted=model?.apiKeyEncrypted;
    if(!loaded||!model||!encrypted)throw invalidState('请先保存音视频模型及 API key');
    const passed=await new GeminiMediaClient(model,await unseal(encrypted,c.env.AUTH_SECRET),fetch,c.env,c.get('requestId')).probe();
    return c.json(apiData(c,{passed,model:model.model,configVersion:loaded.version,detail:passed?'官方模型元数据可访问，支持 generateContent；音视频摘要质量需真实样本核对':'官方模型未声明 generateContent'}),200);
  });

  registerAdminAccountRoutes(app);
  app.openapi(createRoute({method:'post',path:'/api/v1/admin/ai-config/mimo-media-probe',tags:['admin'],summary:'只读检查小米官方模型列表，不产生识别费用',responses:{200:{description:'模型可访问性，不等同真实识别验证',content:{'application/json':{schema:apiEnvelope(z.object({passed:z.boolean(),model:z.string(),configVersion:z.number().int(),detail:z.string()}),'MimoMediaProbeResponse')}}}}}),async c=>{
    const loaded=await loadAiConfig(c.env.DB),model=loaded?.config.mimoMediaUnderstanding;
    const encrypted=model?.apiKeyEncrypted;
    if(!loaded||!model||!encrypted)throw invalidState('请先保存 MiMo 模型及 API key');
    const passed=await new MimoMediaClient(model,await unseal(encrypted,c.env.AUTH_SECRET),fetch,c.env,c.get('requestId')).probe();
    return c.json(apiData(c,{passed,model:model.model,configVersion:loaded.version,detail:passed?'小米官方模型列表可访问；音频识别质量需真实样本核对':'当前密钥不可访问 mimo-v2.6-pro'}),200);
  });
  app.openapi(createAccountInvitationRoute, async c => c.json(apiData(c, await createAccountInvitation(c.env, c.get('user')?.id ?? null)), 201));
  app.openapi(listAccountInvitationsRoute, async c => {
    const rows = await c.env.DB.prepare('SELECT id, created_at, used_at, used_by FROM account_invitations ORDER BY created_at DESC, id DESC LIMIT 100').all<{ id: string; created_at: string; used_at: string | null; used_by: string | null }>();
    return c.json(apiData(c, { items: rows.results.map(row => ({ id: row.id, createdAt: row.created_at, usedAt: row.used_at, usedBy: row.used_by })), nextCursor: null }), 200);
  });


  app.openapi(getRoute, async (c) => {
    const loaded = await loadAiConfig(c.env.DB, undefined, false);
    await recordAiDiagnostic(c.env, { requestId: c.get('requestId'), operation: 'config_read', phase: 'snapshot_loaded', status: 'succeeded', durationMs: 0, errorCode: 'NONE', configVersion: loaded?.version ?? 0 });
    if (!loaded) {
      return c.json(apiData(c, { id: '', version: 0, enabled: false, config: {}, notes: null }), 200);
    }
    return c.json(
      apiData(c, {
        id: loaded.id,
        version: loaded.version,
        enabled: loaded.enabled,
        config: {
          audioProcessingStrategy: loaded.config.processingStrategies?.audioFiles==='media-only'?'gemini-only':'whisper-first',
          rehearsalSpeech:loaded.config.rehearsalSpeech,
          audioFileTranscription:loaded.config.audioFileTranscription,
          processingStrategies:loaded.config.processingStrategies??normalizeProcessingStrategies(undefined,loaded.config.audioProcessingStrategy),
          ...Object.fromEntries(loaded.config.realtimeAudioTranscription?[['realtimeAudioTranscription',((entry)=>{const {apiKeyEncrypted,gatewayTokenEncrypted,...publicConfig}=entry;void apiKeyEncrypted;return {...publicConfig,gatewayTokenConfigured:Boolean(gatewayTokenEncrypted)};})(loaded.config.realtimeAudioTranscription)]]:[]),
          routingMode: loaded.config.routingMode ?? 'advanced',
          searchEnabled: loaded.config.searchEnabled === true,
          ...Object.fromEntries((['textEconomy', 'visionEconomy', 'review', 'unified', 'mediaUnderstanding', 'mimoMediaUnderstanding'] as const).flatMap(purpose => {
            const entry = loaded.config[purpose];
            if (!entry) return [];
            const { apiKeyEncrypted, ...model } = entry;
            void apiKeyEncrypted;
            return [[purpose, { ...model, keyConfigured: Boolean(apiKeyEncrypted) }]];
          })),
        },
        notes: null,
      }),
      200,
    );
  });

  app.openapi(putRoute, async (c) => {
    const body = c.req.valid('json');
    const latest = await loadAiConfig(c.env.DB, undefined, false);
    if (body.expectedVersion !== undefined && body.expectedVersion !== (latest?.version ?? 0)) throw versionConflict(latest?.version ?? 0);
    const version = (latest?.version ?? 0) + 1;
    const id = `cfg-v${version}-${newId().slice(0, 8)}`;
    const { notes } = body;
    // Legacy saves must preserve inactive drafts and must not silently switch the active route.
    const strategies=body.processingStrategies??(body.audioProcessingStrategy!==undefined?{...(latest?.config.processingStrategies??normalizeProcessingStrategies()),audioFiles:body.audioProcessingStrategy==='gemini-only'?'media-only' as const:'whisper-first' as const}:latest?.config.processingStrategies??normalizeProcessingStrategies());
    const realtimeInput=body.realtimeAudioTranscription;
    const realtime=body.clearRealtimeAudioTranscription?undefined:realtimeInput?(({gatewayToken,clearGatewayToken,...settings})=>settings)(realtimeInput):latest?.config.realtimeAudioTranscription;
    const parsed = aiConfigSchema.safeParse({ ...body, textEconomy:body.textEconomy??latest?.config.textEconomy,visionEconomy:body.visionEconomy??latest?.config.visionEconomy,review:body.review??latest?.config.review,rehearsalSpeech:body.rehearsalSpeech??latest?.config.rehearsalSpeech, audioFileTranscription:body.audioFileTranscription??latest?.config.audioFileTranscription, realtimeAudioTranscription:realtime, processingStrategies:strategies, audioProcessingStrategy:strategies.audioFiles==='media-only'?'gemini-only':'whisper-first', searchEnabled: body.searchEnabled ?? latest?.config.searchEnabled, routingMode: body.routingMode ?? latest?.config.routingMode, unified: body.unified ?? latest?.config.unified, mediaUnderstanding: body.clearMediaUnderstanding ? undefined : body.mediaUnderstanding ?? latest?.config.mediaUnderstanding, mimoMediaUnderstanding:body.clearMimoMediaUnderstanding?undefined:body.mimoMediaUnderstanding??latest?.config.mimoMediaUnderstanding });
    if (!parsed.success) throw validationFailed('统一模式需要完整模型配置');
    const config = parsed.data;
    for (const purpose of ['textEconomy', 'visionEconomy', 'review', 'unified', 'mediaUnderstanding', 'mimoMediaUnderstanding'] as const) {
      if (config.routingMode === 'unified' && purpose !== 'unified' && purpose !== 'mediaUnderstanding' && purpose !== 'mimoMediaUnderstanding') {
        config[purpose] = latest?.config[purpose] ?? config[purpose];
        continue;
      }
      const input = body[purpose];
      if (!input) continue;
      const active = config.routingMode === 'unified' ? purpose === 'unified' : purpose !== 'unified';
      if(purpose==='mediaUnderstanding')validateMediaModel(config.mediaUnderstanding!);
      if(purpose==='mimoMediaUnderstanding')validateMimoMediaModel(config.mimoMediaUnderstanding!);
      const optionErrors = active && purpose!=='mediaUnderstanding' && purpose!=='mimoMediaUnderstanding' ? providerOptionErrors(input) : [];
      if (optionErrors.length) throw validationFailed(`${purpose}: ${optionErrors.join('；')}`);
      const previous = latest?.config[purpose];
      const unifiedSupplierChange = config.routingMode === 'unified' && purpose === 'unified' && Boolean(previous) && (input.provider !== previous!.provider || input.providerPreset !== previous!.providerPreset);
      if (active && previous && input.apiUrl !== previous.apiUrl && !unifiedSupplierChange) throw validationFailed('只有在统一模型模式切换供应商时才能调整 API URL');
      if (input.apiUrl && !isAllowedModelEndpoint(input.apiUrl, c.env.ENV_NAME)) {
        throw validationFailed('API URL 必须使用公开 HTTPS 域名且不能包含查询参数（本地环境允许回环地址）');
      }
      const modelConfig = config[purpose];
      if (!modelConfig) continue;
      modelConfig.apiKeyEncrypted = input.apiKey ? await seal(input.apiKey, c.env.AUTH_SECRET) : input.clearKey ? undefined : previous?.apiKeyEncrypted;
    }
    if(config.realtimeAudioTranscription&&realtimeInput&&!body.clearRealtimeAudioTranscription){
      const previous=latest?.config.realtimeAudioTranscription;
      if(previous?.gatewayTokenEncrypted&&previous.gatewayId!==realtimeInput.gatewayId&&!realtimeInput.gatewayToken&&!realtimeInput.clearGatewayToken)throw validationFailed('切换 Gateway 时，请重新填写或清除 Cloudflare AI Gateway 认证令牌');
      config.realtimeAudioTranscription.apiKeyEncrypted=undefined;
      config.realtimeAudioTranscription.gatewayTokenEncrypted=realtimeInput.clearGatewayToken?undefined:realtimeInput.gatewayToken?await seal(realtimeInput.gatewayToken,c.env.AUTH_SECRET):previous?.gatewayTokenEncrypted;
    }
    // GET exposes the legacy omitted search switch as false; both shapes have the same authority.
    // Normalize only equivalent defaults: an actual search permission change still invalidates probes.
    const comparable = (value: typeof config) => { const {mimoMediaUnderstanding:_mimo,mediaUnderstanding: _media, audioProcessingStrategy: _audio, audioFileTranscription:_file,realtimeAudioTranscription:_realtime,processingStrategies:_strategies,rehearsalSpeech:_speech, ...core}=value; void _mimo; void _media; void _audio; void _file; void _realtime; void _strategies; void _speech; return aiConfigSchema.parse({ ...core, searchEnabled: value.searchEnabled === true, routingMode: value.routingMode ?? 'advanced' }); };
    const unchanged = Boolean(latest && JSON.stringify(comparable(config)) === JSON.stringify(comparable(latest.config)));
    const enabled = body.enabled ?? (unchanged && latest?.enabled === true);
    if (body.enabled === true) {
      if (!latest || !unchanged) throw invalidState('请先保存配置后再启用 AI');
    }
    const saved = await c.env.DB.batch([c.env.DB.prepare(
      'INSERT INTO ai_config_versions (id, version, config_json, enabled, notes, created_by, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE (SELECT COALESCE(MAX(version), 0) FROM ai_config_versions) = ?8',
    )
      .bind(id, version, JSON.stringify(config), enabled ? 1 : 0, notes ?? null, c.get('user')?.id ?? 'operator-token', nowIso(), version - 1),
      c.env.DB.prepare("INSERT INTO ai_probes(config_version_id,purpose,passed,report_json,tested_at) SELECT ?1,purpose,passed,json_set(report_json,'$.configVersion',?4),tested_at FROM ai_probes WHERE config_version_id=?2 AND ?3=1 AND EXISTS(SELECT 1 FROM ai_config_versions WHERE id=?1)").bind(id,latest?.id??null,unchanged?1:0,version),
    ]);
    const inserted=saved[0]!;
    if (!inserted.meta.changes) throw versionConflict((await loadAiConfig(c.env.DB, undefined, false))?.version ?? 0);
    await recordAiDiagnostic(c.env, { requestId: c.get('requestId'), operation: 'config_save', phase: 'config_persisted', status: 'succeeded', durationMs: 0, errorCode: 'NONE', configVersion: version, expectedVersion: body.expectedVersion });
    return c.json(apiData(c, { id, version, enabled }), 201);
  });

  app.openapi(disableRoute, async (c) => {
    const body = c.req.valid('json');
    // Copy the persisted payload verbatim: disabling must not validate, replace,
    // decrypt, or send any unsaved provider settings or credentials.
    const latest = await c.env.DB.prepare('SELECT version, config_json, notes FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{ version: number; config_json: string; notes: string | null }>();
    if (body.expectedVersion !== (latest?.version ?? 0)) throw versionConflict(latest?.version ?? 0);
    if (!latest) throw invalidState('尚未保存模型配置，AI 已处于停用状态');
    const version = latest.version + 1;
    const id = `cfg-v${version}-${newId().slice(0, 8)}`;
    const inserted = await c.env.DB.prepare(
      'INSERT INTO ai_config_versions (id, version, config_json, enabled, notes, created_by, created_at) SELECT ?1, ?2, ?3, 0, ?4, ?5, ?6 WHERE (SELECT COALESCE(MAX(version), 0) FROM ai_config_versions) = ?7',
    ).bind(id, version, latest.config_json, latest.notes, c.get('user')?.id ?? 'operator-token', nowIso(), latest.version).run();
    if (!inserted.meta.changes) {
      const current = await c.env.DB.prepare('SELECT MAX(version) AS version FROM ai_config_versions').first<{ version: number }>();
      throw versionConflict(current?.version ?? 0);
    }
    await recordAiDiagnostic(c.env, { requestId: c.get('requestId'), operation: 'config_disable', phase: 'config_persisted', status: 'succeeded', durationMs: 0, errorCode: 'NONE', configVersion: version, expectedVersion: body.expectedVersion });
    return c.json(apiData(c, { id, version, enabled: false }), 201);
  });

  app.openapi(probeRoute, async (c) => {
    const body = c.req.valid('json');
    const loaded = await loadAiConfig(c.env.DB, undefined, false);
    if (!loaded) throw invalidState('请先保存模型配置');
    const probeStarted = Date.now();
    const report = await probeModel(c.env, body.purpose as AiPurpose, loaded, c.get('requestId'));
    await c.env.DB.prepare('INSERT INTO ai_probes (config_version_id, purpose, passed, report_json, tested_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(config_version_id, purpose) DO UPDATE SET passed = excluded.passed, report_json = excluded.report_json, tested_at = excluded.tested_at')
      .bind(loaded.id, report.purpose, report.passed ? 1 : 0, JSON.stringify(report), nowIso()).run();
    await recordAiDiagnostic(c.env, { requestId: c.get('requestId'), operation: 'probe', phase: 'probe_result', status: report.passed ? 'succeeded' : 'failed', durationMs: Math.min(3_600_000, Date.now() - probeStarted), errorCode: report.passed ? 'NONE' : 'PROBE_FAILED', configVersion: loaded.version, purpose: body.purpose });
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
