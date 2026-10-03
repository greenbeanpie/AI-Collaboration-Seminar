import { readinessStatements } from '../services/task-readiness';
import { projectPermissionSql, requireProjectPermission } from '../services/project-permissions';
import { readTaskSummary, taskSummarySchema } from '../services/task-summary';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, validationFailed, versionConflict } from '../core/errors';
import { parsePaging, nextCursor } from '../core/pagination';
import { recordEvent } from '../services/events';
import { projectParams } from './projects';
import { projectGoal, taskDependencies, graphSnapshot, validateTaskGraph } from '../services/project-simplification';
import { owner } from '../services/collaboration';

const taskParams = projectParams.extend({ taskId: z.string().uuid() });

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const taskSchema = z.object({
  taskId: z.string().uuid(),
  lifecycleState: z.string().nullable(),
  criteria: z.string(), effortHours: z.number(), parentTaskId: z.string().uuid().nullable(), currentSubmissionId: z.string().uuid().nullable(),
  citations: z.array(z.unknown()), dependsOnTaskIds: z.array(z.string().uuid()), unfinishedDependencyIds: z.array(z.string().uuid()),
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
}).extend(taskSummarySchema.partial().shape);
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
  criteria: z.string().max(4000).default(''), effortHours: z.number().min(.25).max(200).default(1),
  dependsOnTaskIds: z.array(z.string().uuid()).max(1000).default([]), expectedGraphRevision:z.number().int().positive().optional(),
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
  criteria: z.string().min(1).max(4000).optional(), effortHours:z.number().min(.25).max(200).optional(),
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

const applyAssignmentBody = z.object({
  taskId: z.string().uuid(),
  assigneeId: z.string().uuid().nullable(),
  expectedRevision: z.number().int().min(1),
});

const applyAssignmentRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/tasks/apply-assignment',
  tags: ['tasks'],
  summary: '应用一项分工建议（仅修改负责人，保留任务状态）',
  request: { params: projectParams, body: { content: { 'application/json': { schema: applyAssignmentBody } }, required: true } },
  responses: {
    200: { content: { 'application/json': { schema: taskResponse } }, description: '负责人已更新' },
    400: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '负责人不是项目成员' },
    404: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '任务不存在' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '任务版本冲突' },
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
  lifecycle_state: string | null;
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
  criteria:string;effort_hours:number;parent_task_id:string|null;current_submission_id:string|null;source_citations_json:string;
}

