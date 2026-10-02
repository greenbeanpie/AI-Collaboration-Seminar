import { sourceCitationAvailability, sourceReferenceAvailability } from '../services/source-inputs';
import { notificationStatements } from '../services/notifications';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { newId, nowIso, sha256Hex } from '../core/db';
import { invalidState, notFound, permissionDenied } from '../core/errors';
import { projectParams } from './projects';

const setParams = projectParams.extend({ setId: z.string().uuid() });
const requirementParams = projectParams.extend({ requirementId: z.string().uuid() });
const rubricParams = projectParams.extend({ rubricId: z.string().uuid() });

const citationSchema = z.object({
  sourceVersionId: z.string().uuid(),
  fragmentId: z.string().uuid(),
  pageNumber: z.number().int().nullable(),
  quote: z.string(),
  availability: z.literal('unavailable').optional(),
  deletedAt: z.string().nullable().optional(),
});

const requirementSchema = z.object({
  requirementId: z.string().uuid(),
  seq: z.number().int(),
  category: z.enum(['deadline', 'deliverable', 'format', 'scoring', 'team', 'other']),
  title: z.string(),
  detail: z.string(),
  dueDate: z.string().nullable(),
  duePrecision: z.enum(['date', 'datetime', 'unknown']),
  citations: z.array(citationSchema),
  fieldState: z.enum(['ai_suggestion', 'edited', 'confirmed']),
});
const requirementResponse = apiEnvelope(requirementSchema, 'RequirementResponse');

const setSchema = z.object({
  requirementSetId: z.string().uuid(),
  sourceVersionId: z.string().uuid().nullable(),
  sourceAvailability: z.literal('unavailable').optional(),
  sourceDeletedAt: z.string().nullable().optional(),
  status: z.enum(['draft', 'confirmed']),
  revision: z.number().int(),
  confirmedAt: z.string().nullable(),
  requirements: z.array(requirementSchema),
});
const setResponse = apiEnvelope(setSchema, 'RequirementSetResponse');
const setListResponse = apiEnvelope(z.object({ items: z.array(setSchema) }), 'RequirementSetListResponse');

const rubricSchema = z.object({
  rubricId: z.string().uuid(),
  version: z.number().int(),
  source: z.enum(['official', 'custom']),
  weights: z.array(z.object({ key: z.string(), label: z.string(), weight: z.number() })),
  notes: z.string().nullable(),
  status: z.enum(['draft', 'confirmed']),
  confirmedAt: z.string().nullable(),
  createdAt: z.string(),
});
const rubricResponse = apiEnvelope(rubricSchema, 'RubricResponse');
const rubricListResponse = apiEnvelope(z.object({ items: z.array(rubricSchema) }), 'RubricListResponse');

const patchRequirementBody = z.object({
  title: z.string().min(1).max(200).optional(),
  detail: z.string().max(2000).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  duePrecision: z.enum(['date', 'datetime', 'unknown']).optional(),
  category: z.enum(['deadline', 'deliverable', 'format', 'scoring', 'team', 'other']).optional(),
});

const weightsBody = z
  .array(z.object({ key: z.string().min(1).max(40), label: z.string().min(1).max(60), weight: z.number().min(0).max(100) }))
  .min(1)
  .max(10);

const createRubricBody = z.object({
  source: z.enum(['official', 'custom']),
  weights: weightsBody,
  notes: z.string().max(2000).optional(),
});
const patchRubricBody = z.object({
  weights: weightsBody.optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const listSetsRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/requirement-sets',
  tags: ['requirements'],
  summary: '要求集列表（可按 sourceVersionId 过滤；重新解析产生新草稿，不覆盖已确认内容）',
  request: { params: projectParams, query: z.object({ sourceVersionId: z.string().uuid().optional() }) },
  responses: { 200: { content: { 'application/json': { schema: setListResponse } }, description: '列表' } },
});

const getSetRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/requirement-sets/{setId}',
  tags: ['requirements'],
  summary: '要求集详情（含要求条目与引用）',
  request: { params: setParams },
  responses: { 200: { content: { 'application/json': { schema: setResponse } }, description: '详情' } },
});

const confirmSetRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/requirement-sets/{setId}/confirm',
  tags: ['requirements'],
  summary: '确认要求集（owner；重复确认 409）',
  request: { params: setParams },
  responses: {
    200: { content: { 'application/json': { schema: setResponse } }, description: '已确认' },
    403: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '需要负责人权限' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '已确认' },
  },
});

