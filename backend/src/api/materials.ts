import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { newId, nowIso } from '../core/db';
import { notFound, validationFailed, versionConflict } from '../core/errors';import { parsePaging, nextCursor } from '../core/pagination';
import { docToMarkdown, isTiptapDoc } from '../services/tiptap';
import { projectParams } from './projects';

const DOC_MAX_BYTES = 200 * 1024;

const materialParams = projectParams.extend({ materialId: z.string().uuid() });
const versionParams = materialParams.extend({ versionId: z.string().uuid() });

const attachmentSchema = z.object({ fileId: z.string().uuid(), name: z.string() });
const materialSchema = z.object({
  materialId: z.string().uuid(),
  title: z.string(),
  kind: z.string(),
  revision: z.number().int(),
  currentVersion: z
    .object({
      versionId: z.string().uuid(),
      revision: z.number().int(),
      doc: z.record(z.string(), z.unknown()),
      markdown: z.string(),
      attachments: z.array(attachmentSchema),
      origin: z.enum(['manual', 'ai_adoption']),
      authorId: z.string().uuid(),
      createdAt: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const materialResponse = apiEnvelope(materialSchema, 'MaterialResponse');
const materialListResponse = apiEnvelope(z.object({ items: z.array(materialSchema.omit({ currentVersion: true }).extend({ currentVersionId: z.string().uuid().nullable() })), nextCursor: z.string().nullable() }), 'MaterialListResponse');

const versionSchema = z.object({
  versionId: z.string().uuid(),
  revision: z.number().int(),
  doc: z.record(z.string(), z.unknown()),
  markdown: z.string(),
  attachments: z.array(attachmentSchema),
  origin: z.enum(['manual', 'ai_adoption']),
  aiRunId: z.string().uuid().nullable(),
  authorId: z.string().uuid(),
  createdAt: z.string(),
});
const versionResponse = apiEnvelope(versionSchema, 'MaterialVersionResponse');
const versionListResponse = apiEnvelope(z.object({ items: z.array(versionSchema.omit({ doc: true })), nextCursor: z.string().nullable() }), 'MaterialVersionListResponse');

const createBody = z.object({
  title: z.string().min(1).max(200),
  kind: z.string().min(1).max(40).default('document'),
});

const saveBody = z.object({
  expectedRevision: z.number().int().min(1),
  doc: z.record(z.string(), z.unknown()),
  markdown: z.string().max(200_000).optional(),
  attachmentIds: z.array(z.string().uuid()).max(20).optional(),
});

const materialCreateRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/materials',
  tags: ['materials'],
  summary: '创建材料（含空初始版本）',
  request: { params: projectParams, body: { content: { 'application/json': { schema: createBody } }, required: true } },
  responses: { 201: { content: { 'application/json': { schema: materialResponse } }, description: '已创建' } },
});

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/materials',
  tags: ['materials'],
  summary: '材料列表（游标分页）',
  request: { params: projectParams, query: z.object({ cursor: z.string().optional(), limit: z.string().optional() }) },
  responses: { 200: { content: { 'application/json': { schema: materialListResponse } }, description: '列表' } },
});

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/materials/{materialId}',
  tags: ['materials'],
  summary: '材料详情（含当前版本内容）',
  request: { params: materialParams },
  responses: { 200: { content: { 'application/json': { schema: materialResponse } }, description: '详情' } },
});

const saveRoute = createRoute({
  method: 'put',
  path: '/api/v1/projects/{projectId}/materials/{materialId}',
  tags: ['materials'],
  summary: '保存材料（expectedRevision 乐观锁；产生不可变新版本；409 冲突时保留本地内容）',
  request: { params: materialParams, body: { content: { 'application/json': { schema: saveBody } }, required: true } },
  responses: {
    201: { content: { 'application/json': { schema: versionResponse } }, description: '新版本已创建' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '版本冲突（details.currentRevision）' },
  },
});

const listVersionsRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/materials/{materialId}/versions',
  tags: ['materials'],
  summary: '版本历史（不含 doc 正文，游标分页）',
  request: { params: materialParams, query: z.object({ cursor: z.string().optional(), limit: z.string().optional() }) },
  responses: { 200: { content: { 'application/json': { schema: versionListResponse } }, description: '版本列表' } },
});

const getVersionRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/materials/{materialId}/versions/{versionId}',
  tags: ['materials'],
  summary: '版本详情（不可变快照）',
  request: { params: versionParams },
  responses: { 200: { content: { 'application/json': { schema: versionResponse } }, description: '版本内容' } },
});

interface MaterialRow {
  id: string;
  project_id: string;
  title: string;
  kind: string;
  current_version_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  material_id: string;
  revision: number;
  doc_json: string;
  attachments_json: string;
  markdown: string;
  origin: 'manual' | 'ai_adoption';
  ai_run_id: string | null;
  author_id: string;
  created_at: string;
}