function toTask(r: TaskRow) {
  return {
    taskId: r.id,
    lifecycleState: r.lifecycle_state ?? (r.status==='done'?'accepted':r.status==='doing'?'in_progress':'open'),
    criteria:r.criteria,effortHours:r.effort_hours,parentTaskId:r.parent_task_id,currentSubmissionId:r.current_submission_id,citations:JSON.parse(r.source_citations_json||'[]'),
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
async function taskView(env:AppEnv['Bindings'],r:TaskRow){return {...toTask(r),...await taskDependencies(env,r.project_id,r.id),...await readTaskSummary(env,r)};}

const commentSelect = `SELECT c.id, c.target_type, c.target_id, c.author_id, u.display_name AS author_name, c.body, c.created_at
  FROM comments c JOIN users u ON u.id = c.author_id`;

export function registerTaskRoutes(app: OpenAPIHono<AppEnv>): void {
  // * 通配覆盖 tasks/comments 全部深度（M3 经验：必须覆盖子路径）
  app.use('/api/v1/projects/:projectId/tasks/*', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/comments/*', requireUser, requireProjectMember());

  app.openapi(taskCreateRoute, async (c) => {
    await requireProjectPermission(c.env,c.get('member')!.projectId,c.get('user')!.id,'taskManage');
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const id = newId();
    const now = nowIso();
    const goal=await projectGoal(c.env,member.projectId),graph=await graphSnapshot(c.env,member.projectId);
    if(body.expectedGraphRevision!==undefined&&body.expectedGraphRevision!==goal.graphRevision)throw versionConflict(goal.graphRevision);
    if(body.dependsOnTaskIds.length){await owner(c.env,member.projectId,c.get('user')!.id);if(body.expectedGraphRevision===undefined)throw validationFailed('设置依赖需要当前依赖图版本');}
    validateTaskGraph([...graph.taskIds,id],[...graph.edges,...body.dependsOnTaskIds.map(dependency=>({taskId:id,dependsOnTaskId:dependency}))]);
    if(body.assigneeId&&!await c.env.DB.prepare('SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2').bind(member.projectId,body.assigneeId).first())throw validationFailed('负责人必须是当前项目成员');
    if(body.requirementId&&!await c.env.DB.prepare('SELECT 1 FROM requirements WHERE project_id=?1 AND id=?2').bind(member.projectId,body.requirementId).first())throw validationFailed('要求必须属于当前项目');
    const token=newId();
    const createdResults = await c.env.DB.batch([c.env.DB.prepare(`UPDATE project_goals SET graph_revision=graph_revision+1,graph_token=?3 WHERE project_id=?1 AND graph_revision=?2 AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?4 AND (?5>=0 AND ${projectPermissionSql('project_members.project_id','project_members.user_id','taskManage')})) AND (?6 IS NULL OR EXISTS(SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?6)) AND (?7 IS NULL OR EXISTS(SELECT 1 FROM requirements WHERE project_id=?1 AND id=?7))`).bind(member.projectId,goal.graphRevision,token,c.get('user')!.id,body.dependsOnTaskIds.length?1:0,body.assigneeId,body.requirementId),c.env.DB.prepare(
      `INSERT INTO tasks (id, project_id, title, detail, assignee_id, due_date, due_precision, status, requirement_id, revision, created_by, created_at, updated_at,criteria,effort_hours,lifecycle_state)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, CASE WHEN ?5 IS NOT NULL THEN 'doing' ELSE 'todo' END, ?8, 1, ?9, ?10, ?10,?11,?12,CASE WHEN ?5 IS NULL THEN 'open' ELSE 'in_progress' END
       WHERE (?5 IS NULL OR EXISTS (
         SELECT 1 FROM project_members pm WHERE pm.project_id = ?2 AND pm.user_id = ?5
       ))
       AND (?8 IS NULL OR EXISTS (
         SELECT 1 FROM requirements r WHERE r.id = ?8 AND r.project_id = ?2
       )) AND EXISTS(SELECT 1 FROM project_goals WHERE project_id=?2 AND graph_token=?13)`,
    )
      .bind(id, member.projectId, body.title, body.detail, body.assigneeId, body.dueDate, body.duePrecision, body.requirementId, c.get('user')!.id, now,body.criteria,body.effortHours,token),...body.dependsOnTaskIds.map(dependency=>c.env.DB.prepare(`INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,created_at) SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM tasks WHERE id=?2 AND project_id=?1) AND EXISTS(SELECT 1 FROM project_goals WHERE project_id=?1 AND graph_token=?5)`).bind(member.projectId,id,dependency,now,token)),...readinessStatements(c.env,member.projectId,[id])]);
    if(!createdResults[0]?.meta.changes)throw versionConflict((await projectGoal(c.env,member.projectId)).graphRevision);
    const created=createdResults[1]!;
    if ((created.meta?.changes ?? 0) === 0) {
      if (body.assigneeId) {
        const assignee = await c.env.DB.prepare('SELECT 1 AS present FROM project_members WHERE project_id = ?1 AND user_id = ?2')
          .bind(member.projectId, body.assigneeId)
          .first();
        if (!assignee) throw validationFailed('负责人必须是当前项目成员');
      }
      if (body.requirementId) {
        const requirement = await c.env.DB.prepare('SELECT 1 AS present FROM requirements WHERE id = ?1 AND project_id = ?2')
          .bind(body.requirementId, member.projectId)
          .first();
        if (!requirement) throw validationFailed('要求必须属于当前项目');
      }
      throw invalidState('任务创建未生效');
    }
    const row = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?1').bind(id).first<TaskRow>();
    if (!row) throw notFound('任务创建失败');
    await recordEvent(c.env,{projectId:member.projectId,actorType:'user',actorId:c.get('user')!.id,type:'task.created',entityType:'task',entityId:id,dedupKey:id,payload:body});
    return c.json(apiData(c, await taskView(c.env,row)), 201);
  });

  app.openapi(taskListRoute, async (c) => {
    const member = c.get('member')!;
    const paging = parsePaging(c.req.valid('query'));
    const status = c.req.valid('query').status ?? 'all';
    const conditions = ['project_id = ?1','archived_at IS NULL'];
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
    const pageRows = rows.results.slice(0, paging.limit);
    const lastRow = pageRows[pageRows.length - 1];
    return c.json(
      apiData(c, {
        items: await Promise.all(pageRows.map(r=>taskView(c.env,r))),
        nextCursor: nextCursor(hasMore, lastRow ? { createdAt: lastRow.created_at, id: lastRow.id } : undefined) ?? null,
      }),
      200,
    );
  });

  app.openapi(taskGetRoute, async (c) => {
    const row = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?1 AND project_id = ?2')
      .bind(c.req.valid('param').taskId, c.get('member')!.projectId)
      .first<TaskRow>();
    if (!row) throw notFound('任务不存在');
    return c.json(apiData(c, await taskView(c.env,row)), 200);
  });

  app.openapi(taskPatchRoute, async (c) => {
    await requireProjectPermission(c.env,c.get('member')!.projectId,c.get('user')!.id,'taskManage');
    const body = c.req.valid('json');
    const taskId = c.req.valid('param').taskId;
    const projectId = c.get('member')!.projectId;
    const current = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?1 AND project_id = ?2')
      .bind(taskId, projectId)
      .first<TaskRow>();
    if (!current) throw notFound('任务不存在');
    if ((current as TaskRow & {archived_at?:string}).archived_at)throw invalidState('归档任务仅可查看历史');
    if(current.lifecycle_state||body.criteria!==undefined||body.effortHours!==undefined){
      if(body.status!==undefined||body.assigneeId!==undefined)throw invalidState('任务完成与重新分工需要提交和验收流程');
      await owner(c.env,projectId,c.get('user')!.id);
      if(body.requirementId&&!await c.env.DB.prepare('SELECT 1 FROM requirements WHERE id=?1 AND project_id=?2').bind(body.requirementId,projectId).first())throw validationFailed('要求必须属于当前项目');
      const updated=await c.env.DB.prepare(`UPDATE tasks SET title=COALESCE(?4,title),detail=COALESCE(?5,detail),criteria=COALESCE(?6,criteria),effort_hours=COALESCE(?7,effort_hours),due_date=CASE WHEN ?8=1 THEN ?9 ELSE due_date END,due_precision=COALESCE(?10,due_precision),requirement_id=CASE WHEN ?13=1 THEN ?14 ELSE requirement_id END,revision=revision+1,updated_at=?11 WHERE id=?1 AND project_id=?2 AND revision=?3 AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?12 AND ${projectPermissionSql('project_members.project_id','project_members.user_id','taskManage')}) AND (?13=0 OR ?14 IS NULL OR EXISTS(SELECT 1 FROM requirements WHERE id=?14 AND project_id=?2))`).bind(taskId,projectId,body.expectedRevision,body.title??null,body.detail??null,body.criteria??null,body.effortHours??null,'dueDate'in body?1:0,body.dueDate??null,body.duePrecision??null,nowIso(),c.get('user')!.id,'requirementId'in body?1:0,body.requirementId??null).run();
      if(updated.meta.changes)await recordEvent(c.env,{projectId,actorType:'user',actorId:c.get('user')!.id,type:'task.updated',entityType:'task',entityId:taskId,dedupKey:String(body.expectedRevision),payload:body});
      if(!updated.meta.changes)throw versionConflict((await c.env.DB.prepare('SELECT revision FROM tasks WHERE id=?1').bind(taskId).first<{revision:number}>())!.revision);
      return c.json(apiData(c,await taskView(c.env,(await c.env.DB.prepare('SELECT * FROM tasks WHERE id=?1').bind(taskId).first<TaskRow>())!)),200);
    }
    if (current.revision !== body.expectedRevision) throw versionConflict(current.revision);

    const statusChanged = body.status !== undefined && body.status !== current.status;
    const updated = await c.env.DB.prepare(
      `UPDATE tasks SET
         title = COALESCE(?2, title),
         detail = COALESCE(?3, detail),
         assignee_id = CASE WHEN ?12 = 1 THEN ?4 ELSE assignee_id END,
         due_date = CASE WHEN ?13 = 1 THEN ?5 ELSE due_date END,
         due_precision = COALESCE(?6, due_precision),
         status = COALESCE(?7, status),
         requirement_id = CASE WHEN ?14 = 1 THEN ?8 ELSE requirement_id END,
         revision = revision + 1,
         updated_at = ?9
       WHERE id = ?1 AND project_id = ?10 AND revision = ?11 AND lifecycle_state IS NULL AND ${projectPermissionSql('?10','?15','taskManage')}
         AND (?12 = 0 OR ?4 IS NULL OR EXISTS (
           SELECT 1 FROM project_members pm WHERE pm.project_id = ?10 AND pm.user_id = ?4
         ))
         AND (?14 = 0 OR ?8 IS NULL OR EXISTS (
           SELECT 1 FROM requirements r WHERE r.id = ?8 AND r.project_id = ?10
         ))`,
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
        projectId,
        body.expectedRevision,
        body.assigneeId === undefined ? 0 : 1,
        body.dueDate === undefined ? 0 : 1,
        body.requirementId === undefined ? 0 : 1,
        c.get('user')!.id,
      )
      .run();
    if ((updated.meta?.changes ?? 0) === 0) {
      const latest = await c.env.DB.prepare('SELECT revision FROM tasks WHERE id = ?1 AND project_id = ?2')
        .bind(taskId, projectId)
        .first<{ revision: number }>();
      if (!latest) throw notFound('任务不存在');
      if (latest.revision !== body.expectedRevision) throw versionConflict(latest.revision);
      if (body.assigneeId) {
        const assignee = await c.env.DB.prepare('SELECT 1 AS present FROM project_members WHERE project_id = ?1 AND user_id = ?2')
          .bind(projectId, body.assigneeId)
          .first();
        if (!assignee) throw validationFailed('负责人必须是当前项目成员');
      }
      if (body.requirementId) {
        const requirement = await c.env.DB.prepare('SELECT 1 AS present FROM requirements WHERE id = ?1 AND project_id = ?2')
          .bind(body.requirementId, projectId)
          .first();
        if (!requirement) throw validationFailed('要求必须属于当前项目');
      }
      throw invalidState('更新未生效');
    }

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
    return c.json(apiData(c, await taskView(c.env,row)), 200);
  });

  app.openapi(applyAssignmentRoute, async (c) => {
    await requireProjectPermission(c.env,c.get('member')!.projectId,c.get('user')!.id,'taskManage');
    const { taskId, assigneeId, expectedRevision } = c.req.valid('json');
    const projectId = c.get('member')!.projectId;
    const current = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?1 AND project_id = ?2')
      .bind(taskId, projectId)
      .first<TaskRow>();
    if (!current) throw notFound('任务不存在');
    if ((current as TaskRow & {archived_at?:string}).archived_at)throw invalidState('归档任务仅可查看历史');
    if (current.lifecycle_state) throw invalidState('协作任务必须使用协作流程接口，不能绕过提交与验收');
    if (current.revision !== expectedRevision) throw versionConflict(current.revision);

    // 版本与成员资格都在同一 UPDATE 内复核，防止预读后并发改任务或移除成员。
    const updated = await c.env.DB.prepare(
      `UPDATE tasks SET assignee_id = ?3, revision = revision + 1, updated_at = ?4
       WHERE id = ?1 AND project_id = ?2 AND revision = ?5 AND lifecycle_state IS NULL AND ${projectPermissionSql('?2','?6','taskManage')}
         AND (?3 IS NULL OR EXISTS (
           SELECT 1 FROM project_members pm WHERE pm.project_id = ?2 AND pm.user_id = ?3
         ))`,
    )
      .bind(taskId, projectId, assigneeId, nowIso(), expectedRevision, c.get('user')!.id)
      .run();

    if ((updated.meta?.changes ?? 0) === 0) {
      const latest = await c.env.DB.prepare('SELECT revision FROM tasks WHERE id = ?1 AND project_id = ?2')
        .bind(taskId, projectId)
        .first<{ revision: number }>();
      if (!latest) throw notFound('任务不存在');
      if (latest.revision !== expectedRevision) throw versionConflict(latest.revision);
      if (assigneeId !== null) {
        const member = await c.env.DB.prepare('SELECT 1 AS present FROM project_members WHERE project_id = ?1 AND user_id = ?2')
          .bind(projectId, assigneeId)
          .first();
        if (!member) throw validationFailed('负责人必须是当前项目成员');
      }
      throw invalidState('分工应用未生效');
    }

    await recordEvent(c.env, {
      projectId,
      actorType: 'user',
      actorId: c.get('user')!.id,
      type: 'task.assignment_applied',
      entityType: 'task',
      entityId: taskId,
      dedupKey: `assignment:${expectedRevision}`,
      payload: { assigneeId, expectedRevision },
    });

    const row = await c.env.DB.prepare('SELECT * FROM tasks WHERE id = ?1 AND project_id = ?2')
      .bind(taskId, projectId)
      .first<TaskRow>();
    if (!row) throw notFound('任务不存在');
    return c.json(apiData(c, await taskView(c.env,row)), 200);
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
      cursorSql = ' AND (c.created_at > ? OR (c.created_at = ? AND c.id > ?))';
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
    const pageRows = rows.results.slice(0, paging.limit);
    const lastRow = pageRows[pageRows.length - 1];
    return c.json(
      apiData(c, {
        items: pageRows.map((r) => ({
          commentId: r.id,
          targetType: r.target_type as 'task' | 'material' | 'review' | 'rehearsal',
          targetId: r.target_id,
          authorId: r.author_id,
          authorName: r.author_name,
          body: r.body,
          createdAt: r.created_at,
        })),
        nextCursor: nextCursor(hasMore, lastRow ? { createdAt: lastRow.created_at, id: lastRow.id } : undefined) ?? null,
      }),
      200,
    );
  });
}
