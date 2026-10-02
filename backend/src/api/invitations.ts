import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { LIMITS } from '../core/limits';
import { newId, nowIso, sha256Hex } from '../core/db';
import { invalidState, notFound, quotaExceeded } from '../core/errors';
import { projectParams } from './projects';

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
  summary: '创建邀请（owner；邀请码仅返回一次）',
  request: { params: projectParams, body: { content: { 'application/json': { schema: createBody } }, required: true } },
  responses: {
    201: { content: { 'application/json': { schema: createResponse } }, description: '已创建' },
    403: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '需要负责人权限' },
  },
});

const invitationListRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/invitations',
  tags: ['invitations'],
  summary: '邀请列表（owner）',
  request: { params: projectParams },
  responses: { 200: { content: { 'application/json': { schema: invitationListResponse } }, description: '列表' } },
});

const invitationRevokeRoute = createRoute({
  method: 'delete',
  path: '/api/v1/projects/{projectId}/invitations/{invitationId}',
  tags: ['invitations'],
  summary: '撤销邀请（owner）',
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
  app.use('/api/v1/projects/:projectId/invitations', requireUser, requireProjectMember({ owner: true }));
  app.use('/api/v1/projects/:projectId/invitations/:invitationId', requireUser, requireProjectMember({ owner: true }));
  app.use('/api/v1/invitations/accept', requireUser);

  app.openapi(invitationCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const invitationId = newId();
    const code = generateInviteCode();
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString();
    await c.env.DB.prepare(
      `INSERT INTO invitations (id, project_id, code_hash, created_by, expires_at, max_uses, used_count, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)`,
    )
      .bind(invitationId, member.projectId, await sha256Hex(code), c.get('user')!.id, expiresAt, body.maxUses, createdAt)
      .run();
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
      'UPDATE invitations SET revoked_at = ?2 WHERE id = ?1 AND project_id = ?3 AND revoked_at IS NULL',
    )
      .bind(invitationId, nowIso(), c.get('member')!.projectId)
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
    if ((claim.meta?.changes ?? 0) === 0) throw invalidState('邀请已失效或已达使用上限');

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
      if (!joined.meta.changes) throw quotaExceeded('项目人数已满或邀请已失效');
    } catch (err) {
      await release();
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE')) throw invalidState('已是项目成员');
      throw err;
    }

    return c.json(apiData(c, { projectId: project.id, projectName: project.name }), 200);
  });
}