const patchRequirementRoute = createRoute({
  method: 'patch',
  path: '/api/v1/projects/{projectId}/requirements/{requirementId}',
  tags: ['requirements'],
  summary: '修改要求条目（field_state 变为 edited；已确认的要求集不可改）',
  request: { params: requirementParams, body: { content: { 'application/json': { schema: patchRequirementBody } }, required: true } },
  responses: {
    200: { content: { 'application/json': { schema: requirementResponse } }, description: '已修改' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '要求集已确认' },
  },
});

const listRubricsRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/rubrics',
  tags: ['requirements'],
  summary: '评分标准版本列表',
  request: { params: projectParams },
  responses: { 200: { content: { 'application/json': { schema: rubricListResponse } }, description: '列表' } },
});

const createRubricRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/rubrics',
  tags: ['requirements'],
  summary: '新增评分标准版本（草稿）',
  request: { params: projectParams, body: { content: { 'application/json': { schema: createRubricBody } }, required: true } },
  responses: { 201: { content: { 'application/json': { schema: rubricResponse } }, description: '已创建' } },
});

const patchRubricRoute = createRoute({
  method: 'patch',
  path: '/api/v1/projects/{projectId}/rubrics/{rubricId}',
  tags: ['requirements'],
  summary: '修改评分标准草稿（owner）',
  request: { params: rubricParams, body: { content: { 'application/json': { schema: patchRubricBody } }, required: true } },
  responses: {
    200: { content: { 'application/json': { schema: rubricResponse } }, description: '已修改' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '已确认不可改' },
  },
});

const confirmRubricRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/rubrics/{rubricId}/confirm',
  tags: ['requirements'],
  summary: '确认评分标准（owner）',
  request: { params: rubricParams },
  responses: { 200: { content: { 'application/json': { schema: rubricResponse } }, description: '已确认' } },
});

interface SetRow {
  id: string;
  project_id: string;
  source_version_id: string | null;
  status: 'draft' | 'confirmed';
  revision: number;
  confirmed_at: string | null;
}
interface RequirementRow {
  id: string;
  seq: number;
  category: string;
  title: string;
  detail: string;
  due_date: string | null;
  due_precision: string;
  citations_json: string;
  field_state: string;
}
interface RubricRow {
  id: string;
  project_id: string;
  version: number;
  source: 'official' | 'custom';
  weights_json: string;
  notes: string | null;
  status: 'draft' | 'confirmed';
  confirmed_at: string | null;
  created_at: string;
}

async function toRequirement(env: AppEnv['Bindings'], projectId: string, r: RequirementRow) {
  const citations = JSON.parse(r.citations_json) as Array<{ sourceVersionId?: string; fragmentId?: string; [key: string]: unknown }>;
  const references = await Promise.all(citations.map(async citation => ({ ...citation, ...await sourceCitationAvailability(env, projectId, citation) })));
  return {
    requirementId: r.id,
    seq: r.seq,
    category: r.category as 'deadline' | 'deliverable' | 'format' | 'scoring' | 'team' | 'other',
    title: r.title,
    detail: r.detail,
    dueDate: r.due_date,
    duePrecision: r.due_precision as 'date' | 'datetime' | 'unknown',
    citations: references,
    fieldState: r.field_state as 'ai_suggestion' | 'edited' | 'confirmed',
  };
}

function toRubric(r: RubricRow) {
  return {
    rubricId: r.id,
    version: r.version,
    source: r.source,
    weights: JSON.parse(r.weights_json) as Array<{ key: string; label: string; weight: number }>,
    notes: r.notes,
    status: r.status,
    confirmedAt: r.confirmed_at,
    createdAt: r.created_at,
  };
}

async function loadSet(env: AppEnv['Bindings'], setId: string, projectId: string) {
  const set = await env.DB.prepare('SELECT * FROM requirement_sets WHERE id = ?1 AND project_id = ?2')
    .bind(setId, projectId)
    .first<SetRow>();
  if (!set) throw notFound('要求集不存在');
  const reqs = await env.DB.prepare('SELECT * FROM requirements WHERE requirement_set_id = ?1 ORDER BY seq')
    .bind(setId)
    .all<RequirementRow>();
  const sourceAvailability = set.source_version_id ? await sourceReferenceAvailability(env, projectId, set.source_version_id) : undefined;
  return {
    requirementSetId: set.id,
    sourceVersionId: set.source_version_id,
    ...(sourceAvailability ? { sourceAvailability: sourceAvailability.availability, sourceDeletedAt: sourceAvailability.deletedAt } : {}),
    status: set.status,
    revision: set.revision,
    confirmedAt: set.confirmed_at,
    requirements: await Promise.all(reqs.results.map(row => toRequirement(env, projectId, row))),
  };
}

