import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { newId, nowIso } from '../core/db';
import { notFound, validationFailed } from '../core/errors';
import { parsePaging, nextCursor } from '../core/pagination';
import { recordEvent } from '../services/events';
import { projectParams } from './projects';

const decisionParams = projectParams.extend({ decisionId: z.string().uuid() });
const contributionParams = projectParams.extend({ contributionId: z.string().uuid() });

// ========== 事件账本 ==========
const eventsRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/events',
  tags: ['ledger'],
  summary: '过程账本（决策/贡献/AI 使用记录事件流，游标分页）',
  request: {
    params: projectParams,
    query: z.object({ cursor: z.string().optional(), limit: z.string().optional(), type: z.string().optional() }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: apiEnvelope(
            z.object({
              items: z.array(
                z.object({
                  eventId: z.string().uuid(),
                  type: z.string(),
                  actorType: z.enum(['user', 'ai', 'system']),
                  actorId: z.string(),
                  entityType: z.string(),
                  entityId: z.string(),
                  payload: z.record(z.string(), z.unknown()),
                  occurredAt: z.string(),
                }),
              ),
              nextCursor: z.string().nullable(),
            }),
            'EventListResponse',
          ),
        },
      },
      description: '事件列表',
    },
  },
});

// ========== 决策 ==========
const decisionSchema = z.object({
  decisionId: z.string().uuid(),
  title: z.string(),
  detail: z.string(),
  madeBy: z.string().uuid(),
  decidedAt: z.string(),
  createdAt: z.string(),
});
const decisionResponse = apiEnvelope(decisionSchema, 'DecisionResponse');
const decisionListResponse = apiEnvelope(z.object({ items: z.array(decisionSchema) }), 'DecisionListResponse');

const decisionCreateBody = z.object({
  title: z.string().min(1).max(200),
  detail: z.string().max(4000).default(''),
  decidedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/).optional(),
});

const decisionCreateRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/decisions',
  tags: ['ledger'],
  summary: '补录决策记录',
  request: { params: projectParams, body: { content: { 'application/json': { schema: decisionCreateBody } }, required: true } },
  responses: { 201: { content: { 'application/json': { schema: decisionResponse } }, description: '已记录' } },
});

const decisionListRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/decisions',
  tags: ['ledger'],
  summary: '决策记录列表',
  request: { params: projectParams },
  responses: { 200: { content: { 'application/json': { schema: decisionListResponse } }, description: '列表' } },
});

// ========== 贡献 ==========
const contributionSchema = z.object({
  contributionId: z.string().uuid(),
  userId: z.string().uuid(),
  kind: z.string(),
  description: z.string(),
  correctionOf: z.string().uuid().nullable(),
  createdAt: z.string(),
});
const contributionResponse = apiEnvelope(contributionSchema, 'ContributionResponse');
const contributionListResponse = apiEnvelope(z.object({ items: z.array(contributionSchema) }), 'ContributionListResponse');

const contributionCreateBody = z.object({
  userId: z.string().uuid().optional(),
  kind: z.string().min(1).max(40).default('manual'),
  description: z.string().min(1).max(2000),
  evidence: z.record(z.string(), z.unknown()).default({}),
});

const contributionCreateRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/contributions',
  tags: ['ledger'],
  summary: '补录贡献记录',
  request: { params: projectParams, body: { content: { 'application/json': { schema: contributionCreateBody } }, required: true } },
  responses: { 201: { content: { 'application/json': { schema: contributionResponse } }, description: '已记录' } },
});

const contributionListRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/contributions',
  tags: ['ledger'],
  summary: '贡献记录列表（更正保留原记录）',
  request: { params: projectParams },
  responses: { 200: { content: { 'application/json': { schema: contributionListResponse } }, description: '列表' } },
});

const correctionCreateBody = z.object({
  description: z.string().min(1).max(2000),
});

const correctionCreateRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/contributions/{contributionId}/corrections',
  tags: ['ledger'],
  summary: '对贡献记录提出更正（原记录保留，新增更正条目）',
  request: { params: contributionParams, body: { content: { 'application/json': { schema: correctionCreateBody } }, required: true } },
  responses: { 201: { content: { 'application/json': { schema: contributionResponse } }, description: '更正已记录' } },
});

