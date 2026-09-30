import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { nowIso } from '../core/db';
import { clearSessionCookie, requireUser } from '../core/auth';
import { permissionDenied, validationFailed, invalidState } from '../core/errors';
import { consumePasswordRateLimit } from '../services/accounts';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../services/password';
const userSchema = z.object({ id: z.string().uuid(), username: z.string().nullable(), email: z.string().nullable(), displayName: z.string(), isAdmin: z.boolean() });
const profile = createRoute({ method: 'patch', path: '/api/v1/auth/profile', tags: ['auth'],
  request: { body: { content: { 'application/json': { schema: z.object({ displayName: z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f\u007f]+$/) }).strict() } }, required: true } },
  responses: { 200: { content: { 'application/json': { schema: apiEnvelope(z.object({ user: userSchema }), 'AccountProfileResponse') } }, description: 'Updated display name' } } });
const password = createRoute({ method: 'post', path: '/api/v1/auth/password', tags: ['auth'],
  request: { body: { content: { 'application/json': { schema: z.object({ currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH), newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH) }).strict() } }, required: true } },
  responses: { 200: { content: { 'application/json': { schema: apiEnvelope(z.object({ revoked: z.boolean() }), 'AccountPasswordResponse') } }, description: 'All sessions revoked; sign in again' } } });
export function registerAccountSettingsRoutes(app: OpenAPIHono<AppEnv>): void {
  for (const path of ['/api/v1/auth/profile', '/api/v1/auth/password']) {
    app.use(path, requireUser);
    // HTML forms cannot supply this header. Origin checks run globally before this guard.
    app.use(path, async (c, next) => {
      if (c.req.header('X-Account-Settings') !== '1') throw permissionDenied('账户设置请求验证失败');
      await next();
    });
  }
  app.openapi(profile, async c => {
    const user = c.get('user')!;
    await consumePasswordRateLimit(c.env, 'profile-user', user.id, 30, 3600);
    const { displayName } = c.req.valid('json');
    await c.env.DB.prepare('UPDATE users SET display_name = ?2 WHERE id = ?1').bind(user.id, displayName).run();
    return c.json(apiData(c, { user: { ...user, displayName } }), 200);
  });
  app.openapi(password, async c => {
    const user = c.get('user')!;
    await consumePasswordRateLimit(c.env, 'change-password-user', user.id, 5, 900);
    await consumePasswordRateLimit(c.env, 'change-password-ip', c.req.header('cf-connecting-ip') ?? 'unknown', 30, 3600);
    const { currentPassword, newPassword } = c.req.valid('json');
    const account = await c.env.DB.prepare('SELECT password_hash FROM auth_accounts WHERE user_id = ?1').bind(user.id).first<{ password_hash: string | null }>();
    if (!await verifyPassword(currentPassword, account?.password_hash ?? DUMMY_PASSWORD_HASH) || !account?.password_hash) throw validationFailed('原密码不正确');
    if (currentPassword === newPassword) throw validationFailed('新密码不能与原密码相同');
    const hash = await hashPassword(newPassword);
    const results = await c.env.DB.batch([
      c.env.DB.prepare('UPDATE auth_accounts SET password_hash = ?2 WHERE user_id = ?1 AND password_hash = ?3').bind(user.id, hash, account.password_hash),
      c.env.DB.prepare('UPDATE sessions SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM auth_accounts WHERE user_id = ?1 AND password_hash = ?3)').bind(user.id, nowIso(), hash),
    ]);
    if (results[0]?.meta.changes !== 1) throw invalidState('密码已更改，请重新登录');
    c.header('Set-Cookie', clearSessionCookie());
    return c.json(apiData(c, { revoked: true }), 200);
  });
}
