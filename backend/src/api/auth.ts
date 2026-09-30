import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { nowIso, sha256Hex } from '../core/db';
import { clearSessionCookie, parseCookies, requireUser, sessionCookie, SESSION_COOKIE } from '../core/auth';
import { AppError } from '../core/errors';
import { loginPasswordAccount, registerPasswordAccount, SESSION_TTL_SECONDS } from '../services/accounts';
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../services/password';

const userSchema = z.object({ id: z.string().uuid(), username: z.string().nullable(), email: z.string().nullable(), displayName: z.string(), isAdmin: z.boolean(), role: z.enum(['super_admin', 'admin', 'user']) });
const sessionResponse = apiEnvelope(z.object({ user: userSchema }), 'AuthSessionResponse');
const sessionGetResponse = apiEnvelope(z.object({ user: userSchema }), 'AuthSessionGetResponse');
const sessionDeleteResponse = apiEnvelope(z.object({ revoked: z.boolean() }), 'AuthSessionDeleteResponse');
const loginBody = z.object({ account: z.string().trim().min(1).max(254), password: z.string().min(1).max(PASSWORD_MAX_LENGTH) });
const registerBody = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  invitationCode: z.string().trim().regex(/^[A-Za-z0-9]{16}$/),
  email: z.string().email().max(254).nullable().optional(),
});
const challengeRoute = createRoute({ method: 'post', path: '/api/v1/auth/challenges', tags: ['auth'], deprecated: true,
  summary: '验证码认证已停用，使用账号密码登录', responses: { 410: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '验证码认证永久停用' } } });
const loginRoute = createRoute({ method: 'post', path: '/api/v1/auth/sessions', tags: ['auth'], summary: '用户名或联系邮箱与密码换取会话',
  request: { body: { content: { 'application/json': { schema: loginBody } }, required: true } },
  responses: { 201: { content: { 'application/json': { schema: sessionResponse } }, description: '密码登录成功（Set-Cookie）' }, 401: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '账号或密码错误' }, 429: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '认证频率已达限制' } } });
const registerRoute = createRoute({ method: 'post', path: '/api/v1/auth/register', tags: ['auth'], summary: '凭一次性注册码创建用户名密码账号（邮箱可空且不视为已验证）',
  request: { body: { content: { 'application/json': { schema: registerBody } }, required: true } },
  responses: { 201: { content: { 'application/json': { schema: sessionResponse } }, description: '注册并登录' }, 400: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '参数或邀请码无效' }, 409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '用户名或邮箱已占用，邀请码未消耗' }, 429: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '注册频率已达限制' } } });
const getRoute = createRoute({ method: 'get', path: '/api/v1/auth/session', tags: ['auth'], summary: '读取当前密码登录用户', responses: { 200: { content: { 'application/json': { schema: sessionGetResponse } }, description: '当前用户' } } });
const deleteRoute = createRoute({ method: 'delete', path: '/api/v1/auth/session', tags: ['auth'], summary: '立即撤销当前会话', responses: { 200: { content: { 'application/json': { schema: sessionDeleteResponse } }, description: '已撤销' } } });

export function registerAuthRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/auth/session', requireUser);
  app.openapi(challengeRoute, () => { throw new AppError('INVALID_STATE', '验证码登录已停用，请使用账号和密码', 410, false); });
  app.openapi(loginRoute, async c => {
    const result = await loginPasswordAccount(c.env, c.req.valid('json'), c.req.header('cf-connecting-ip') ?? 'unknown');
    c.header('Set-Cookie', sessionCookie(result.token, SESSION_TTL_SECONDS));
    return c.json(apiData(c, { user: result.user }), 201);
  });
  app.openapi(registerRoute, async c => {
    const result = await registerPasswordAccount(c.env, c.req.valid('json'), c.req.header('cf-connecting-ip') ?? 'unknown');
    c.header('Set-Cookie', sessionCookie(result.token, SESSION_TTL_SECONDS));
    return c.json(apiData(c, { user: result.user }), 201);
  });
  app.openapi(getRoute, c => c.json(apiData(c, { user: c.get('user')! }), 200));
  app.openapi(deleteRoute, async c => {
    const token = parseCookies(c.req.header('cookie'))[SESSION_COOKIE] ?? '';
    await c.env.DB.prepare('UPDATE sessions SET revoked_at = ?2 WHERE token_hash = ?1 AND revoked_at IS NULL').bind(await sha256Hex(token), nowIso()).run();
    c.header('Set-Cookie', clearSessionCookie());
    return c.json(apiData(c, { revoked: true }), 200);
  });
}
