import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { clearSessionCookie, requireUser } from '../core/auth';
import { permissionDenied } from '../core/errors';
import { issuePasswordRecovery, redeemPasswordRecovery } from '../services/password-recovery';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../services/password';

const issue = createRoute({ method: 'post', path: '/api/v1/admin/accounts/{userId}/password-recovery', tags: ['admin'],
  request: { params: z.object({ userId: z.string().uuid() }), body: { required: true, content: { 'application/json': { schema: z.object({ reason: z.string().trim().min(10).max(1000), ownershipVerified: z.literal(true) }).strict() } } } },
  responses: { 201: { content: { 'application/json': { schema: apiEnvelope(z.object({ id: z.string(), token: z.string(), expiresAt: z.string() }), 'PasswordRecoveryIssueResponse') } }, description: '仅此一次返回恢复代码；由超级管理员人工交付' } } });
const redeem = createRoute({ method: 'post', path: '/api/v1/auth/password-recovery/redeem', tags: ['auth'],
  request: { body: { required: true, content: { 'application/json': { schema: z.object({ token: z.string().max(200), newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH) }).strict() } } } },
  responses: { 200: { content: { 'application/json': { schema: apiEnvelope(z.object({ revoked: z.literal(true) }), 'PasswordRecoveryRedeemResponse') } }, description: '恢复密码并撤销全部旧会话，请重新登录' } } });

export function registerPasswordRecoveryRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/admin/accounts/:userId/password-recovery', requireUser, async (c, next) => {
    if (c.get('user')?.role !== 'super_admin' || c.req.header('X-Password-Recovery') !== '1') throw permissionDenied('需要超级管理员账户核实恢复请求');
    await next();
  });
  app.openapi(issue, async c => c.json(apiData(c, await issuePasswordRecovery(c.env, c.get('user')!, c.req.valid('param').userId, c.req.valid('json').reason)), 201));
  app.openapi(redeem, async c => {
    const { token, newPassword } = c.req.valid('json');
    await redeemPasswordRecovery(c.env, token, newPassword, c.req.header('cf-connecting-ip') ?? 'unknown');
    c.header('Set-Cookie', clearSessionCookie());
    return c.json(apiData(c, { revoked: true as const }), 200);
  });
}
