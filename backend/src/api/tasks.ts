import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, versionConflict } from '../core/errors';
import { parsePaging, nextCursor } from '../core/pagination';
import { recordEvent } from '../services/events';
import { projectParams } from './projects';

const taskParams = projectParams.extend({ taskId: z.string().uuid() });

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const taskSchema = z.object({
  taskId: z.string().uuid(),
  title: z.string(),
  detail: z.string(),
  assigneeId: z.string().uuid().nullable(),
  dueDate: z.string().nullable(),
  duePrecision: z.enum(['date', 'datetime', 'unknown']),
  status: z.enum(['todo', 'doing', 'blocked', 'done']),
  requirementId: z.string().uuid().nullable(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const taskResponse = apiEnvelope(taskSchema, 'TaskResponse');
const taskListResponse = apiEnvelope(z.object({ items: z.array(taskSchema), nextCursor: z.string().nullable() }), 'TaskListResponse');

const commentSchema = z.object({
  commentId: z.string().uuid(),
  targetType: z.enum(['task', 'material', 'review', 'rehearsal']),
  targetId: z.string().uuid(),
  authorId: z.string().uuid(),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
const commentListResponse = apiEnvelope(z.object({ items: z.array(commentSchema), nextCursor: z.string().nullable() }), 'CommentListResponse');
const commentResponse = apiEnvelope(commentSchema, 'CommentResponse');

const createBody = z.object({
  title: z.string().min(1).max(200),
  detail: z.string().max(4000).default(''),
  assigneeId: z.string().uuid().nullable().default(null),
  dueDate: dateOnly.nullable().default(null),
  duePrecision: z.enum(['date', 'datetime', 'unknown']).default('unknown'),
  requirementId: z.string().uuid().nullable().default(null),
});

const patchBody = z.object({
  expectedRevision: z.number().int().min(1),
  title: z.string().min(1).max(200).optional(),
  detail: z.string().max(4000).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  dueDate: dateOnly.nullable().optional(),
  duePrecision: z.enum(['date', 'datetime', 'unknown']).optional(),
  status: z.enum(['todo', 'doing', 'blocked', 'done']).optional(),
  requirementId: z.string().uuid().nullable().optional(),
});

const commentBody = z.object({
  targetType: z.enum(['task', 'material', 'review', 'rehearsal']),
  targetId: z.string().uuid(),
  body: z.string().min(1).max(4000),
});

const taskCreateRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/tasks',
  tags: ['tasks'],
  summary: '创建任务',
  request: { params: projectParams, body: { content: { 'application/json': { schema: createBody } }, required: true } },
  responses: { 201: { content: { 'application/json': { schema: taskResponse } }, description: '已创建' } },
});

const taskListRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/tasks',
  tags: ['tasks'],
  summary: '任务列表（可按状态/负责人过滤，游标分页）',
  request: {
    params: projectParams,
    query: z.object({ cursor: z.string().optional(), limit: z.string().optional(), status: z.enum(['todo', 'doing', 'blocked', 'done', 'all']).optional() }),
  },
  responses: { 200: { content: { 'application/json': { schema: taskListResponse } }, description: '列表' } },
});

const taskGetRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/tasks/{taskId}',
  tags: ['tasks'],
  summary: '任务详情',
  request: { params: taskParams },
  responses: { 200: { content: { 'application/json': { schema: taskResponse } }, description: '详情' } },
});

const taskPatchRoute = createRoute({
  method: 'patch',
  path: '/api/v1/projects/{projectId}/tasks/{taskId}',
  tags: ['tasks'],
  summary: '更新任务（expectedRevision 乐观锁；AI 不允许直接改任务状态）',
  request: { params: taskParams, body: { content: { 'application/json': { schema: patchBody } }, required: true } },
  responses: {
    200: { content: { 'application/json': { schema: taskResponse } }, description: '已更新' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '版本冲突' },
  },
});

const commentCreateRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/comments',
  tags: ['comments'],
  summary: '发表评论（任务/材料/预审/答辩）',
  request: { params: projectParams, body: { content: { 'application/json': { schema: commentBody } }, required: true } },
  responses: { 201: { content: { 'application/json': { schema: commentResponse } }, description: '已发表' } },
});

const commentListRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/comments',
  tags: ['comments'],
  summary: '评论列表（按目标过滤，游标分页）',
  request: {
    params: projectParams,
    query: z.object({ targetType: z.enum(['task', 'material', 'review', 'rehearsal']), targetId: z.string().uuid(), cursor: z.string().optional(), limit: z.string().optional() }),
  },
  responses: { 200: { content: { 'application/json': { schema: commentListResponse } }, description: '列表' } },
});

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  detail: string;
  assignee_id: string | null;
  due_date: string | null;
  due_precision: string;
  status: string;
  requirement_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

function toTask(r: TaskRow) {
  return {
    taskId: r.id,
    title: r.title,
    detail: r.detail,
    assigneeId: r.assignee_id,
    dueDate: r.due_date,
    duePrecision: r.due_precision as 'date' | 'datetime' | 'unknown',
    status: r.status as 'todo' | 'doing' | 'blocked' | 'done',
    requirementId: r.requirement_id,
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const commentSelect = `SELECT c.id, c.target_type, c.target_id, c.author_id, u.display_name AS author_name, c.body, c.created_at
  FROM comments c JOIN users u ON u.id = c.author_id`;

export function registerTaskRoutes(app: OpenAPIHono<AppEnv>): void {
  // * 通配覆盖 tasks/comments 全部深度（M3 经验：必须覆盖子路径）
  app.use('/api/v1/projects/:projectId/tasks/*', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/comments/*', requireUser, requireProjectMember());

  app.openapi(taskCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const id = newId();
    const now = nowIso();
    await c.env.DB.prepare(
      `INSERT INTO tasks (id, project_id, title, detail, assignee_id, due_date, due_precision, status, requirement_id, revision, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'todo', ?8, 1, ?9, ?10, ?10)`,
    )
      .bind(id, member.projectId, body.title, body.detail, body.assigneeId, body.dueDate, body.duePrecision, body.requirementId, c.get('user')!.id, now)
      .run();
    const row = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(id).first<TaskRow>();
    if (!row) throw notFound('任务创建失败');
    return c.json(apiData(c, toTask(row)), 201);
  });

  app.openapi(taskListRoute, async (c) => {
    const member = c.get('member')!;
    const paging = parsePaging(c.req.valid('query'));
    const status = c.req.valid('query').status ?? 'all';
    const conditions = ['project_id = ?1'];
    const binds: unknown[] = [member.projectId];
    if (status !== 'all') {
      binds.push(status);
      conditions.push(`status = ?${binds.length}`);
    }
    if (paging.cursor) {
      binds.push(paging.cursor.createdAt, paging.cursor.createdAt, paging.cursor.id);
      conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
    }
    binds.push(paging.limit + 1);
    const rows = await c.env.DB.prepare(
      `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
      .bind(...binds)
      .all<TaskRow>();
    const hasMore = rows.results.length > paging.limit;
    const overflow = hasMore ? rows.results[paging.limit] : undefined;
    return c.json(
      apiData(c, {
        items: rows.results.slice(0, paging.limit).map(toTask),
        nextCursor: overflow ? (nextCursor(paging, { createdAt: overflow.created_at, id: overflow.id }) ?? null) : null,
      }),
      200,
    );
  });

  app.openapi(taskGetRoute, async (c) => {
    const row = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?1 AND project_id = ?2')
      .bind(c.req.valid('param').taskId, c.get('member')!.projectId)
      .first<TaskRow>();
    if (!row) throw notFound('任务不存在');
    return c.json(apiData(c, toTask(row)), 200);
  });

  app.openapi(taskPatchRoute, async (c) => {
    const body = c.req.valid('json');
    const taskId = c.req.valid('param').taskId;
    const current = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?1 AND project_id = ?2')
      .bind(taskId, c.get('member')!.projectId)
      .first<TaskRow>();
    if (!current) throw notFound('任务不存在');
    if (current.revision !== body.expectedRevision) throw versionConflict(current.revision);

    const statusChanged = body.status !== undefined && body.status !== current.status;
    const updated = await c.env.DB.prepare(
      `UPDATE tasks SET
         title = COALESCE(?2, title),
         detail = COALESCE(?3, detail),
         assignee_id = COALESCE(?4, assignee_id),
         due_date = COALESCE(?5, due_date),
         due_precision = COALESCE(?6, due_precision),
         status = COALESCE(?7, status),
         requirement_id = COALESCE(?8, requirement_id),
         revision = revision + 1,
         updated_at = ?9
       WHERE id = ?1 AND revision = ?10`,
    )
      .bind(
        taskId,
        body.title ?? null,
        body.detail ?? null,
        body.assigneeId ?? null,
        body.dueDate ?? null,
        body.duePrecision ?? null,
        body.status ?? null,
        body.requirementId ?? null,
        nowIso(),
        body.expectedRevision,
      )
      .run();
    if ((updated.meta?.changes ?? 0) === 0) throw invalidState('更新未生效');

    if (statusChanged && body.status) {
      await recordEvent(c.env, {
        projectId: c.get('member')!.projectId,
        actorType: 'user',
        actorId: c.get('user')!.id,
        type: 'task.status_changed',
        entityType: 'task',
        entityId: taskId,
        dedupKey: `to:${body.status}:${body.expectedRevision}`,
        payload: { from: current.status, to: body.status },
      });
    }

    const row = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(taskId).first<TaskRow>();
    if (!row) throw notFound('任务不存在');
    return c.json(apiData(c, toTask(row)), 200);
  });

  app.openapi(commentCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const id = newId();
    const now = nowIso();
    await c.env.DB.prepare(
      'INSERT INTO comments (id, project_id, target_type, target_id, author_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    )
      .bind(id, member.projectId, body.targetType, body.targetId, c.get('user')!.id, body.body, now)
      .run();
    const row = await c.env.DB.prepare(`${commentSelect} WHERE c.id = ?1`).bind(id).first<{
      id: string; target_type: string; target_id: string; author_id: string; author_name: string; body: string; created_at: string;
    }>();
    if (!row) throw notFound('评论创建失败');
    return c.json(
      apiData(c, {
        commentId: row.id,
        targetType: row.target_type as 'task' | 'material' | 'review' | 'rehearsal',
        targetId: row.target_id,
        authorId: row.author_id,
        authorName: row.author_name,
        body: row.body,
        createdAt: row.created_at,
      }),
      201,
    );
  });

  app.openapi(commentListRoute, async (c) => {
    const member = c.get('member')!;
    const query = c.req.valid('query');
    const paging = parsePaging(query);
    const binds: unknown[] = [member.projectId, query.targetType, query.targetId];
    let cursorSql = '';
    if (paging.cursor) {
      binds.push(paging.cursor.createdAt, paging.cursor.createdAt, paging.cursor.id);
      cursorSql = ' AND (c.created_at < ? OR (c.created_at = ? AND c.id < ?))';
    }
    binds.push(paging.limit + 1);
    const rows = await c.env.DB.prepare(
      `${commentSelect} WHERE c.project_id = ?1 AND c.target_type = ?2 AND c.target_id = ?3${cursorSql}
       ORDER BY c.created_at ASC, c.id ASC LIMIT ?`,
    )
      .bind(...binds)
      .all<{
        id: string; target_type: string; target_id: string; author_id: string; author_name: string; body: string; created_at: string;
      }>();
    const hasMore = rows.results.length > paging.limit;
    const overflow = hasMore ? rows.results[paging.limit] : undefined;
    return c.json(
      apiData(c, {
        items: rows.results.slice(0, paging.limit).map((r) => ({
          commentId: r.id,
          targetType: r.target_type as 'task' | 'material' | 'review' | 'rehearsal',
          targetId: r.target_id,
          authorId: r.author_id,
          authorName: r.author_name,
          body: r.body,
          createdAt: r.created_at,
        })),
        nextCursor: overflow ? (nextCursor(paging, { createdAt: overflow.created_at, id: overflow.id }) ?? null) : null,
      }),
      200,
    );
  });
}
