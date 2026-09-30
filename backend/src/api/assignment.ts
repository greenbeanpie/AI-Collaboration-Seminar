import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { invalidState, notFound, validationFailed } from '../core/errors';
import { LIMITS } from '../core/limits';
import { withReservedAiJob } from '../services/budget';
import { createJobAndDispatch } from '../services/jobs';
import { withIdempotency } from '../services/idempotency';
import { projectParams } from './projects';

const suggestionBody = z.object({
  requirementSetId: z.string().uuid().optional(),
  taskIds: z.array(z.string().uuid()).min(1).max(LIMITS.assignmentSuggestionMaxTasks).optional(),
}).refine((body) => !body.taskIds || new Set(body.taskIds).size === body.taskIds.length, {
  message: 'taskIds 不可重复',
  path: ['taskIds'],
});

const suggestionResponse = apiEnvelope(z.object({ jobId: z.string().uuid() }), 'AssignmentSuggestionResponse');

const suggestionRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/assignment-suggestions',
  tags: ['assignment'],
  summary: '生成项目任务分工建议（异步；只生成建议，不直接修改任务）',
  request: { params: projectParams, body: { content: { 'application/json': { schema: suggestionBody } }, required: true } },
  responses: {
    202: { content: { 'application/json': { schema: suggestionResponse } }, description: '建议任务已创建，轮询 jobId 获取结果' },
    400: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '任务列表或要求集参数不合法' },
    403: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '非项目成员' },
    404: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '要求集不存在' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '要求集状态或任务状态不允许' },
    429: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '项目 AI 并发名额已满' },
  },
});

interface TaskRow {
  id: string;
  title: string;
  detail: string;
  due_date: string | null;
  due_precision: 'date' | 'datetime' | 'unknown';
  status: 'todo' | 'doing' | 'blocked' | 'done';
  assignee_id: string | null;
  revision: number;
}

interface MemberRow {
  user_id: string;
  display_name: string;
  skills_json: string;
  hours_per_week: number | null;
}

export function registerAssignmentRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects/:projectId/assignment-suggestions', requireUser, requireProjectMember());

  app.openapi(suggestionRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const user = c.get('user')!;
    const idem = await withIdempotency(c.env, {
      key: c.req.header('idempotency-key'),
      userId: user.id,
      operation: 'assignment-suggestions.create',
      rawBody: JSON.stringify(body),
    }, async () => {
    let taskRows: TaskRow[];

    if (body.taskIds) {
      const placeholders = body.taskIds.map((_, index) => `?${index + 2}`).join(', ');
      const result = await c.env.DB.prepare(
        `SELECT id, title, detail, due_date, due_precision, status, assignee_id, revision
         FROM tasks WHERE project_id = ?1 AND status != 'done' AND id IN (${placeholders})`,
      )
        .bind(member.projectId, ...body.taskIds)
        .all<TaskRow>();
      if (result.results.length !== body.taskIds.length) {
        throw validationFailed('任务必须存在于当前项目且尚未完成');
      }
      const byId = new Map(result.results.map((task) => [task.id, task]));
      taskRows = body.taskIds.map((id) => byId.get(id)!);
    } else {
      const result = await c.env.DB.prepare(
        `SELECT id, title, detail, due_date, due_precision, status, assignee_id, revision
         FROM tasks WHERE project_id = ?1 AND status != 'done' ORDER BY created_at, id LIMIT ?2`,
      )
        .bind(member.projectId, LIMITS.assignmentSuggestionMaxTasks + 1)
        .all<TaskRow>();
      if (result.results.length > LIMITS.assignmentSuggestionMaxTasks) {
        throw validationFailed(`未完成任务超过 ${LIMITS.assignmentSuggestionMaxTasks} 项，请选择部分任务后重试`);
      }
      taskRows = result.results;
    }
    if (taskRows.length === 0) throw invalidState('当前没有可生成分工建议的未完成任务');

    let requirementSetId: string | null = null;
    if (body.requirementSetId) {
      const set = await c.env.DB.prepare('SELECT id, status FROM requirement_sets WHERE id = ?1 AND project_id = ?2')
        .bind(body.requirementSetId, member.projectId)
        .first<{ id: string; status: 'draft' | 'confirmed' }>();
      if (!set) throw notFound('要求集不存在');
      if (set.status !== 'confirmed') throw invalidState('分工建议只能使用已确认的要求集');
      requirementSetId = set.id;
    } else {
      const set = await c.env.DB.prepare(
        "SELECT id FROM requirement_sets WHERE project_id = ?1 AND status = 'confirmed' ORDER BY confirmed_at DESC, id DESC LIMIT 1",
      )
        .bind(member.projectId)
        .first<{ id: string }>();
      requirementSetId = set?.id ?? null;
    }

    const requirements = requirementSetId
      ? await c.env.DB.prepare(
          'SELECT title, detail FROM requirements WHERE project_id = ?1 AND requirement_set_id = ?2 ORDER BY seq, id',
        )
          .bind(member.projectId, requirementSetId)
          .all<{ title: string; detail: string }>()
      : { results: [] as Array<{ title: string; detail: string }> };
    const members = await c.env.DB.prepare(
      `SELECT pm.user_id, u.display_name, pm.skills_json, pm.hours_per_week
       FROM project_members pm JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ?1 ORDER BY pm.joined_at, pm.user_id`,
    )
      .bind(member.projectId)
      .all<MemberRow>();

    return withReservedAiJob(c.env, { projectId: member.projectId, purpose: 'assignment_suggest' }, async (jobId, configVersionId) => {
      await createJobAndDispatch(c.env, {
        projectId: member.projectId,
        kind: 'assignment_suggest',
        jobId,
        createdBy: user.id,
        input: {
          configVersionId,
          projectId: member.projectId,
          requestedBy: user.id,
          requirementSetId,
          requirements: requirements.results,
          tasks: taskRows.map((task) => ({
            taskId: task.id,
            title: task.title,
            detail: task.detail,
            dueDate: task.due_date,
            duePrecision: task.due_precision,
            status: task.status,
            assigneeId: task.assignee_id,
            revision: task.revision,
          })),
          members: members.results.map((projectMember) => ({
            userId: projectMember.user_id,
            displayName: projectMember.display_name,
            skills: JSON.parse(projectMember.skills_json) as string[],
            hoursPerWeek: projectMember.hours_per_week,
          })),
        },
      });
    return { status: 202 as const, body: { jobId } };
    });
    });
    return c.json(apiData(c, idem.body), idem.status);
  });
}
