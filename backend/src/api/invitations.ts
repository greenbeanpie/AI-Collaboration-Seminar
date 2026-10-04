import { projectPermissionSql } from '../services/project-permissions';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { LIMITS } from '../core/limits';
import { newId, nowIso, sha256Hex } from '../core/db';
import { invalidState, notFound, quotaExceeded } from '../core/errors';
import { projectParams } from './projects';
import { readInvitationProject } from '../services/invitation-preview';

const inviteCodeBytes = 24;

function generateInviteCode(): string {
  const bytes = new Uint8Array(inviteCodeBytes);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_');
}

const invitationSchema = z.object({
  invitationId: z.string().uuid(),
  expiresAt: z.string(),
  maxUses: z.number().int().nullable(),
  usedCount: z.number().int(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
const invitationListResponse = apiEnvelope(
  z.object({ items: z.array(invitationSchema) }),
  'InvitationListResponse',
);

const createBody = z.object({
  /** null = 次数不限，到期或撤销前可用 */
  maxUses: z.number().int().min(1).max(100).nullable().default(null),
  expiresInDays: z.number().int().min(1).max(30).default(LIMITS.invitationTtlDays),
});

const createResponse = apiEnvelope(
  invitationSchema.extend({
    /** 邀请码仅创建时返回一次，服务端只存哈希 */
    code: z.string(),
  }),
  'InvitationCreateResponse',
);

const invitationCreateRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/invitations',
  tags: ['invitations'],
  summary: '创建邀请（teamManage；邀请码仅返回一次）',
  request: { params: projectParams, body: { content: { 'application/json': { schema: createBody } }, required: true } },
  responses: {
    201: { content: { 'application/json': { schema: createResponse } }, description: '已创建' },
    403: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '需要团队管理权限' },
  },
});

const invitationListRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/invitations',
  tags: ['invitations'],
  summary: '邀请列表（teamManage）',
  request: { params: projectParams },
  responses: { 200: { content: { 'application/json': { schema: invitationListResponse } }, description: '列表' } },
});

const invitationRevokeRoute = createRoute({
  method: 'delete',
  path: '/api/v1/projects/{projectId}/invitations/{invitationId}',
  tags: ['invitations'],
  summary: '撤销邀请（teamManage）',
  request: { params: projectParams.extend({ invitationId: z.string().uuid() }) },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: apiEnvelope(z.object({ revoked: z.boolean() }), 'InvitationRevokeResponse'),
        },
      },
      description: '已撤销',
    },
  },
});

export const invitationPreviewResponse = apiEnvelope(z.object({
  projectId: z.string().uuid(), projectName: z.string(), description: z.string(),
  goal: z.object({ title: z.string(), detail: z.string() }),
}), 'InvitationPreviewResponse');
const acceptBody = z.object({ code: z.string().min(10).max(200) });
const acceptResponse = apiEnvelope(
  z.object({ projectId: z.string().uuid(), projectName: z.string() }),
  'InvitationAcceptResponse',
);

const invitationAcceptRoute = createRoute({
  method: 'post',
  path: '/api/v1/invitations/accept',
  tags: ['invitations'],
  summary: '接受邀请（原子校验有效期/次数/人数规则）',
  request: { body: { content: { 'application/json': { schema: acceptBody } }, required: true } },
  responses: {
    200: { content: { 'application/json': { schema: acceptResponse } }, description: '已加入项目' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '邀请失效/已满/已是成员' },
    429: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '项目人数已达上限' },
  },
});

interface InvitationRow {
  id: string;
  project_id: string;
  expires_at: string;
  max_uses: number | null;
  used_count: number;
  revoked_at: string | null;
  created_at: string;
}

