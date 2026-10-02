import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv, Env } from '../env';
import { requireProjectMember, requireUser } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope, apiErrorEnvelope } from '../core/openapi';
import { nowIso } from '../core/db';
import { notFound, permissionDenied, versionConflict } from '../core/errors';
import { nextCursor, parsePaging } from '../core/pagination';
import { projectParams } from './projects';
import type { ResourcePurpose, ResourceType } from '../services/resources';

export const resourcePurposeSchema = z.enum(['background', 'reference', 'output']);
const resourceParams = projectParams.extend({ resourceType: z.enum(['source', 'material']), resourceId: z.string().uuid() });
const resourceSchema = z.object({
  resourceType: z.enum(['source', 'material']), resourceId: z.string().uuid(), title: z.string(),
  purpose: resourcePurposeSchema, currentVersionId: z.string().uuid().nullable(), revision: z.number().int().positive(),
  createdAt: z.string(), updatedAt: z.string(), deletedAt: z.string().nullable(),
  lifecycleVersion: z.number().int().nullable(), fileId: z.string().uuid().nullable(), canManage: z.boolean(),
});
const resourceResponse = apiEnvelope(resourceSchema, 'ResourceLibraryItemResponse');
const listRoute = createRoute({ method: 'get', path: '/api/v1/projects/{projectId}/resource-library', tags: ['resources'],
  summary: '统一项目资料列表，保留来源和成果版本身份',
  request: { params: projectParams, query: z.object({ cursor: z.string().optional(), limit: z.string().optional(), purpose: resourcePurposeSchema.optional(), deleted: z.enum(['true', 'false']).default('false') }) },
  responses: { 200: { description: '统一资料列表', content: { 'application/json': { schema: apiEnvelope(z.object({ items: z.array(resourceSchema), nextCursor: z.string().nullable() }), 'ResourceLibraryListResponse') } } } },
});
const getRoute = createRoute({ method: 'get', path: '/api/v1/projects/{projectId}/resource-library/{resourceType}/{resourceId}', tags: ['resources'],
  request: { params: resourceParams }, responses: { 200: { description: '资料身份与用途', content: { 'application/json': { schema: resourceResponse } } } } });
const patchRoute = createRoute({ method: 'patch', path: '/api/v1/projects/{projectId}/resource-library/{resourceType}/{resourceId}', tags: ['resources'],
  summary: '修改资料用途，不修改来源原文或成果正文版本',
  request: { params: resourceParams, body: { required: true, content: { 'application/json': { schema: z.object({ purpose: resourcePurposeSchema, expectedRevision: z.number().int().positive() }).strict() } } } },
  responses: { 200: { description: '资料用途已更新', content: { 'application/json': { schema: resourceResponse } } }, 409: { description: '资料已变化', content: { 'application/json': { schema: apiErrorEnvelope } } } },
});

interface ResourceRow {
  resource_type: ResourceType; id: string; title: string; purpose: ResourcePurpose; current_version_id: string | null;
  revision: number; created_at: string; updated_at: string; deleted_at: string | null;
  lifecycle_version: number | null; file_id: string | null; can_manage: number; sort_key: string;
}

// The public source metadata revision also advances through recycling/restoring,
// so a purpose request captured before a lifecycle change cannot be replayed.
const resourceUnion = `SELECT 'source' resource_type,s.id,s.title,s.purpose,s.current_version_id,(s.resource_revision+s.lifecycle_version-1) revision,
  s.created_at,s.updated_at,s.deleted_at,s.lifecycle_version,(SELECT file_id FROM source_versions WHERE id=s.current_version_id) file_id,
  CASE WHEN ?2=1 OR s.created_by=?3 THEN 1 ELSE 0 END can_manage,'source:'||s.id sort_key
  FROM sources s WHERE s.project_id=?1
  UNION ALL SELECT 'material',m.id,m.title,m.purpose,m.current_version_id,m.revision,m.created_at,m.updated_at,NULL,NULL,NULL,1,'material:'||m.id
  FROM materials m WHERE m.project_id=?1`;