export function registerRequirementRoutes(app: OpenAPIHono<AppEnv>): void {
  // * 通配覆盖各前缀下所有深度（含 confirm 子路径）
  app.use('/api/v1/projects/:projectId/requirement-sets/*', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/requirements/*', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/rubrics/*', requireUser, requireProjectMember());

  app.openapi(listSetsRoute, async (c) => {
    const sourceVersionId = c.req.valid('query').sourceVersionId;
    const rows = await c.env.DB.prepare(
      'SELECT id, project_id, source_version_id, status, revision, confirmed_at FROM requirement_sets WHERE project_id = ?1 AND (?2 IS NULL OR source_version_id = ?2) ORDER BY created_at DESC',
    )
      .bind(c.get('member')!.projectId, sourceVersionId ?? null)
      .all<SetRow>();
    const items = [];
    for (const r of rows.results) {
      const loaded = await loadSet(c.env, r.id, c.get('member')!.projectId);
      items.push(loaded);
    }
    return c.json(apiData(c, { items }), 200);
  });

  app.openapi(getSetRoute, async (c) => {
    return c.json(apiData(c, await loadSet(c.env, c.req.valid('param').setId, c.get('member')!.projectId)), 200);
  });

  app.openapi(confirmSetRoute, async (c) => {
    const member = c.get('member')!;
    const setId = c.req.valid('param').setId;
    const set = await c.env.DB.prepare('SELECT * FROM requirement_sets WHERE id = ?1 AND project_id = ?2')
      .bind(setId, member.projectId)
      .first<SetRow>();
    if (!set) throw notFound('要求集不存在');
    if (member.role !== 'owner') throw permissionDenied('确认要求集需要负责人权限');
    if (set.status === 'confirmed') throw invalidState('要求集已确认');
    const now = nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE requirement_sets SET status = 'confirmed', confirmed_by = ?2, confirmed_at = ?3, updated_at = ?3 WHERE id = ?1",
      ).bind(setId, c.get('user')!.id, now),
      c.env.DB.prepare("UPDATE requirements SET field_state = 'confirmed', updated_at = ?2 WHERE requirement_set_id = ?1").bind(setId, now),
      ...notificationStatements(c.env, { key: `requirements_confirmed:${setId}`, kind: 'requirements_confirmed', scope: 'project', resourceId: member.projectId, actorId: c.get('user')!.id, now, url: `/app/projects/${member.projectId}/requirements`, record: { table: 'requirement_sets', id: setId } }),
    ]);
    return c.json(apiData(c, await loadSet(c.env, setId, member.projectId)), 200);
  });

  app.openapi(patchRequirementRoute, async (c) => {
    const body = c.req.valid('json');
    const requirementId = c.req.valid('param').requirementId;
    const row = await c.env.DB.prepare(
      `SELECT r.*, s.status AS set_status FROM requirements r JOIN requirement_sets s ON s.id = r.requirement_set_id
       WHERE r.id = ?1 AND r.project_id = ?2`,
    )
      .bind(requirementId, c.get('member')!.projectId)
      .first<RequirementRow & { set_status: string }>();
    if (!row) throw notFound('要求条目不存在');
    if (row.set_status === 'confirmed') throw invalidState('要求集已确认，不可修改');
    const now = nowIso();
    const intent = c.req.header('idempotency-key');
    const eventKey = `requirement_changed:${requirementId}:${c.get('user')!.id}:${intent ? await sha256Hex(intent + JSON.stringify(body)) : newId()}`;
    await c.env.DB.batch([c.env.DB.prepare(
      `UPDATE requirements SET
         title = COALESCE(?2, title),
         detail = COALESCE(?3, detail),
         due_date = CASE WHEN ?4 = 1 THEN ?5 ELSE due_date END,
         due_precision = COALESCE(?6, due_precision),
         category = COALESCE(?7, category),
         field_state = 'edited',
         updated_at = ?8
       WHERE id = ?1`,
    )
      .bind(
        requirementId,
        body.title ?? null,
        body.detail ?? null,
        'dueDate' in body ? 1 : 0,
        body.dueDate ?? null,
        body.duePrecision ?? null,
        body.category ?? null,
        now,
      ),
      ...notificationStatements(c.env, { key: eventKey, kind: 'requirement_changed', scope: 'project', resourceId: c.get('member')!.projectId, actorId: c.get('user')!.id, now, url: `/app/projects/${c.get('member')!.projectId}/requirements`, record: { table: 'requirements', id: requirementId } }),
    ]);
    const updated = await c.env.DB.prepare('SELECT * FROM requirements WHERE id = ?1').bind(requirementId).first<RequirementRow>();
    if (!updated) throw notFound('要求条目不存在');
    return c.json(apiData(c, await toRequirement(c.env, c.get('member')!.projectId, updated)), 200);
  });

  app.openapi(listRubricsRoute, async (c) => {
    const rows = await c.env.DB.prepare(
      'SELECT * FROM rubric_versions WHERE project_id = ?1 ORDER BY version DESC',
    )
      .bind(c.get('member')!.projectId)
      .all<RubricRow>();
    return c.json(apiData(c, { items: rows.results.map(toRubric) }), 200);
  });

  app.openapi(createRubricRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const latest = await c.env.DB.prepare('SELECT MAX(version) AS v FROM rubric_versions WHERE project_id = ?1')
      .bind(member.projectId)
      .first<{ v: number | null }>();
    const version = (latest?.v ?? 0) + 1;
    const id = newId();
    await c.env.DB.prepare(
      "INSERT INTO rubric_versions (id, project_id, version, source, weights_json, notes, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'draft', ?7)",
    )
      .bind(id, member.projectId, version, body.source, JSON.stringify(body.weights), body.notes ?? null, nowIso())
      .run();
    const row = await c.env.DB.prepare('SELECT * FROM rubric_versions WHERE id = ?1').bind(id).first<RubricRow>();
    if (!row) throw notFound('评分标准创建失败');
    return c.json(apiData(c, toRubric(row)), 201);
  });

  app.openapi(patchRubricRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    if (member.role !== 'owner') throw permissionDenied('修改评分标准需要负责人权限');
    const rubricId = c.req.valid('param').rubricId;
    const row = await c.env.DB.prepare('SELECT * FROM rubric_versions WHERE id = ?1 AND project_id = ?2')
      .bind(rubricId, member.projectId)
      .first<RubricRow>();
    if (!row) throw notFound('评分标准不存在');
    if (row.status === 'confirmed') throw invalidState('已确认的评分标准不可修改（请新增版本）');
    await c.env.DB.prepare('UPDATE rubric_versions SET weights_json = COALESCE(?2, weights_json), notes = CASE WHEN ?3 = 1 THEN ?4 ELSE notes END WHERE id = ?1')
      .bind(rubricId, body.weights ? JSON.stringify(body.weights) : null, 'notes' in body ? 1 : 0, body.notes ?? null)
      .run();
    const updated = await c.env.DB.prepare('SELECT * FROM rubric_versions WHERE id = ?1').bind(rubricId).first<RubricRow>();
    if (!updated) throw notFound('评分标准不存在');
    return c.json(apiData(c, toRubric(updated)), 200);
  });

  app.openapi(confirmRubricRoute, async (c) => {
    const member = c.get('member')!;
    if (member.role !== 'owner') throw permissionDenied('确认评分标准需要负责人权限');
    const rubricId = c.req.valid('param').rubricId;
    const row = await c.env.DB.prepare('SELECT * FROM rubric_versions WHERE id = ?1 AND project_id = ?2')
      .bind(rubricId, member.projectId)
      .first<RubricRow>();
    if (!row) throw notFound('评分标准不存在');
    if (row.status === 'confirmed') throw invalidState('评分标准已确认');
    await c.env.DB.prepare(
      "UPDATE rubric_versions SET status = 'confirmed', confirmed_by = ?2, confirmed_at = ?3 WHERE id = ?1",
    )
      .bind(rubricId, c.get('user')!.id, nowIso())
      .run();
    const updated = await c.env.DB.prepare('SELECT * FROM rubric_versions WHERE id = ?1').bind(rubricId).first<RubricRow>();
    if (!updated) throw notFound('评分标准不存在');
    return c.json(apiData(c, toRubric(updated)), 200);
  });
}
