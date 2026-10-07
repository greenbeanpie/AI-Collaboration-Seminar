import { triggerFileProcessing, syncMaterialFileProcessing } from '../services/file-processing-triggers';
import { archiveMaterial, materialManageSql, fileManageSql } from '../services/task-files';
import { projectPermissionSql } from '../services/project-permissions';
import { contributorSchema, fileContributors } from '../services/file-contributors';
import { fileReferenceAvailability } from '../services/source-inputs';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { resourcePurposeSchema } from './resources';
import type { ResourcePurpose } from '../services/resources';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, permissionDenied, validationFailed, versionConflict } from '../core/errors';import { parsePaging, nextCursor } from '../core/pagination';
import { docToMarkdown, isTiptapDoc } from '../services/tiptap';
import { projectParams } from './projects';

const DOC_MAX_BYTES = 200 * 1024;

const materialParams = projectParams.extend({ materialId: z.string().uuid() });
const versionParams = materialParams.extend({ versionId: z.string().uuid() });

const attachmentSchema = z.object({ contributors:z.array(contributorSchema).optional(), fileId: z.string().uuid(), name: z.string(), availability: z.literal('unavailable').optional(), deletedAt: z.string().nullable().optional(), archivedAt:z.string().nullable().optional(),lifecycleVersion:z.number().int().optional(),canManage:z.boolean().optional() });
const materialSchema = z.object({
  canEdit:z.boolean().optional(),
  canArchive:z.boolean().optional(),
  archivedAt:z.string().nullable().optional(),taskId:z.string().uuid().nullable().optional(),
  systemManaged:z.boolean().optional(),
  materialId: z.string().uuid(),
  title: z.string(),
  kind: z.string(),
  purpose: resourcePurposeSchema,
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
  purpose: resourcePurposeSchema.optional(),
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
  request: { params: projectParams, query: z.object({ cursor: z.string().optional(), limit: z.string().optional(), q:z.string().trim().max(200).optional(), archived:z.enum(['true','false']).optional() }) },
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
  allowed?:number;archived_at:string|null;task_id:string|null;
  system_managed: number;
  id: string;
  project_id: string;
  created_by: string;
  title: string;
  kind: string;
  purpose: ResourcePurpose;
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

type Attachment = { fileId: string; name: string; availability?: 'unavailable'; deletedAt?: string | null };

async function attachmentReferences(env: AppEnv['Bindings'], projectId: string, json: string, actorId?:string): Promise<Attachment[]> {
  const attachments = JSON.parse(json ?? '[]') as Array<{ fileId: string; name: string }>;
  return Promise.all(attachments.map(async attachment => {
    const file=await env.DB.prepare(`SELECT archived_at,lifecycle_version,CASE WHEN ${fileManageSql('?2','?3')} THEN 1 ELSE 0 END allowed FROM files WHERE id=?1 AND project_id=?2`).bind(attachment.fileId,projectId,actorId??'').first<{archived_at:string|null;lifecycle_version:number;allowed:number}>();
    return { ...attachment, archivedAt:file?.archived_at??null,lifecycleVersion:file?.lifecycle_version??1,canManage:Boolean(file?.allowed), contributors:await fileContributors(env,projectId,attachment.fileId), ...await fileReferenceAvailability(env, projectId, attachment.fileId) };
  }));
}

async function toVersion(env: AppEnv['Bindings'], projectId: string, r: VersionRow, actorId?:string) {
  return {
    versionId: r.id,
    revision: r.revision,
    doc: JSON.parse(r.doc_json) as Record<string, unknown>,
    markdown: r.markdown,
    attachments: await attachmentReferences(env, projectId, r.attachments_json,actorId),
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

async function materialDetail(env: AppEnv['Bindings'], material: MaterialRow, actorId:string) {
  const current = material.current_version_id
    ? await env.DB.prepare('SELECT * FROM material_versions WHERE id = ?1').bind(material.current_version_id).first<VersionRow>()
    : null;
  return {
    systemManaged:material.system_managed === 1,
    canEdit:material.system_managed !== 1 && !material.archived_at && material.kind!=='task-file' && Boolean(await env.DB.prepare(`SELECT 1 FROM materials WHERE id=?3 AND ${materialManageSql('?1','?2')}`).bind(material.project_id,actorId,material.id).first()),
    canArchive:material.system_managed !== 1 && Boolean(await env.DB.prepare(`SELECT 1 FROM materials WHERE id=?3 AND ${materialManageSql('?1','?2')}`).bind(material.project_id,actorId,material.id).first()),
    archivedAt:material.archived_at,taskId:material.task_id,
    materialId: material.id,
    title: material.title,
    kind: material.kind,
    purpose: material.purpose,
    revision: material.revision,
    currentVersion: current
      ? {
          versionId: current.id,
          revision: current.revision,
          doc: JSON.parse(current.doc_json) as Record<string, unknown>,
          markdown: current.markdown,
          attachments: await attachmentReferences(env, material.project_id, current.attachments_json,actorId),
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
  app.use('/api/v1/projects/:projectId/materials',requireUser,requireProjectMember());
  app.use('/api/v1/projects/:projectId/materials/*', requireUser, requireProjectMember());

  for(const restore of [false,true]) {
    const route=createRoute({method:'post',path:'/api/v1/projects/{projectId}/materials/{materialId}/'+(restore?'unarchive':'archive'),tags:['materials'],request:{params:materialParams,body:{required:true,content:{'application/json':{schema:z.object({expectedRevision:z.number().int().positive()}).strict()}}}},responses:{200:{description:'材料归档状态',content:{'application/json':{schema:apiEnvelope(z.object({materialId:z.string().uuid(),archivedAt:z.string().nullable(),revision:z.number().int()}),'Material'+(restore?'Unarchive':'Archive')+'Response')}}}}});
    app.openapi(route,async c=>c.json(apiData(c,await archiveMaterial(c.env,{...c.req.valid('param'),...c.req.valid('json'),actorId:c.get('user')!.id,restore})),200));
  }

  app.openapi(materialCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const user = c.get('user')!;
    if(body.kind==='task-file') throw validationFailed('任务文件请通过任务文件登记接口创建');
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
        'INSERT INTO materials (id, project_id, title, kind, current_version_id, revision, created_by, created_at, updated_at, purpose) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?7, ?8)',
      ).bind(materialId, member.projectId, body.title, body.kind, versionId, user.id, now, body.purpose ?? (body.kind === 'background' ? 'background' : 'output')),
      c.env.DB.prepare(
        `INSERT INTO material_versions (id, material_id, project_id, revision, doc_json, markdown, origin, author_id, created_at)
         VALUES (?1, ?2, ?3, 1, ?4, ?5, 'manual', ?6, ?7)`,
      ).bind(versionId, materialId, member.projectId, JSON.stringify(emptyDoc), docToMarkdown(emptyDoc), user.id, now),
    ]);
    const material = await loadMaterial(c.env, materialId, member.projectId);
    if (material.system_managed === 1) throw permissionDenied('系统背景由项目设置自动同步，不能手动修改');
    return c.json(apiData(c, await materialDetail(c.env, material,c.get('user')!.id)), 201);
  });

  app.openapi(listRoute, async (c) => {
    const member = c.get('member')!;
    const paging = parsePaging(c.req.valid('query'));
    const binds: unknown[] = [member.projectId,member.userId];
    const archived=c.req.valid('query').archived==='true';
    let cursorSql = '';
    if (paging.cursor) {
      binds.push(paging.cursor.createdAt, paging.cursor.createdAt, paging.cursor.id);
      cursorSql = ' AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))';
    }
    const search=c.req.valid('query').q;
    if(search){binds.push(search);cursorSql += ` AND instr(lower(m.title),lower(?${binds.length}))>0`;}
    binds.push(paging.limit + 1);
    const rows = await c.env.DB.prepare(
      `SELECT m.*,CASE WHEN ${materialManageSql('?1','?2','m')} THEN 1 ELSE 0 END allowed FROM materials m WHERE m.project_id = ?1 AND (m.archived_at IS NOT NULL)=${archived?1:0}${cursorSql} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`,
    )
      .bind(...binds)
      .all<MaterialRow>();
    const hasMore = rows.results.length > paging.limit;
    const pageRows = rows.results.slice(0, paging.limit);
    const lastRow = pageRows[pageRows.length - 1];
    return c.json(
      apiData(c, {
        items: pageRows.map((r) => ({
          systemManaged: r.system_managed === 1,
          canEdit: r.system_managed !== 1 && !r.archived_at && r.kind!=='task-file' && Boolean(r.allowed),
          canArchive:r.system_managed!==1 && Boolean(r.allowed),
          archivedAt:r.archived_at,taskId:r.task_id,
          materialId: r.id,
          title: r.title,
          kind: r.kind,
          purpose: r.purpose,
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
    return c.json(apiData(c, await materialDetail(c.env, material,c.get('user')!.id)), 200);
  });

  app.openapi(saveRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const materialId = c.req.valid('param').materialId;
    const material = await loadMaterial(c.env, materialId, member.projectId);
    if (material.system_managed === 1) throw permissionDenied('系统背景由项目设置自动同步，不能手动修改');
    if(material.archived_at) throw invalidState('归档材料不可编辑，请先恢复');
    if(material.kind==='task-file') throw invalidState('任务文件请使用文件版本替换接口');
    const actorId=c.get('user')!.id;
    if (!await c.env.DB.prepare(`SELECT 1 FROM materials WHERE id=?3 AND ${materialManageSql('?1','?2')}`).bind(member.projectId,actorId,materialId).first()) throw permissionDenied('只能编辑本人创建或有资料管理权限的材料');
    if (material.revision !== body.expectedRevision) throw versionConflict(material.revision);
    if (!isTiptapDoc(body.doc)) throw validationFailed('doc 必须是 Tiptap JSON（{type:"doc", content:[...]}）');
    if (JSON.stringify(body.doc).length > DOC_MAX_BYTES) throw validationFailed('doc 超过大小限制');
    const markdown = body.markdown ?? docToMarkdown(body.doc);
    const current = material.current_version_id ? await loadVersion(c.env, material.current_version_id, member.projectId) : null;
    let attachments = JSON.parse(current?.attachments_json ?? '[]') as Array<{ fileId: string; name: string }>;
    const attachmentSnapshots: Array<{ fileId: string; lifecycleVersion: number }> = [];
    if (body.attachmentIds) {
      attachments = [];
      for (const fileId of new Set(body.attachmentIds)) {
        const file = await c.env.DB.prepare("SELECT original_name,lifecycle_version FROM files WHERE id = ?1 AND project_id = ?2 AND status = 'available' AND deleted_at IS NULL AND archived_at IS NULL").bind(fileId, member.projectId).first<{ original_name: string; lifecycle_version: number }>();
        if (!file) throw notFound('附件不存在或不可用');
        attachments.push({ fileId, name: file.original_name });
        attachmentSnapshots.push({ fileId, lifecycleVersion: file.lifecycle_version });
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
         SELECT ?1,?2,?3,?4,?5,?6,'manual',?7,?8,?9
         WHERE EXISTS(SELECT 1 FROM materials WHERE id=?2 AND project_id=?3 AND revision=?11 AND archived_at IS NULL AND kind!='task-file' AND ${materialManageSql('?3','?7')})
           AND NOT EXISTS(SELECT 1 FROM json_each(?10) captured WHERE NOT EXISTS(SELECT 1 FROM files f WHERE f.id=json_extract(captured.value,'$.fileId') AND f.project_id=?3 AND f.status='available' AND f.deleted_at IS NULL AND f.archived_at IS NULL AND f.lifecycle_version=json_extract(captured.value,'$.lifecycleVersion')))`,
      ).bind(versionId, materialId, member.projectId, newRevision, JSON.stringify(body.doc), markdown, c.get('user')!.id, now, JSON.stringify(attachments), JSON.stringify(attachmentSnapshots), body.expectedRevision),
      c.env.DB.prepare(
        'UPDATE materials SET current_version_id = ?2, revision = revision + 1, updated_at = ?3 WHERE id = ?1 AND revision = ?4 AND EXISTS(SELECT 1 FROM material_versions WHERE id=?2 AND material_id=?1)',
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
    for (const attachment of attachments) await triggerFileProcessing(c.env, member.projectId, attachment.fileId, member.userId);
    await syncMaterialFileProcessing(c.env, member.projectId, materialId);
    const version = await loadVersion(c.env, versionId, member.projectId);
    return c.json(apiData(c, await toVersion(c.env, member.projectId, version,member.userId)), 201);
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
        items: await Promise.all(pageRows.map(async (r) => ({
          versionId: r.id,
          revision: r.revision,
          markdown: r.markdown,
          attachments: await attachmentReferences(c.env, c.get('member')!.projectId, r.attachments_json,c.get('user')!.id),
          origin: r.origin,
          aiRunId: r.ai_run_id,
          authorId: r.author_id,
          createdAt: r.created_at,
        }))),
        nextCursor: nextCursor(hasMore, lastRow ? { createdAt: lastRow.created_at, id: lastRow.id } : undefined) ?? null,
      }),
      200,
    );
  });

  app.openapi(getVersionRoute, async (c) => {
    const version = await loadVersion(c.env, c.req.valid('param').versionId, c.get('member')!.projectId, c.req.valid('param').materialId);
    return c.json(apiData(c, await toVersion(c.env, c.get('member')!.projectId, version,c.get('user')!.id)), 200);
  });
}