export function registerInvitationRoutes(app: OpenAPIHono<AppEnv>): void {
  // 邀请、撤销邀请、用户名邀请与加入申请审批统一由 teamManage 决定；
  // 不再叠加历史 'grant' 语义，避免前端可见、后端 403。
  app.use('/api/v1/projects/:projectId/invitations', requireUser, requireProjectMember({ permission: 'teamManage' }));
  app.use('/api/v1/projects/:projectId/invitations/:invitationId', requireUser, requireProjectMember({ permission: 'teamManage' }));
  app.use('/api/v1/invitations/accept', requireUser);
  app.use('/api/v1/invitations/preview', requireUser);

  app.openapi(createRoute({
    method: 'post', path: '/api/v1/invitations/preview', tags: ['invitations'],
    summary: '只读邀请码预览，不占用次数或加入项目',
    request: { body: { content: { 'application/json': { schema: acceptBody } }, required: true } },
    responses: { 200: { content: { 'application/json': { schema: invitationPreviewResponse } }, description: '项目邀请详情' } },
  }), async (c) => {
    const invitation = await c.env.DB.prepare('SELECT * FROM invitations WHERE code_hash=?1')
      .bind(await sha256Hex(c.req.valid('json').code)).first<InvitationRow>();
    if (!invitation) throw invalidState('邀请无效');
    if (invitation.revoked_at !== null) throw invalidState('邀请码已被撤销');
    if (invitation.expires_at <= nowIso()) throw invalidState('邀请码已过期');
    if (invitation.max_uses !== null && invitation.used_count >= invitation.max_uses) throw invalidState('邀请码已达到使用次数上限');
    return c.json(apiData(c, await readInvitationProject(c.env, invitation.project_id, c.get('user')!.id)), 200);
  });

  app.openapi(invitationCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const invitationId = newId();
    const code = generateInviteCode();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString();
    const inserted = await c.env.DB.prepare(
      `INSERT INTO invitations (id, project_id, code_hash, created_by, expires_at, max_uses, used_count, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 0, ?7 WHERE ${projectPermissionSql('?2','?4','teamManage')}`,
    )
      .bind(invitationId, member.projectId, await sha256Hex(code), c.get('user')!.id, expiresAt, body.maxUses, createdAt)
      .run();
    if (!inserted.meta.changes) throw invalidState('邀请权限已变化，请刷新');
    return c.json(
      apiData(c, {
        invitationId,
        code,
        expiresAt,
        maxUses: body.maxUses,
        usedCount: 0,
        revokedAt: null,
        createdAt,
      }),
      201,
    );
  });

  app.openapi(invitationListRoute, async (c) => {
    const rows = await c.env.DB.prepare(
      'SELECT id, project_id, expires_at, max_uses, used_count, revoked_at, created_at FROM invitations WHERE project_id = ?1 ORDER BY created_at DESC',
    )
      .bind(c.get('member')!.projectId)
      .all<InvitationRow>();
    return c.json(
      apiData(c, {
        items: rows.results.map((r) => ({
          invitationId: r.id,
          expiresAt: r.expires_at,
          maxUses: r.max_uses,
          usedCount: r.used_count,
          revokedAt: r.revoked_at,
          createdAt: r.created_at,
        })),
      }),
      200,
    );
  });

  app.openapi(invitationRevokeRoute, async (c) => {
    const { invitationId } = c.req.valid('param');
    const result = await c.env.DB.prepare(
      `UPDATE invitations SET revoked_at = ?2 WHERE id = ?1 AND project_id = ?3 AND revoked_at IS NULL AND ${projectPermissionSql('?3','?4','teamManage')}`,
    )
      .bind(invitationId, nowIso(), c.get('member')!.projectId, c.get('user')!.id)
      .run();
    if ((result.meta?.changes ?? 0) === 0) throw notFound('邀请不存在或已撤销');
    return c.json(apiData(c, { revoked: true }), 200);
  });

  app.openapi(invitationAcceptRoute, async (c) => {
    const body = c.req.valid('json');
    const user = c.get('user')!;
    const codeHash = await sha256Hex(body.code);
    const invitation = await c.env.DB.prepare('SELECT * FROM invitations WHERE code_hash = ?1')
      .bind(codeHash)
      .first<InvitationRow>();
    if (!invitation) throw invalidState('邀请无效');

    // 原子占用一个使用名额（撤销/过期/超限均使条件更新失败）
    const claim = await c.env.DB.prepare(
      `UPDATE invitations SET used_count = used_count + 1
       WHERE id = ?1 AND revoked_at IS NULL AND expires_at > ?2 AND (max_uses IS NULL OR used_count < max_uses)`,
    )
      .bind(invitation.id, nowIso())
      .run();
    if ((claim.meta?.changes ?? 0) === 0) {
      const latest = await c.env.DB.prepare('SELECT revoked_at,expires_at,max_uses,used_count FROM invitations WHERE id=?1').bind(invitation.id).first<InvitationRow>();
      if (!latest) throw invalidState('邀请码不存在');
      if (latest.revoked_at !== null) throw invalidState('邀请码已被撤销');
      if (latest.expires_at <= nowIso()) throw invalidState('邀请码已过期');
      if (latest.max_uses !== null && latest.used_count >= latest.max_uses) throw invalidState('邀请码已达到使用次数上限');
      throw invalidState('邀请码使用次数未能确认，请刷新后重试');
    }

    const project = await c.env.DB.prepare('SELECT id, name, team_size_limit, status FROM projects WHERE id = ?1')
      .bind(invitation.project_id)
      .first<{ id: string; name: string; team_size_limit: number | null; status: string }>();
    const release = () =>
      c.env.DB.prepare('UPDATE invitations SET used_count = used_count - 1 WHERE id = ?1').bind(invitation.id).run();

    if (!project || project.status !== 'active') {
      await release();
      throw invalidState('邀请对应的项目不可用');
    }

    // 项目人数规则（本赛模板 5 人限制存于项目字段，不硬编码）
    if (project.team_size_limit !== null) {
      const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?1')
        .bind(project.id)
        .first<{ n: number }>();
      if ((count?.n ?? 0) >= project.team_size_limit) {
        await release();
        throw quotaExceeded('项目人数已满', { teamSizeLimit: project.team_size_limit });
      }
    }

    try {
      const joined = await c.env.DB.prepare(
        `INSERT INTO project_members (id, project_id, user_id, role, joined_at)
         SELECT ?1, p.id, ?3, 'member', ?4 FROM projects p
         WHERE p.id = ?2 AND p.status = 'active'
           AND (p.team_size_limit IS NULL OR
             (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) < p.team_size_limit)
           AND EXISTS (SELECT 1 FROM invitations WHERE id = ?5 AND revoked_at IS NULL AND expires_at > ?4)`,
      )
        .bind(newId(), project.id, user.id, nowIso(), invitation.id)
        .run();
      if (!joined.meta.changes) {
        const current = await c.env.DB.prepare('SELECT status,team_size_limit,(SELECT COUNT(*) FROM project_members WHERE project_id=projects.id) member_count FROM projects WHERE id=?1').bind(project.id).first<{status:string;team_size_limit:number|null;member_count:number}>();
        if (!current) throw invalidState('项目不存在');
        if (current.status !== 'active') throw invalidState('项目已归档');
        const latest = await c.env.DB.prepare('SELECT revoked_at,expires_at FROM invitations WHERE id=?1').bind(invitation.id).first<{revoked_at:string|null;expires_at:string}>();
        if (!latest) throw invalidState('邀请码不存在');
        if (latest.revoked_at !== null) throw invalidState('邀请码已被撤销');
        if (latest.expires_at <= nowIso()) throw invalidState('邀请码已过期');
        if (current.team_size_limit !== null && current.member_count >= current.team_size_limit) throw quotaExceeded(`项目人数已达到上限：${current.member_count}/${current.team_size_limit}（含负责人）`);
        throw invalidState('成员记录未成功保存，请刷新后重试');
      }
    } catch (err) {
      await release();
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE')) throw invalidState('已是项目成员');
      throw err;
    }

    return c.json(apiData(c, { projectId: project.id, projectName: project.name }), 200);
  });
}
