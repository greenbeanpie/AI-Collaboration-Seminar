import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { projectBackgroundStatements } from '../services/resources';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { newId, nowIso } from '../core/db';
import { notFound, permissionDenied, validationFailed, versionConflict } from '../core/errors';
import { parsePaging, nextCursor } from '../core/pagination';
import { withIdempotency } from '../services/idempotency';
import { recordEvent } from '../services/events';
import { permissionSchema, projectAccess } from '../services/project-permissions';

export const projectParams = z.object({ projectId: z.string().uuid().openapi({ description: '项目 ID' }) });

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  deadlineDate: z.string().nullable().openapi({ description: '比赛截止日期（YYYY-MM-DD，保留精度不补时刻）' }),
  deadlinePrecision: z.enum(['date', 'datetime', 'unknown']),
  status: z.enum(['active', 'archived']),
  aiBudgetUsd: z.number().nonnegative().nullable().openapi({ description: '项目 AI 金额预算上限（美元）；null 表示不限额，仅受并发上限约束' }),
  aiCollaborationEnabled: z.boolean().optional().openapi({ description: '项目 AI 智能协作开关，默认关闭' }),
  revision: z.number().int(),
  myRole: z.enum(['owner', 'member']),
  permissions: permissionSchema.optional(),
  canGrantPermissions: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const projectResponse = apiEnvelope(projectSchema, 'ProjectResponse');
export const projectListResponse = apiEnvelope(
  z.object({ items: z.array(projectSchema), nextCursor: z.string().nullable() }),
  'ProjectListResponse',
);

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).default(''),
  deadlineDate: dateOnly.optional(),
  deadlinePrecision: z.enum(['date', 'datetime', 'unknown']).default('unknown'),
  aiBudgetUsd: z.number().nonnegative().nullable().optional(),
  aiCollaborationEnabled: z.boolean().default(false),
});

const patchBody = z.object({
  expectedRevision: z.number().int().min(1),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  deadlineDate: dateOnly.nullable().optional(),
  deadlinePrecision: z.enum(['date', 'datetime', 'unknown']).optional(),
  status: z.enum(['active', 'archived']).optional(),
  aiBudgetUsd: z.number().nonnegative().nullable().optional(),
});

const projectCreateRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects',
  tags: ['projects'],
  summary: '创建项目（创建者为负责人）',
  request: { body: { content: { 'application/json': { schema: createBody } }, required: true } },
  responses: {
    201: { content: { 'application/json': { schema: projectResponse } }, description: '已创建' },
    400: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '参数不合法' },
  },
});

const projectListRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects',
  tags: ['projects'],
  summary: '我参与的项目列表（游标分页）',
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.string().optional(),
      status: z.enum(['active', 'archived', 'all']).optional(),
    }),
  },
  responses: { 200: { content: { 'application/json': { schema: projectListResponse } }, description: '列表' } },
});

const projectDetailRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}',
  tags: ['projects'],
  summary: '项目详情',
  request: { params: projectParams },
  responses: { 200: { content: { 'application/json': { schema: projectResponse } }, description: '详情' } },
});

const projectPatchRoute = createRoute({
  method: 'patch',
  path: '/api/v1/projects/{projectId}',
  tags: ['projects'],
  summary: '更新项目（owner；带 expectedRevision 乐观锁）',
  request: { params: projectParams, body: { content: { 'application/json': { schema: patchBody } }, required: true } },
  responses: {
    200: { content: { 'application/json': { schema: projectResponse } }, description: '已更新' },
    403: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '需要负责人权限' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '版本冲突' },
  },
});

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  competition_deadline_date: string | null;
  deadline_precision: string;
  ai_budget_usd: number | null;
  ai_collaboration_enabled: number;
  status: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

