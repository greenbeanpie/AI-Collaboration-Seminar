import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, permissionDenied, validationFailed, versionConflict } from '../core/errors';
import { parsePaging, nextCursor } from '../core/pagination';

export const projectParams = z.object({ projectId: z.string().uuid().openapi({ description: '项目 ID' }) });

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  deadlineDate: z.string().nullable().openapi({ description: '比赛截止日期（YYYY-MM-DD，保留精度不补时刻）' }),
  deadlinePrecision: z.enum(['date', 'datetime', 'unknown']),
  status: z.enum(['active', 'archived']),
  revision: z.number().int(),
  myRole: z.enum(['owner', 'member']),
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
});

const patchBody = z.object({
  expectedRevision: z.number().int().min(1),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  deadlineDate: dateOnly.nullable().optional(),
  deadlinePrecision: z.enum(['date', 'datetime', 'unknown']).optional(),
  status: z.enum(['active', 'archived']).optional(),
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
    status: row.status as 'active' | 'archived',
    revision: row.revision,
    myRole: role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readTeamSizeLimit(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT value_json FROM app_config WHERE key = 'competition_template'")
    .first<{ value_json: string }>();
  if (!row) return null;
  const parsed = JSON.parse(row.value_json) as { teamSizeLimit?: number };
  return typeof parsed.teamSizeLimit === 'number' ? parsed.teamSizeLimit : null;
}

export function registerProjectRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects', requireUser);
  app.use('/api/v1/projects/:projectId', requireUser, requireProjectMember());

  app.openapi(projectCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const user = c.get('user')!;
    const projectId = newId();
    const now = nowIso();
    const teamSizeLimit = await readTeamSizeLimit(c.env.DB);
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO projects (id, name, description, competition_deadline_date, deadline_precision, team_size_limit, status, revision, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', 1, ?7, ?8, ?8)`,
      ).bind(
        projectId,
        body.name,
        body.description,
        body.deadlineDate ?? null,
        body.deadlinePrecision,
        teamSizeLimit,
        user.id,
        now,
      ),
      c.env.DB.prepare(
        "INSERT INTO project_members (id, project_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, 'owner', ?4)",
      ).bind(newId(), projectId, user.id, now),
    ]);
    const row = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?1').bind(projectId).first<ProjectRow>();
    if (!row) throw notFound('项目创建失败');
    return c.json(apiData(c, toProject(row, 'owner')), 201);
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
    const items = rows.results.slice(0, paging.limit).map((r) => toProject(r, r.role));
    const overflow = hasMore ? rows.results[paging.limit] : undefined;
    return c.json(
      apiData(c, {
        items,
        nextCursor: overflow ? (nextCursor(paging, { createdAt: overflow.created_at, id: overflow.id }) ?? null) : null,
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
    return c.json(apiData(c, toProject(row, member.role)), 200);
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
         competition_deadline_date = COALESCE(?4, competition_deadline_date),
         deadline_precision = COALESCE(?5, deadline_precision),
         status = COALESCE(?6, status),
         revision = revision + 1,
         updated_at = ?7
       WHERE id = ?1 AND revision = ?8`,
    )
      .bind(
        member.projectId,
        body.name ?? null,
        body.description ?? null,
        body.deadlineDate ?? null,
        body.deadlinePrecision ?? null,
        body.status ?? null,
        nowIso(),
        body.expectedRevision,
      )
      .run();
    if ((updated.meta?.changes ?? 0) === 0) throw invalidState('更新未生效，请检查状态变更是否合法');

    const row = await c.env.DB.prepare('SELECT * FROM projects WHERE id = ?1')
      .bind(member.projectId)
      .first<ProjectRow>();
    if (!row) throw notFound('项目不存在');
    return c.json(apiData(c, toProject(row, member.role)), 200);
  });
}