// ========== 第三方来源声明 ==========
const resourceSchema = z.object({
  resourceId: z.string().uuid(),
  kind: z.enum(['url', 'file', 'model', 'other']),
  title: z.string(),
  url: z.string().nullable(),
  fileId: z.string().uuid().nullable(),
  declaredBy: z.string().uuid(),
  createdAt: z.string(),
});
const resourceResponse = apiEnvelope(resourceSchema, 'ResourceResponse');
const resourceListResponse = apiEnvelope(z.object({ items: z.array(resourceSchema) }), 'ResourceListResponse');

const resourceCreateBody = z.object({
  kind: z.enum(['url', 'file', 'model', 'other']),
  title: z.string().min(1).max(200),
  url: z.string().max(2048).nullish(),
  fileId: z.string().uuid().nullish(),
  meta: z.record(z.string(), z.unknown()).default({}),
});

const resourceCreateRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/resources',
  tags: ['ledger'],
  summary: '声明第三方资源（图片/模型/引用等）',
  request: { params: projectParams, body: { content: { 'application/json': { schema: resourceCreateBody } }, required: true } },
  responses: { 201: { content: { 'application/json': { schema: resourceResponse } }, description: '已声明' } },
});

const resourceListRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/resources',
  tags: ['ledger'],
  summary: '第三方资源声明列表',
  request: { params: projectParams },
  responses: { 200: { content: { 'application/json': { schema: resourceListResponse } }, description: '列表' } },
});

// ========== 导出 ==========
const exportRequirementSchema = z.object({
  requirementId: z.string().uuid(),
  seq: z.number().int(),
  category: z.enum(['deadline', 'deliverable', 'format', 'scoring', 'team', 'other']),
  title: z.string(),
  detail: z.string(),
  dueDate: z.string().nullable(),
  duePrecision: z.enum(['date', 'datetime', 'unknown']),
  citations: z.array(z.object({
    sourceVersionId: z.string().uuid(),
    fragmentId: z.string().uuid(),
    pageNumber: z.number().int().nullable(),
    quote: z.string(),
  })),
  fieldState: z.enum(['ai_suggestion', 'edited', 'confirmed']),
});

const exportBundleResponse = apiEnvelope(z.object({
  project: z.object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string(),
    competition_deadline_date: z.string().nullable(),
    status: z.string(),
  }),
  generatedAt: z.string(),
  materials: z.array(z.object({ title: z.string(), markdown: z.string(), revision: z.number().int(), attachments: z.array(z.object({ fileId: z.string(), name: z.string() })) })),
  requirementSets: z.array(z.object({
    requirementSetId: z.string().uuid(),
    sourceVersionId: z.string().uuid().nullable(),
    status: z.enum(['draft', 'confirmed']),
    revision: z.number().int(),
    confirmedAt: z.string().nullable(),
    requirements: z.array(exportRequirementSchema),
  })),
  rubricVersions: z.array(z.object({
    rubricId: z.string().uuid(),
    version: z.number().int(),
    source: z.enum(['official', 'custom']),
    weights: z.array(z.object({ key: z.string(), label: z.string(), weight: z.number() })),
    notes: z.string().nullable(),
    status: z.enum(['draft', 'confirmed']),
    confirmedAt: z.string().nullable(),
    createdAt: z.string(),
  })),
  tasks: z.array(z.object({ title: z.string(), status: z.string(), assignee_id: z.string().nullable(), due_date: z.string().nullable() })),
  decisions: z.array(z.object({ title: z.string(), detail: z.string(), decided_at: z.string() })),
  contributions: z.array(z.object({ user_id: z.string().uuid(), kind: z.string(), description: z.string(), correction_of: z.string().uuid().nullable() })),
  resources: z.array(z.object({ kind: z.string(), title: z.string(), url: z.string().nullable() })),
  events: z.array(z.object({ type: z.string(), occurred_at: z.string() })),
  aiUsage: z.object({
    calls: z.number().int(),
    promptTokens: z.number().int(),
    completionTokens: z.number().int(),
    costStatus: z.string(),
    note: z.string(),
  }),
}), 'ExportBundleResponse');

const exportRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/export-bundle',
  tags: ['ledger'],
  summary: '导出成果说明 JSON 汇总（材料 Markdown + 要求 + 账本 + 声明）',
  request: { params: projectParams },
  responses: {
    200: { content: { 'application/json': { schema: exportBundleResponse } }, description: '导出汇总' },
  },
});