function toResource(row: ResourceRow) {
  return { resourceType: row.resource_type, resourceId: row.id, title: row.title, purpose: row.purpose,
    currentVersionId: row.current_version_id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    deletedAt: row.deleted_at, lifecycleVersion: row.lifecycle_version, fileId: row.file_id, canManage: row.can_manage === 1 };
}

async function readResource(env: Env, projectId: string, type: ResourceType, id: string, actorId: string, owner: boolean): Promise<ResourceRow> {
  const row = await env.DB.prepare(`SELECT * FROM (${resourceUnion}) WHERE resource_type=?4 AND id=?5`)
    .bind(projectId, +owner, actorId, type, id).first<ResourceRow>();
  if (!row) throw notFound('资料不存在');
  return row;
}

export function registerResourceRoutes(app: OpenAPIHono<AppEnv>): void {
  const privateResponse = async (c: Parameters<typeof requireUser>[0], next: () => Promise<void>) => { c.header('Cache-Control', 'no-store'); await next(); };
  app.use('/api/v1/projects/:projectId/resource-library', privateResponse, requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/resource-library/*', privateResponse, requireUser, requireProjectMember());
  app.openapi(listRoute, async c => {
    const member = c.get('member')!;
    const query = c.req.valid('query'), paging = parsePaging(query);
    const rows = await c.env.DB.prepare(`SELECT * FROM (${resourceUnion})
      WHERE (deleted_at IS NOT NULL)=?4 AND (?5 IS NULL OR purpose=?5)
        AND (?6 IS NULL OR created_at<?6 OR (created_at=?6 AND sort_key<?7))
      ORDER BY created_at DESC,sort_key DESC LIMIT ?8`)
      .bind(member.projectId, +(member.role === 'owner'), member.userId, +(query.deleted === 'true'), query.purpose ?? null,
        paging.cursor?.createdAt ?? null, paging.cursor?.id ?? null, paging.limit + 1).all<ResourceRow>();
    const items = rows.results.slice(0, paging.limit), last = items.at(-1);
    return c.json(apiData(c, { items: items.map(toResource), nextCursor: nextCursor(rows.results.length > paging.limit, last ? { createdAt: last.created_at, id: last.sort_key } : undefined) ?? null }), 200);
  });
  app.openapi(getRoute, async c => {
    const p = c.req.valid('param'), member = c.get('member')!;
    return c.json(apiData(c, toResource(await readResource(c.env, p.projectId, p.resourceType, p.resourceId, member.userId, member.role === 'owner'))), 200);
  });
  app.openapi(patchRoute, async c => {
    const p = c.req.valid('param'), body = c.req.valid('json'), member = c.get('member')!;
    const resource = await readResource(c.env, p.projectId, p.resourceType, p.resourceId, member.userId, member.role === 'owner');
    if (resource.deleted_at) throw notFound('资料已移入回收站，请先恢复');
    if (!resource.can_manage) throw permissionDenied('只有来源创建者或项目负责人可修改其用途');
    if (resource.revision !== body.expectedRevision) throw versionConflict(resource.revision);
    const changed = p.resourceType === 'source'
      ? await c.env.DB.prepare(`UPDATE sources SET purpose=?4,resource_revision=resource_revision+1,updated_at=?5
          WHERE id=?1 AND project_id=?2 AND (resource_revision+lifecycle_version-1)=?3 AND deleted_at IS NULL
            AND EXISTS(SELECT 1 FROM project_members actor WHERE actor.project_id=?2 AND actor.user_id=?6 AND (actor.role='owner' OR sources.created_by=?6))`)
          .bind(p.resourceId, p.projectId, body.expectedRevision, body.purpose, nowIso(), member.userId).run()
      : await c.env.DB.prepare(`UPDATE materials SET purpose=?4,revision=revision+1,updated_at=?5 WHERE id=?1 AND project_id=?2 AND revision=?3
            AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?6)`)
          .bind(p.resourceId, p.projectId, body.expectedRevision, body.purpose, nowIso(), member.userId).run();
    const current = await readResource(c.env, p.projectId, p.resourceType, p.resourceId, member.userId, member.role === 'owner');
    if (!changed.meta.changes) throw versionConflict(current.revision);
    return c.json(apiData(c, toResource(current)), 200);
  });
}
