import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { AppError, invalidState, notFound, permissionDenied, versionConflict } from '../core/errors';
import { effectivePermissions, grantedPermissionLabels, permissionLabels, permissionSchema, projectAdministratorSql, projectPermissionSql, requireProjectAdministrator, storedPermissions } from '../services/project-permissions';
import { newId, nowIso } from '../core/db';
import { notificationStatements } from '../services/notifications';
import { projectParams } from './projects';

const memberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().nullable(),
  username: z.string().nullable(),
  isAdmin: z.boolean(),
  displayName: z.string(),
  role: z.enum(['owner', 'member']),
  joinedAt: z.string(),
  permissions: permissionSchema,
  permissionsRevision: z.number().int(),
  /** 该成员是否是本项目内的权限管理员（仅 owner），与权限管理入口的可用性一致。 */
  canManagePermissions: z.boolean(),
});
const memberListResponse = apiEnvelope(z.object({ items: z.array(memberSchema) }), 'MemberListResponse');
const memberResponse = apiEnvelope(memberSchema, 'MemberResponse');
const memberRemoveResponse = apiEnvelope(z.object({ removed: z.boolean() }), 'MemberRemoveResponse');
const memberLeaveResponse = apiEnvelope(z.object({ left: z.boolean() }), 'MemberLeaveResponse');
const permissionRoute = createRoute({
  method: 'patch', path: '/api/v1/projects/{projectId}/members/{userId}/permissions', tags: ['members'],
  summary: '项目负责人调整组员权限',
  request: { params: projectParams.extend({ userId: z.string().uuid() }), body: { required: true, content: { 'application/json': { schema: z.object({ expectedRevision: z.number().int().positive(), permissions: permissionSchema }).strict() } } } },
  responses: { 200: { description: '已保存', content: { 'application/json': { schema: memberResponse } } }, 403: { description: '权限不足', content: { 'application/json': { schema: apiErrorEnvelope } } }, 409: { description: '权限版本变化', content: { 'application/json': { schema: apiErrorEnvelope } } } },
});

const memberListRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/members',
  tags: ['members'],
  summary: '成员身份、项目角色与加入信息',
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
  summary: '已停用：个人资料改由全局个人资料维护',
  deprecated: true,
  request: { params: projectParams },
  responses: {
    410: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '项目资料维护已停用，请前往全局个人资料' },
    403: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '非成员' },
  },
});

