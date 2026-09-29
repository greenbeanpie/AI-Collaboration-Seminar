import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { invalidState, notFound } from '../core/errors';
import { projectParams } from './projects';

const memberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(['owner', 'member']),
  skills: z.array(z.string()),
  hoursPerWeek: z.number().nullable(),
  joinedAt: z.string(),
});
const memberListResponse = apiEnvelope(z.object({ items: z.array(memberSchema) }), 'MemberListResponse');
const memberResponse = apiEnvelope(memberSchema, 'MemberResponse');
const memberRemoveResponse = apiEnvelope(z.object({ removed: z.boolean() }), 'MemberRemoveResponse');
const memberLeaveResponse = apiEnvelope(z.object({ left: z.boolean() }), 'MemberLeaveResponse');

const patchMeBody = z.object({
  skills: z.array(z.string().min(1).max(30)).max(10).optional(),
  hoursPerWeek: z.number().min(0).max(168).nullable().optional(),
});

const memberListRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/members',
  tags: ['members'],
  summary: '成员列表（含技能与投入时间，供分工建议）',
  request: { params: projectParams },
  responses: { 200: { content: { 'application/json': { schema: memberListResponse } }, description: '成员列表' } },
});

const memberGetMeRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/members/me',
  tags: ['members'],
  summary: '我在项目中的成员信息',
  request: { params: projectParams },
  responses: { 200: { content: { 'application/json': { schema: memberResponse } }, description: '成员信息' } },
});

const memberPatchMeRoute = createRoute({
  method: 'patch',
  path: '/api/v1/projects/{projectId}/members/me',
  tags: ['members'],
  summary: '维护我的技能与投入时间（供分工建议）',
  request: { params: projectParams, body: { content: { 'application/json': { schema: patchMeBody } }, required: true } },
  responses: {
    200: { content: { 'application/json': { schema: memberResponse } }, description: '已更新' },
    403: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '非成员' },
  },
});

const memberRemoveRoute = createRoute({
  method: 'delete',
  path: '/api/v1/projects/{projectId}/members/{userId}',
  tags: ['members'],
  summary: '移除成员（owner；负责人不可移除自己）',
  request: { params: projectParams.extend({ userId: z.string().uuid() }) },
  responses: {
    200: { content: { 'application/json': { schema: memberRemoveResponse } }, description: '已移除' },
    403: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '需要负责人权限' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '不允许的移除操作' },
  },
});

const memberLeaveRoute = createRoute({
  method: 'delete',
  path: '/api/v1/projects/{projectId}/members/me',
  tags: ['members'],
  summary: '退出项目（负责人不可退出，须先转让）',
  request: { params: projectParams },
  responses: {
    200: { content: { 'application/json': { schema: memberLeaveResponse } }, description: '已退出' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '负责人不可退出' },
  },
});

interface MemberRow {
  user_id: string;
  email: string;
  display_name: string;
  role: 'owner' | 'member';
  skills_json: string;
  hours_per_week: number | null;
  joined_at: string;
}

function toMember(row: MemberRow) {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    skills: JSON.parse(row.skills_json) as string[],
    hoursPerWeek: row.hours_per_week,
    joinedAt: row.joined_at,
  };
}

const memberSelect = `SELECT pm.user_id, u.email, u.display_name, pm.role, pm.skills_json, pm.hours_per_week, pm.joined_at
  FROM project_members pm JOIN users u ON u.id = pm.user_id`;

export function registerMemberRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects/:projectId/members', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/members/me', requireUser, requireProjectMember());
  // 注意：:userId 模式也会匹配 /me，需放行交给上面的成员级中间件处理
  app.use(
    '/api/v1/projects/:projectId/members/:userId',
    requireUser,
    async (c, next) => {
      if (c.req.param('userId') === 'me') {
        await next();
        return;
      }
      // 该模式其余情况仅有 DELETE（移除成员），属 owner 权限
      return requireProjectMember({ owner: true })(c, next);
    },
  );

  app.openapi(memberListRoute, async (c) => {
    const rows = await c.env.DB.prepare(`${memberSelect} WHERE pm.project_id = ?1 ORDER BY pm.joined_at`)
      .bind(c.get('member')!.projectId)
      .all<MemberRow>();
    return c.json(apiData(c, { items: rows.results.map(toMember) }), 200);
  });

  app.openapi(memberGetMeRoute, async (c) => {
    const row = await c.env.DB.prepare(`${memberSelect} WHERE pm.project_id = ?1 AND pm.user_id = ?2`)
      .bind(c.get('member')!.projectId, c.get('user')!.id)
      .first<MemberRow>();
    if (!row) throw notFound('成员不存在');
    return c.json(apiData(c, toMember(row)), 200);
  });

  app.openapi(memberPatchMeRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    await c.env.DB.prepare(
      'UPDATE project_members SET skills_json = COALESCE(?2, skills_json), hours_per_week = COALESCE(?3, hours_per_week) WHERE project_id = ?1',
    )
      .bind(member.projectId, body.skills ? JSON.stringify(body.skills) : null, body.hoursPerWeek ?? null)
      .run();
    const row = await c.env.DB.prepare(`${memberSelect} WHERE pm.project_id = ?1 AND pm.user_id = ?2`)
      .bind(member.projectId, c.get('user')!.id)
      .first<MemberRow>();
    if (!row) throw notFound('成员不存在');
    return c.json(apiData(c, toMember(row)), 200);
  });

  // 注意：leave（静态 /me）必须先于 remove（:userId 模式）注册——
  // Hono 会把同方法重叠路径的处理器组成链，首个返回响应的生效
  app.openapi(memberLeaveRoute, async (c) => {
    const member = c.get('member')!;
    if (member.role === 'owner') throw invalidState('负责人不可退出项目（应先转让负责人）');
    const result = await c.env.DB.prepare(
      "DELETE FROM project_members WHERE project_id = ?1 AND user_id = ?2 AND role = 'member'",
    )
      .bind(member.projectId, member.userId)
      .run();
    if ((result.meta?.changes ?? 0) === 0) throw invalidState('退出未生效');
    return c.json(apiData(c, { left: true }), 200);
  });

  app.openapi(memberRemoveRoute, async (c) => {
    const member = c.get('member')!;
    const { userId } = c.req.valid('param');
    if (userId === member.userId) throw invalidState('负责人不可移除自己（应先转让负责人）');
    const target = await c.env.DB.prepare(
      'SELECT id FROM project_members WHERE project_id = ?1 AND user_id = ?2',
    )
      .bind(member.projectId, userId)
      .first<{ id: string }>();
    if (!target) throw notFound('成员不存在');
    await c.env.DB.prepare('DELETE FROM project_members WHERE id = ?1').bind(target.id).run();
    return c.json(apiData(c, { removed: true }), 200);
  });
}