function toVersion(r: VersionRow) {
  return {
    versionId: r.id,
    revision: r.revision,
    doc: JSON.parse(r.doc_json) as Record<string, unknown>,
    markdown: r.markdown,
    attachments: JSON.parse(r.attachments_json ?? '[]') as Array<{ fileId: string; name: string }>,
    origin: r.origin,
    aiRunId: r.ai_run_id,
    authorId: r.author_id,
    createdAt: r.created_at,
  };
}

async function loadMaterial(env: AppEnv['Bindings'], materialId: string, projectId: string): Promise<MaterialRow> {
  const row = await env.DB.prepare('SELECT * FROM materials WHERE id = ?1 AND project_id = ?2')
    .bind(materialId, projectId)
    .first<MaterialRow>();
  if (!row) throw notFound('材料不存在');
  return row;
}

async function loadVersion(env: AppEnv['Bindings'], versionId: string, projectId: string, materialId?: string): Promise<VersionRow> {
  const row = await env.DB.prepare(
    'SELECT v.* FROM material_versions v JOIN materials m ON m.id = v.material_id WHERE v.id = ?1 AND m.project_id = ?2 AND (?3 IS NULL OR v.material_id = ?3)',
  )
    .bind(versionId, projectId, materialId ?? null)
    .first<VersionRow>();
  if (!row) throw notFound('材料版本不存在');
  return row;
}

async function materialDetail(env: AppEnv['Bindings'], material: MaterialRow) {
  const current = material.current_version_id
    ? await env.DB.prepare('SELECT * FROM material_versions WHERE id = ?1').bind(material.current_version_id).first<VersionRow>()
    : null;
  return {
    materialId: material.id,
    title: material.title,
    kind: material.kind,
    revision: material.revision,
    currentVersion: current
      ? {
          versionId: current.id,
          revision: current.revision,
          doc: JSON.parse(current.doc_json) as Record<string, unknown>,
          markdown: current.markdown,
          attachments: JSON.parse(current.attachments_json ?? '[]') as Array<{ fileId: string; name: string }>,
          origin: current.origin,
          authorId: current.author_id,
          createdAt: current.created_at,
        }
      : null,
    createdAt: material.created_at,
    updatedAt: material.updated_at,
  };
}

