import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireUser, requireProjectMember } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { nowIso } from '../core/db';
import { invalidState, notFound } from '../core/errors';
import { projectParams } from './projects';
import { withIdempotency } from '../services/idempotency';
import { expireUsernameInvites, sendUsernameInvite, handleUsernameInvite } from '../services/username-invitations';
const invitationSchema = z.object({
  id: z.string().uuid(), projectId: z.string().uuid(), projectName: z.string(), inviterName: z.string(), username: z.string(), role: z.literal('member'), status: z.enum(['pending', 'accepted', 'declined', 'revoked', 'expired']), expiresAt: z.string(), createdAt: z.string()
});
const listResponse = apiEnvelope(z.object({
  items: z.array(invitationSchema), nextOffset: z.number().nullable()
}), 'UsernameInvitationListResponse');
const actionResponse = apiEnvelope(z.object({
  id: z.string().uuid(), status: z.string(), projectId: z.string().uuid()
}), 'UsernameInvitationActionResponse');
const json = (schema: z.ZodType) => ({
  content: {
    'application/json': {
      schema
    }
  }, required: true
});
const query = z.object({
  offset: z.string().regex(/^\d+$/).optional()
});
export function registerUsernameInvitationRoutes(app: OpenAPIHono<AppEnv>) {
  const inbox = '/api/v1/invitations/inbox', outbox = '/api/v1/projects/{projectId}/username-invitations';
  app.use(inbox, requireUser);
  app.use(inbox + '/*', requireUser);
  app.use('/api/v1/projects/:projectId/username-invitations', requireUser, requireProjectMember({
    owner: true
  }));
  app.use('/api/v1/projects/:projectId/username-invitations/*', requireUser, requireProjectMember({
    owner: true
  }));
  for (const kind of ['inbox', 'outbox'] as const)
    app.openapi(createRoute({
      method: 'get', path: kind === 'inbox' ? inbox : outbox, tags: ['invitations'], request: {
        ...(kind === 'outbox' ? {
          params: projectParams
        } : {}), query
      }, responses: {
        200: {
          description: '邀请元数据，最多20项；接受前不返回项目说明或文件', content: {
            'application/json': {
              schema: listResponse
            }
          }
        }
      }
    }), async (c) => {
      await expireUsernameInvites(c.env);
      const offset = Math.min(10000, Number(c.req.valid('query').offset ?? 0));
      const rows = await c.env.DB.prepare(`SELECT i.*,p.name project_name,u.display_name inviter_name FROM project_username_invitations i JOIN projects p ON p.id=i.project_id JOIN users u ON u.id=i.invited_by WHERE ${kind === 'inbox' ? 'i.recipient_id=?1' : 'i.project_id=?1'} ORDER BY i.created_at DESC,i.id DESC LIMIT 21 OFFSET ?2`).bind(kind === 'inbox' ? c.get('user')!.id : c.get('member')!.projectId, offset).all<any>();
      return c.json(apiData(c, {
        items: rows.results.slice(0, 20).map(r => ({
          id: r.id, projectId: r.project_id, projectName: r.project_name, inviterName: r.inviter_name, username: r.username, role: 'member' as const, status: r.status, expiresAt: r.expires_at, createdAt: r.created_at
        })), nextOffset: rows.results.length > 20 ? offset + 20 : null
      }), 200);
    });
  app.openapi(createRoute({
    method: 'post', path: outbox, tags: ['invitations'], request: {
      params: projectParams, body: json(z.object({
        username: z.string().trim().min(1).max(64), expiresInDays: z.number().int().min(1).max(30).default(7)
      }).strict())
    }, responses: {
      201: {
        description: '已向真实用户名发出邀请', content: {
          'application/json': {
            schema: apiEnvelope(z.object({
              id: z.string().uuid()
            }), 'UsernameInvitationCreateResponse')
          }
        }
      }
    }
  }), async (c) => {
    const b = c.req.valid('json') as {
      username: string;
      expiresInDays: number;
    }, u = c.get('user')!.id, p = c.get('member')!.projectId;
    const result = await withIdempotency(c.env, {
      key: c.req.header('idempotency-key'), userId: u, operation: 'username-invitation.send', rawBody: JSON.stringify({
        projectId: p, ...b
      })
    }, async () => ({
      status: 201 as const, body: {
        id: await sendUsernameInvite(c.env, p, u, b.username, b.expiresInDays)
      }
    }));
    return c.json(apiData(c, result.body), 201);
  });
  app.openapi(createRoute({
    method: 'post', path: inbox + '/{invitationId}', tags: ['invitations'], request: {
      params: z.object({
        invitationId: z.string().uuid()
      }), body: json(z.object({
        action: z.enum(['accept', 'decline'])
      }).strict())
    }, responses: {
      200: {
        description: '本人处理邀请；先到先成功，原子人数校验', content: {
          'application/json': {
            schema: actionResponse
          }
        }
      }
    }
  }), async (c) => {
    const b = c.req.valid('json') as {
      action: 'accept' | 'decline';
    };
    return c.json(apiData(c, await handleUsernameInvite(c.env, c.req.valid('param').invitationId, c.get('user')!.id, b.action)), 200);
  });
  app.openapi(createRoute({
    method: 'post', path: outbox + '/{invitationId}/revoke', tags: ['invitations'], request: {
      params: projectParams.extend({
        invitationId: z.string().uuid()
      })
    }, responses: {
      200: {
        description: '负责人撤销邀请，可重复确认', content: {
          'application/json': {
            schema: actionResponse
          }
        }
      }
    }
  }), async (c) => {
    const p = c.get('member')!.projectId, id = c.req.valid('param').invitationId;
    const current = await c.env.DB.prepare('SELECT status FROM project_username_invitations WHERE id=?1 AND project_id=?2').bind(id, p).first<{
      status: string;
    }>();
    if (!current) {
      throw notFound('邀请不存在');
    }
    if (current.status === 'revoked') {
      return c.json(apiData(c, {
        id, status: 'revoked', projectId: p
      }), 200);
    }
    if (current.status !== 'pending') {
      throw invalidState('只能撤销待处理邀请');
    }
    const changed = await c.env.DB.prepare("UPDATE project_username_invitations SET status='revoked',handled_at=?3 WHERE id=?1 AND project_id=?2 AND status='pending'").bind(id, p, nowIso()).run();
    if (!changed.meta.changes) {
      throw invalidState('邀请状态已变化');
    }
    return c.json(apiData(c, {
      id, status: 'revoked', projectId: p
    }), 200);
  });
}