const memberRemoveRoute = createRoute({
  method: 'delete',
  path: '/api/v1/projects/{projectId}/members/{userId}',
  tags: ['members'],
  summary: '移除非负责人成员（需要团队管理权限）',
  request: { params: projectParams.extend({ userId: z.string().uuid() }) },
  responses: {
    200: { content: { 'application/json': { schema: memberRemoveResponse } }, description: '已移除' },
    403: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '需要团队管理权限；负责人不可被移除' },
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
  member_id: string;
  user_id: string;
  email: string | null;
  username: string | null;
  is_admin: number;
  display_name: string;
  role: 'owner' | 'member';
  joined_at: string;
  account_role: string;
  permissions_json: string;
  permissions_revision: number;
}

function toMember(row: MemberRow) {
  return {
    userId: row.user_id,
    email: row.email,
    username: row.username,
    isAdmin: row.is_admin === 1,
    displayName: row.display_name,
    role: row.role,
    joinedAt: row.joined_at,
    permissions: effectivePermissions(row.role, row.permissions_json),
    permissionsRevision: row.permissions_revision,
    canManagePermissions: row.role === 'owner',
  };
}

// isAdmin 仅表示账号身份，不参与项目权限或成员移除判断。
const memberSelect = `SELECT pm.id AS member_id, pm.user_id, a.contact_email AS email, a.username, CASE WHEN COALESCE(a.account_role,CASE WHEN a.is_admin=1 THEN 'admin' ELSE 'user' END) IN ('admin','super_admin') THEN 1 ELSE 0 END AS is_admin, u.display_name, pm.role, pm.joined_at, pm.permissions_json, pm.permissions_revision, COALESCE(a.account_role,CASE WHEN a.is_admin=1 THEN 'admin' ELSE 'user' END) AS account_role
  FROM project_members pm JOIN users u ON u.id = pm.user_id LEFT JOIN auth_accounts a ON a.user_id = u.id`;

export function registerMemberRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects/:projectId/members', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/members/me', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/members/:userId/permissions', requireUser, requireProjectMember());
  // 注意：:userId 模式也会匹配 /me，需放行交给上面的成员级中间件处理
  app.use(
    '/api/v1/projects/:projectId/members/:userId',
    requireUser,
    async (c, next) => {
      if (c.req.param('userId') === 'me') {
        await next();
        return;
      }
      // 该模式其余情况仅有 DELETE（移除成员），需要 teamManage。
      return requireProjectMember({ permission: 'teamManage' })(c, next);
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

  app.openapi(permissionRoute, async c => {
    const { projectId, userId } = c.req.valid('param');
    const actorId = c.get('user')!.id;
    // 权限管理本身不来自 permissions_json：仅项目负责人可授权。
    // teamManage 只管理团队成员，不能修改任何人的权限。
    await requireProjectAdministrator(c.env,projectId,actorId);
    const target = await c.env.DB.prepare(`${memberSelect} WHERE pm.project_id=?1 AND pm.user_id=?2`).bind(projectId,userId).first<MemberRow>();
    if (!target) throw notFound('成员不存在');
    if (target.role === 'owner') throw permissionDenied('项目负责人权限不可降级');
    const body = c.req.valid('json'), token = newId(), at = nowIso();
    const previous = storedPermissions(target.permissions_json);
    const granted = grantedPermissionLabels(previous, body.permissions);
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE project_members SET permissions_json=?4,permissions_revision=permissions_revision+1 WHERE project_id=?1 AND user_id=?2 AND role='member' AND permissions_revision=?3 AND ${projectAdministratorSql('?1','?5')}`).bind(projectId,userId,body.expectedRevision,JSON.stringify(body.permissions),actorId),
      c.env.DB.prepare(`INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) SELECT ?1,?2,'user',?3,'member.permissions_changed','member',?4,?1,?5,?6 WHERE changes()=1`).bind(token,projectId,actorId,userId,JSON.stringify({ previous, permissions: body.permissions, revision: body.expectedRevision+1 }),at),
      // 站内通知复用同一事务：仅在权限真正写入后投递给该成员本人。
      ...notificationStatements(c.env, {
        key: `member-permissions:${projectId}:${userId}:${body.expectedRevision+1}`,
        kind: 'member_permissions_updated', scope: 'project', resourceId: projectId, actorId,
        url: `/app/projects/${projectId}/team`, now: at, recipientIds: [userId], guardSql: 'changes()=1',
        body: granted.length ? `已授予：${granted.join('、')}。其余权限以成员权限页为准。` : `当前权限：${Object.entries(body.permissions).filter(([, value]) => value).map(([key]) => permissionLabels[key as keyof typeof permissionLabels]).join('、') || '无'}。`,
        record: { table: 'project_members', id: target.member_id },
      }),
    ]);
    if (!results[0]?.meta.changes) throw versionConflict((await c.env.DB.prepare('SELECT permissions_revision FROM project_members WHERE project_id=?1 AND user_id=?2').bind(projectId,userId).first<{permissions_revision:number}>())?.permissions_revision ?? 0);
    const saved = await c.env.DB.prepare(`${memberSelect} WHERE pm.project_id=?1 AND pm.user_id=?2`).bind(projectId,userId).first<MemberRow>();
    return c.json(apiData(c,toMember(saved!)),200);
  });

  app.openapi(memberPatchMeRoute, async (c) => {
    c.header('Cache-Control', 'no-store');
    throw new AppError('INVALID_STATE', '个人资料已移至全局个人资料，请前往个人资料修改', 410, false, { profilePath: '/app/profile' });
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
    if (userId === member.userId) throw invalidState(member.role === 'owner' ? '负责人不可移除自己（应先转让负责人）' : '本人退出项目请使用「退出项目」');
    const target = await c.env.DB.prepare(
      `SELECT pm.id, pm.role FROM project_members pm
        WHERE pm.project_id = ?1 AND pm.user_id = ?2`,
    )
      .bind(member.projectId, userId)
      .first<{ id: string; role: 'owner' | 'member' }>();
    if (!target) throw notFound('成员不存在');
    if (target.role === 'owner') throw permissionDenied('项目负责人不可被移除（应先转让负责人）');
    // 账号身份不提供移除保护；事务内二次校验确保撤权后不能完成删除。
    const guard = projectPermissionSql('project_members.project_id','?2','teamManage');
    const removed = await c.env.DB.prepare(`DELETE FROM project_members WHERE id=?1 AND role!='owner' AND ${guard}`).bind(target.id,member.userId).run();
    if (!removed.meta.changes) throw permissionDenied('成员或权限已变化，请刷新');
    return c.json(apiData(c, { removed: true }), 200);
  });
}