function toProject(row: ProjectRow, role: 'owner' | 'member') {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    deadlineDate: row.competition_deadline_date,
    deadlinePrecision: row.deadline_precision as 'date' | 'datetime' | 'unknown',
    aiBudgetUsd: row.ai_budget_usd,
    aiCollaborationEnabled: row.ai_collaboration_enabled === 1,
    status: row.status as 'active' | 'archived',
    revision: row.revision,
    myRole: role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


export function registerProjectRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects', requireUser);
  app.use('/api/v1/projects/:projectId', requireUser, requireProjectMember());

  app.openapi(projectCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const user = c.get('user')!;
    const result = await withIdempotency(c.env, { key: c.req.header('idempotency-key'), userId: user.id, operation: 'projects.create', rawBody: JSON.stringify(body) }, async () => {
      const projectId = newId();
      const now = nowIso();
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO projects (id, name, description, competition_deadline_date, deadline_precision, team_size_limit, ai_budget_usd, status, revision, created_by, created_at, updated_at, ai_collaboration_enabled, assignment_mode, evaluation_mode)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', 1, ?8, ?9, ?9, ?10, ?11, ?11)`,
        ).bind(
          projectId,
          body.name,
          body.description,
          body.deadlineDate ?? null,
          body.deadlinePrecision,
          null,
          body.aiBudgetUsd ?? null,
          user.id,
          now,
          body.aiCollaborationEnabled ? 1 : 0,
          body.aiCollaborationEnabled ? 'automatic' : 'manual',
        ),
        c.env.DB.prepare(
          "INSERT INTO project_members (id, project_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, 'owner', ?4)",
        ).bind(newId(), projectId, user.id, now),
        c.env.DB.prepare(
          'INSERT OR IGNORE INTO project_goals(project_id,title,detail,created_at,updated_at) SELECT id,name,description,created_at,updated_at FROM projects WHERE id=?1',
        ).bind(projectId),
        ...projectBackgroundStatements(c.env, projectId, body.description, user.id, now),
      ]);
      const row = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?1').bind(projectId).first<ProjectRow>();
      if (!row) throw notFound('项目创建失败');
      await recordEvent(c.env,{projectId,actorType:'user',actorId:user.id,type:'project.created',entityType:'project',entityId:projectId,dedupKey:projectId});
      return { status: 201 as const, body: toProject(row, 'owner') };
    });
    return c.json(apiData(c, result.body), result.status);
  });

  app.openapi(projectListRoute, async (c) => {
    const user = c.get('user')!;
    const paging = parsePaging(c.req.valid('query'));
    const status = c.req.valid('query').status ?? 'active';
    const conditions = ['pm.user_id = ?1'];
    const binds: unknown[] = [user.id];
    if (status !== 'all') {
      binds.push(status);
      conditions.push(`p.status = ?${binds.length}`);
    }
    if (paging.cursor) {
      binds.push(paging.cursor.createdAt, paging.cursor.createdAt, paging.cursor.id);
      conditions.push('(p.created_at < ? OR (p.created_at = ? AND p.id < ?))');
    }
    binds.push(paging.limit + 1);
    const rows = await c.env.DB.prepare(
      `SELECT p.*, pm.role FROM projects p JOIN project_members pm ON pm.project_id = p.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
    )
      .bind(...binds)
      .all<ProjectRow & { role: 'owner' | 'member' }>();
    const hasMore = rows.results.length > paging.limit;
    const pageRows = rows.results.slice(0, paging.limit);
    const items = await Promise.all(pageRows.map(async r => ({ ...toProject(r,r.role), ...await projectAccess(c.env,r.id,c.get('user')!.id) })));
    const lastRow = pageRows[pageRows.length - 1];
    return c.json(
      apiData(c, {
        items,
        nextCursor: nextCursor(hasMore, lastRow ? { createdAt: lastRow.created_at, id: lastRow.id } : undefined) ?? null,
      }),
      200,
    );
  });

  app.openapi(projectDetailRoute, async (c) => {
    const member = c.get('member')!;
    const row = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?1')
      .bind(member.projectId)
      .first<ProjectRow>();
    if (!row) throw notFound('项目不存在');
    return c.json(apiData(c, { ...toProject(row, member.role), permissions: member.permissions, canGrantPermissions: member.canGrantPermissions }), 200);
  });

  app.openapi(projectPatchRoute, async (c) => {
    const member = c.get('member')!;
    if (member.role !== 'owner') throw permissionDenied('需要负责人权限');
    const body = c.req.valid('json');
    const current = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?1')
      .bind(member.projectId)
      .first<ProjectRow>();
    if (!current) throw notFound('项目不存在');
    if (current.revision !== body.expectedRevision) throw versionConflict(current.revision);

    if (body.status && body.status !== 'active' && body.status !== 'archived') throw validationFailed();

    const updated = await c.env.DB.prepare(
      `UPDATE projects SET
         name = COALESCE(?2, name),
         description = COALESCE(?3, description),
         competition_deadline_date = CASE WHEN ?4 = 1 THEN ?5 ELSE competition_deadline_date END,
         deadline_precision = COALESCE(?6, deadline_precision),
         collaboration_revision = collaboration_revision + CASE WHEN ?7 IS NOT NULL AND ?7 != status THEN 1 ELSE 0 END,
         status = COALESCE(?7, status),
         ai_budget_usd = CASE WHEN ?8 = 1 THEN ?9 ELSE ai_budget_usd END,
         revision = revision + 1,
         updated_at = ?10
       WHERE id = ?1 AND revision = ?11`,
    )
      .bind(
        member.projectId,
        body.name ?? null,
        body.description ?? null,
        'deadlineDate' in body ? 1 : 0,
        body.deadlineDate ?? null,
        body.deadlinePrecision ?? null,
        body.status ?? null,
        'aiBudgetUsd' in body ? 1 : 0,
        body.aiBudgetUsd ?? null,
        nowIso(),
        body.expectedRevision,
      )
      .run();
    if ((updated.meta?.changes ?? 0) === 0) {
      const latest = await c.env.DB.prepare('SELECT revision FROM projects WHERE id = ?1')
        .bind(member.projectId)
        .first<{ revision: number }>();
      if (!latest) throw notFound('项目不存在');
      throw versionConflict(latest.revision);
    }

    const row = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?1')
      .bind(member.projectId)
      .first<ProjectRow>();
    if (!row) throw notFound('项目不存在');
    await recordEvent(c.env,{projectId:member.projectId,actorType:'user',actorId:c.get('user')!.id,type:'project.updated',entityType:'project',entityId:member.projectId,dedupKey:String(row.revision)});
    return c.json(apiData(c, toProject(row, member.role)), 200);
  });
}