export function registerMaterialRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects/:projectId/materials/*', requireUser, requireProjectMember());

  app.openapi(materialCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const user = c.get('user')!;
    const materialId = newId();
    const versionId = newId();
    const now = nowIso();
    const headings = ['作品概述', '问题与需求', '方案与创新', '实现与验证', '团队分工', '风险与后续计划'];
    const emptyDoc = body.kind === 'work-introduction' ? { type: 'doc', content: headings.flatMap(text => [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] },
      { type: 'paragraph', content: [{ type: 'text', text: '待填写并人工核验' }] },
    ]) } : { type: 'doc', content: [] };
    await c.env.DB.batch([
      c.env.DB.prepare(
        'INSERT INTO materials (id, project_id, title, kind, current_version_id, revision, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?7)',
      ).bind(materialId, member.projectId, body.title, body.kind, versionId, user.id, now),
      c.env.DB.prepare(
        `INSERT INTO material_versions (id, material_id, project_id, revision, doc_json, markdown, origin, author_id, created_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?5, 'manual', ?6, ?7)`,
      ).bind(versionId, materialId, member.projectId, JSON.stringify(emptyDoc), docToMarkdown(emptyDoc), user.id, now),
    ]);
    const material = await loadMaterial(c.env, materialId, member.projectId);
    return c.json(apiData(c, await materialDetail(c.env, material)), 201);
  });

  app.openapi(listRoute, async (c) => {
    const member = c.get('member')!;
    const paging = parsePaging(c.req.valid('query'));
    const binds: unknown[] = [member.projectId];
    let cursorSql = '';
    if (paging.cursor) {
      binds.push(paging.cursor.createdAt, paging.cursor.createdAt, paging.cursor.id);
      cursorSql = ' AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))';
    }
    binds.push(paging.limit + 1);
    const rows = await c.env.DB.prepare(
      `SELECT m.* FROM materials m WHERE m.project_id = ?1${cursorSql} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    )
      .bind(...binds)
      .all<MaterialRow>();
    const hasMore = rows.results.length > paging.limit;
    const pageRows = rows.results.slice(0, paging.limit);
    const lastRow = pageRows[pageRows.length - 1];
    return c.json(
      apiData(c, {
        items: pageRows.map((r) => ({
          materialId: r.id,
          title: r.title,
          kind: r.kind,
          revision: r.revision,
          currentVersionId: r.current_version_id,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
        nextCursor: nextCursor(hasMore, lastRow ? { createdAt: lastRow.created_at, id: lastRow.id } : undefined) ?? null,
      }),
      200,
    );
  });

  app.openapi(getRoute, async (c) => {
    const material = await loadMaterial(c.env, c.req.valid('param').materialId, c.get('member')!.projectId);
    return c.json(apiData(c, await materialDetail(c.env, material)), 200);
  });

  app.openapi(saveRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const materialId = c.req.valid('param').materialId;
    const material = await loadMaterial(c.env, materialId, member.projectId);
    if (material.revision !== body.expectedRevision) throw versionConflict(material.revision);
    if (!isTiptapDoc(body.doc)) throw validationFailed('doc 必须是 Tiptap JSON（{type:"doc", content:[...]}）');
    if (JSON.stringify(body.doc).length > DOC_MAX_BYTES) throw validationFailed('doc 超过大小限制');
    const markdown = body.markdown ?? docToMarkdown(body.doc);
    const current = material.current_version_id ? await loadVersion(c.env, material.current_version_id, member.projectId) : null;
    let attachments = JSON.parse(current?.attachments_json ?? '[]') as Array<{ fileId: string; name: string }>;
    if (body.attachmentIds) {
      attachments = [];
      for (const fileId of new Set(body.attachmentIds)) {
        const file = await c.env.DB.prepare("SELECT original_name FROM files WHERE id = ?1 AND project_id = ?2 AND status = 'available'").bind(fileId, member.projectId).first<{ original_name: string }>();
        if (!file) throw notFound('附件不存在或不可用');
        attachments.push({ fileId, name: file.original_name });
      }
    }

    const latest = await c.env.DB.prepare('SELECT MAX(revision) AS r FROM material_versions WHERE material_id = ?1')
      .bind(materialId)
      .first<{ r: number | null }>();
    const newRevision = (latest?.r ?? 0) + 1;
    const versionId = newId();
    const now = nowIso();

    // 版本 + 指针 + revision 原子提交（PLAN 二.7：D1 batch）
    const result = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO material_versions (id, material_id, project_id, revision, doc_json, markdown, origin, author_id, created_at, attachments_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'manual', ?7, ?8, ?9)`,
      ).bind(versionId, materialId, member.projectId, newRevision, JSON.stringify(body.doc), markdown, c.get('user')!.id, now, JSON.stringify(attachments)),
      c.env.DB.prepare(
        'UPDATE materials SET current_version_id = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?1 AND revision = ?4',
      ).bind(materialId, versionId, now, body.expectedRevision),
      c.env.DB.prepare(`INSERT INTO events (id, project_id, actor_type, actor_id, type, entity_type, entity_id, dedup_key, payload_json, occurred_at)
        SELECT ?1, ?2, 'user', ?3, 'material.saved', 'material', ?4, ?5, ?6, ?7
        WHERE EXISTS (SELECT 1 FROM materials WHERE id = ?4 AND current_version_id = ?8)
        ON CONFLICT (project_id, type, entity_type, entity_id, dedup_key) DO NOTHING`)
        .bind(newId(), member.projectId, c.get('user')!.id, materialId, `v${newRevision}`, JSON.stringify({ revision: newRevision }), now, versionId),
    ]);
    if ((result[1]?.meta?.changes ?? 0) === 0) {
      // 条件更新失败：不得留下孤儿版本（零行条件更新不会触发事务回滚，需补偿删除）
      await c.env.DB.prepare('DELETE FROM material_versions WHERE id = ?1').bind(versionId).run();
      throw versionConflict(material.revision);
    }
    const version = await loadVersion(c.env, versionId, member.projectId);
    return c.json(apiData(c, toVersion(version)), 201);
  });

  app.openapi(listVersionsRoute, async (c) => {
    const materialId = c.req.valid('param').materialId;
    await loadMaterial(c.env, materialId, c.get('member')!.projectId);
    const paging = parsePaging(c.req.valid('query'));
    const binds: unknown[] = [materialId];
    let cursorSql = '';
    if (paging.cursor) {
      binds.push(paging.cursor.createdAt, paging.cursor.createdAt, paging.cursor.id);
      cursorSql = ' AND (created_at < ? OR (created_at = ? AND id < ?))';
    }
    binds.push(paging.limit + 1);
    const rows = await c.env.DB.prepare(
      `SELECT * FROM material_versions WHERE material_id = ?1${cursorSql} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
      .bind(...binds)
      .all<VersionRow>();
    const hasMore = rows.results.length > paging.limit;
    const pageRows = rows.results.slice(0, paging.limit);
    const lastRow = pageRows[pageRows.length - 1];
    return c.json(
      apiData(c, {
        items: pageRows.map((r) => ({
          versionId: r.id,
          revision: r.revision,
          markdown: r.markdown,
          attachments: JSON.parse(r.attachments_json ?? '[]') as Array<{ fileId: string; name: string }>,
          origin: r.origin,
          aiRunId: r.ai_run_id,
          authorId: r.author_id,
          createdAt: r.created_at,
        })),
        nextCursor: nextCursor(hasMore, lastRow ? { createdAt: lastRow.created_at, id: lastRow.id } : undefined) ?? null,
      }),
      200,
    );
  });

  app.openapi(getVersionRoute, async (c) => {
    const version = await loadVersion(c.env, c.req.valid('param').versionId, c.get('member')!.projectId, c.req.valid('param').materialId);
    return c.json(apiData(c, toVersion(version)), 200);
  });
}