export function registerLedgerRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects/:projectId/events/*', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/decisions/*', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/contributions/*', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/resources/*', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/export-bundle/*', requireUser, requireProjectMember());

  app.openapi(eventsRoute, async (c) => {
    const member = c.get('member')!;
    const paging = parsePaging(c.req.valid('query'));
    const type = c.req.valid('query').type;
    const binds: unknown[] = [member.projectId];
    let where = 'project_id = ?1';
    if (type) {
      binds.push(type);
      where += ` AND type = ?${binds.length}`;
    }
    if (paging.cursor) {
      binds.push(paging.cursor.createdAt, paging.cursor.createdAt, paging.cursor.id);
      where += ' AND (occurred_at < ? OR (occurred_at = ? AND id < ?))';
    }
    binds.push(paging.limit + 1);
    const rows = await c.env.DB.prepare(
      `SELECT * FROM events WHERE ${where} ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    )
      .bind(...binds)
      .all<{ id: string; type: string; actor_type: string; actor_id: string; entity_type: string; entity_id: string; payload_json: string; occurred_at: string }>();
    const hasMore = rows.results.length > paging.limit;
    const pageRows = rows.results.slice(0, paging.limit);
    const lastRow = pageRows[pageRows.length - 1];
    return c.json(
      apiData(c, {
        items: pageRows.map((r) => ({
          eventId: r.id,
          type: r.type,
          actorType: r.actor_type as 'user' | 'ai' | 'system',
          actorId: r.actor_id,
          entityType: r.entity_type,
          entityId: r.entity_id,
          payload: JSON.parse(r.payload_json) as Record<string, unknown>,
          occurredAt: r.occurred_at,
        })),
        nextCursor: nextCursor(hasMore, lastRow ? { createdAt: lastRow.occurred_at, id: lastRow.id } : undefined) ?? null,
      }),
      200,
    );
  });

  app.openapi(decisionCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const user = c.get('user')!;
    const id = newId();
    const decidedAt = body.decidedAt ?? nowIso();
    await c.env.DB.prepare(
      "INSERT INTO decisions (id, project_id, title, detail, made_by, decided_at, related_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}', ?7)",
    )
      .bind(id, member.projectId, body.title, body.detail, user.id, decidedAt, nowIso())
      .run();
    await recordEvent(c.env, {
      projectId: member.projectId,
      actorType: 'user',
      actorId: user.id,
      type: 'decision.recorded',
      entityType: 'decision',
      entityId: id,
      dedupKey: id,
      payload: { title: body.title },
    });
    return c.json(apiData(c, { decisionId: id, title: body.title, detail: body.detail, madeBy: user.id, decidedAt, createdAt: nowIso() }), 201);
  });

  app.openapi(decisionListRoute, async (c) => {
    const rows = await c.env.DB.prepare('SELECT * FROM decisions WHERE project_id = ?1 ORDER BY decided_at DESC')
      .bind(c.get('member')!.projectId)
      .all<{ id: string; title: string; detail: string; made_by: string; decided_at: string; created_at: string }>();
    return c.json(
      apiData(c, {
        items: rows.results.map((r) => ({ decisionId: r.id, title: r.title, detail: r.detail, madeBy: r.made_by, decidedAt: r.decided_at, createdAt: r.created_at })),
      }),
      200,
    );
  });

  app.openapi(contributionCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const userId = body.userId ?? c.get('user')!.id;
    const id = newId();
    const now = nowIso();
    await c.env.DB.prepare(
      'INSERT INTO contributions (id, project_id, user_id, kind, description, evidence_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)',
    )
      .bind(id, member.projectId, userId, body.kind, body.description, JSON.stringify(body.evidence), now)
      .run();
    return c.json(apiData(c, { contributionId: id, userId, kind: body.kind, description: body.description, correctionOf: null, createdAt: now }), 201);
  });

  app.openapi(contributionListRoute, async (c) => {
    const rows = await c.env.DB.prepare('SELECT * FROM contributions WHERE project_id = ?1 ORDER BY created_at DESC')
      .bind(c.get('member')!.projectId)
      .all<{ id: string; user_id: string; kind: string; description: string; correction_of: string | null; created_at: string }>();
    return c.json(
      apiData(c, {
        items: rows.results.map((r) => ({ contributionId: r.id, userId: r.user_id, kind: r.kind, description: r.description, correctionOf: r.correction_of, createdAt: r.created_at })),
      }),
      200,
    );
  });

  app.openapi(correctionCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const contributionId = c.req.valid('param').contributionId;
    const original = await c.env.DB.prepare('SELECT * FROM contributions WHERE id = ?1 AND project_id = ?2')
      .bind(contributionId, member.projectId)
      .first<{ id: string; user_id: string; kind: string }>();
    if (!original) throw notFound('贡献记录不存在');
    const id = newId();
    const now = nowIso();
    await c.env.DB.prepare(
      "INSERT INTO contributions (id, project_id, user_id, kind, description, evidence_json, correction_of, created_at, updated_at) VALUES (?1, ?2, ?3, 'correction', ?4, ?5, ?6, ?7, ?8)",
    )
      .bind(id, member.projectId, original.user_id, body.description, JSON.stringify({ originalKind: original.kind }), contributionId, now, now)
      .run();
    return c.json(apiData(c, { contributionId: id, userId: original.user_id, kind: 'correction', description: body.description, correctionOf: contributionId, createdAt: now }), 201);
  });

  app.openapi(resourceCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const user = c.get('user')!;
    if (body.kind === 'url' && !body.url) throw validationFailed('url 类资源必须提供 url');
    const id = newId();
    const now = nowIso();
    await c.env.DB.prepare(
      'INSERT INTO resource_references (id, project_id, kind, title, url, file_id, meta_json, declared_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)',
    )
      .bind(id, member.projectId, body.kind, body.title, body.url ?? null, body.fileId ?? null, JSON.stringify(body.meta), user.id, now)
      .run();
    return c.json(apiData(c, { resourceId: id, kind: body.kind, title: body.title, url: body.url ?? null, fileId: body.fileId ?? null, declaredBy: user.id, createdAt: now }), 201);
  });

  app.openapi(resourceListRoute, async (c) => {
    const rows = await c.env.DB.prepare('SELECT * FROM resource_references WHERE project_id = ?1 ORDER BY created_at DESC')
      .bind(c.get('member')!.projectId)
      .all<{ id: string; kind: string; title: string; url: string | null; file_id: string | null; declared_by: string; created_at: string }>();
    return c.json(
      apiData(c, {
        items: rows.results.map((r) => ({ resourceId: r.id, kind: r.kind as 'url' | 'file' | 'model' | 'other', title: r.title, url: r.url, fileId: r.file_id, declaredBy: r.declared_by, createdAt: r.created_at })),
      }),
      200,
    );
  });

  app.openapi(exportRoute, async (c) => {
    const member = c.get('member')!;
    const projectId = member.projectId;

    const project = await c.env.DB.prepare('SELECT id, name, description, competition_deadline_date, status FROM projects WHERE id = ?1')
      .bind(projectId)
      .first<{ id: string; name: string; description: string; competition_deadline_date: string | null; status: string }>();
    if (!project) throw notFound('项目不存在');

    const materials = await c.env.DB.prepare(
      `SELECT m.title, v.markdown, v.attachments_json, v.revision FROM materials m JOIN material_versions v ON v.id = m.current_version_id WHERE m.project_id = ?1 ORDER BY m.created_at`,
    )
      .bind(projectId)
      .all<{ title: string; markdown: string; revision: number; attachments_json: string }>();

    const requirementSets = await c.env.DB.prepare(
      'SELECT id, source_version_id, status, revision, confirmed_at FROM requirement_sets WHERE project_id = ?1 ORDER BY created_at, id',
    )
      .bind(projectId)
      .all<{ id: string; source_version_id: string | null; status: 'draft' | 'confirmed'; revision: number; confirmed_at: string | null }>();
    const requirements = await c.env.DB.prepare(
      'SELECT id, requirement_set_id, seq, category, title, detail, due_date, due_precision, citations_json, field_state FROM requirements WHERE project_id = ?1 ORDER BY requirement_set_id, seq, id',
    )
      .bind(projectId)
      .all<{
        id: string; requirement_set_id: string; seq: number; category: string; title: string; detail: string;
        due_date: string | null; due_precision: string; citations_json: string; field_state: string;
      }>();
    const requirementsBySet = new Map<string, typeof requirements.results>();
    for (const requirement of requirements.results) {
      const list = requirementsBySet.get(requirement.requirement_set_id) ?? [];
      list.push(requirement);
      requirementsBySet.set(requirement.requirement_set_id, list);
    }

    const rubricVersions = await c.env.DB.prepare(
      'SELECT id, version, source, weights_json, notes, status, confirmed_at, created_at FROM rubric_versions WHERE project_id = ?1 ORDER BY version',
    )
      .bind(projectId)
      .all<{
        id: string; version: number; source: 'official' | 'custom'; weights_json: string; notes: string | null;
        status: 'draft' | 'confirmed'; confirmed_at: string | null; created_at: string;
      }>();

    const tasks = await c.env.DB.prepare('SELECT title, status, assignee_id, due_date FROM tasks WHERE project_id = ?1 ORDER BY created_at')
      .bind(projectId)
      .all<{ title: string; status: string; assignee_id: string | null; due_date: string | null }>();

    const decisions = await c.env.DB.prepare('SELECT title, detail, decided_at FROM decisions WHERE project_id = ?1 ORDER BY decided_at')
      .bind(projectId)
      .all<{ title: string; detail: string; decided_at: string }>();

    const contributions = await c.env.DB.prepare('SELECT user_id, kind, description, correction_of FROM contributions WHERE project_id = ?1 ORDER BY created_at')
      .bind(projectId)
      .all<{ user_id: string; kind: string; description: string; correction_of: string | null }>();

    const resources = await c.env.DB.prepare('SELECT kind, title, url FROM resource_references WHERE project_id = ?1 ORDER BY created_at')
      .bind(projectId)
      .all<{ kind: string; title: string; url: string | null }>();

    const events = await c.env.DB.prepare('SELECT type, occurred_at FROM events WHERE project_id = ?1 ORDER BY occurred_at DESC LIMIT 200')
      .bind(projectId)
      .all<{ type: string; occurred_at: string }>();

    const aiUsage = await c.env.DB.prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              CASE WHEN COUNT(*) = 0 OR SUM(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END) > 0
                   THEN 'unknown' ELSE 'known' END AS cost_status
         FROM ai_calls WHERE project_id = ?1`,
    )
      .bind(projectId)
      .first<{ calls: number; prompt_tokens: number; completion_tokens: number; cost_status: string }>();

    return c.json(
      apiData(c, {
        project,
        generatedAt: nowIso(),
        materials: materials.results.map(({ attachments_json, ...material }) => ({ ...material, attachments: JSON.parse(attachments_json) as Array<{ fileId: string; name: string }> })),
        requirementSets: requirementSets.results.map((set) => ({
          requirementSetId: set.id,
          sourceVersionId: set.source_version_id,
          status: set.status,
          revision: set.revision,
          confirmedAt: set.confirmed_at,
          requirements: (requirementsBySet.get(set.id) ?? []).map((requirement) => ({
            requirementId: requirement.id,
            seq: requirement.seq,
            category: requirement.category as 'deadline' | 'deliverable' | 'format' | 'scoring' | 'team' | 'other',
            title: requirement.title,
            detail: requirement.detail,
            dueDate: requirement.due_date,
            duePrecision: requirement.due_precision as 'date' | 'datetime' | 'unknown',
            citations: JSON.parse(requirement.citations_json) as Array<{
              sourceVersionId: string; fragmentId: string; pageNumber: number | null; quote: string;
            }>,
            fieldState: requirement.field_state as 'ai_suggestion' | 'edited' | 'confirmed',
          })),
        })),
        rubricVersions: rubricVersions.results.map((rubric) => ({
          rubricId: rubric.id,
          version: rubric.version,
          source: rubric.source,
          weights: JSON.parse(rubric.weights_json) as Array<{ key: string; label: string; weight: number }>,
          notes: rubric.notes,
          status: rubric.status,
          confirmedAt: rubric.confirmed_at,
          createdAt: rubric.created_at,
        })),
        tasks: tasks.results,
        decisions: decisions.results,
        contributions: contributions.results,
        resources: resources.results,
        events: events.results,
        aiUsage: {
          calls: aiUsage?.calls ?? 0,
          promptTokens: aiUsage?.prompt_tokens ?? 0,
          completionTokens: aiUsage?.completion_tokens ?? 0,
          costStatus: aiUsage?.cost_status ?? 'unknown',
          note: '费用未知时如实标注，不填零',
        },
      }),
      200,
    );
  });
}
