import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { LIMITS } from '../core/limits';
import { newId, nowIso, sha256Hex } from '../core/db';
import { clearSessionCookie, parseCookies, requireUser, sessionCookie, SESSION_COOKIE } from '../core/auth';
import { echoEmailProvider } from '../email/echo';
import { createResendEmailProvider } from '../email/resend';
import type { EmailProvider } from '../email/provider';
import { createChallenge, verifyAndConsumeChallenge } from '../services/auth-codes';
import { emailUnavailable } from '../core/errors';

const emailSchema = z.string().email().max(254);

const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  displayName: z.string(),
});

const challengeBody = z.object({ email: emailSchema });
const challengeResponse = apiEnvelope(
  z.object({
    challengeId: z.string().uuid(),
    expiresAt: z.string(),
    resendAfterSeconds: z.number().int(),
    /** 仅开发回显模式（非生产环境）返回 */
    devCode: z.string().optional(),
  }),
  'AuthChallengeResponse',
);

const sessionBody = z.object({
  email: emailSchema,
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
});
const sessionResponse = apiEnvelope(z.object({ user: userSchema }), 'AuthSessionResponse');

const sessionGetResponse = apiEnvelope(z.object({ user: userSchema }), 'AuthSessionGetResponse');
const sessionDeleteResponse = apiEnvelope(z.object({ revoked: z.boolean() }), 'AuthSessionDeleteResponse');

const challengeCreateRoute = createRoute({
  method: 'post',
  path: '/api/v1/auth/challenges',
  tags: ['auth'],
  summary: '请求邮箱验证码（60s 间隔；仅本地回显模式返回 devCode）',
  request: { body: { content: { 'application/json': { schema: challengeBody } }, required: true } },
  responses: {
    201: { content: { 'application/json': { schema: challengeResponse } }, description: '挑战已创建并发送' },
    429: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '发送过于频繁' },
  },
});

const authSessionRoute = createRoute({
  method: 'post',
  path: '/api/v1/auth/sessions',
  tags: ['auth'],
  summary: '验证码换取会话（用户不存在则自动注册）',
  request: { body: { content: { 'application/json': { schema: sessionBody } }, required: true } },
  responses: {
    201: { content: { 'application/json': { schema: sessionResponse } }, description: '登录成功（Set-Cookie）' },
    400: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '验证码错误' },
    410: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '验证码过期' },
    429: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '尝试次数过多' },
  },
});

const sessionGetRoute = createRoute({
  method: 'get',
  path: '/api/v1/auth/session',
  tags: ['auth'],
  summary: '读取当前登录用户',
  request: {},
  responses: { 200: { content: { 'application/json': { schema: sessionGetResponse } }, description: '当前用户' } },
});

const sessionDeleteRoute = createRoute({
  method: 'delete',
  path: '/api/v1/auth/session',
  tags: ['auth'],
  summary: '退出登录（立即撤销当前会话）',
  responses: { 200: { content: { 'application/json': { schema: sessionDeleteResponse } }, description: '已撤销' } },
});

export function emailProviderFor(env: AppEnv['Bindings']): EmailProvider {
  if (env.EMAIL_MODE === 'resend') return createResendEmailProvider(env);
  if (env.EMAIL_MODE === 'echo' && env.ENV_NAME === 'local') return echoEmailProvider;
  throw emailUnavailable('当前环境未配置可用的验证码邮件服务');
}

const SESSION_TTL_SECONDS = LIMITS.sessionTtlDays * 86_400;

export function registerAuthRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/auth/session', requireUser);

  app.openapi(challengeCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const ip = c.req.header('cf-connecting-ip') ?? null;
    const result = await createChallenge(c.env, {
      email: body.email,
      ip,
      emailProvider: emailProviderFor(c.env),
    });
    return c.json(apiData(c, result), 201);
  });

  app.openapi(authSessionRoute, async (c) => {
    const body = c.req.valid('json');
    await verifyAndConsumeChallenge(c.env, {
      challengeId: body.challengeId,
      email: body.email,
      code: body.code,
    });

    const now = nowIso();
    let user = await c.env.DB.prepare('SELECT id, email, display_name FROM users WHERE email = ?1')
      .bind(body.email)
      .first<{ id: string; email: string; display_name: string }>();
    if (!user) {
      const userId = newId();
      const displayName = body.email.split('@')[0] ?? '用户';
      await c.env.DB.prepare(
        "INSERT INTO users (id, email, display_name, created_at, last_login_at) VALUES (?1, ?2, ?3, ?4, ?4)",
      )
        .bind(userId, body.email, displayName, now)
        .run();
      user = { id: userId, email: body.email, display_name: displayName };
    } else {
      await c.env.DB.prepare('UPDATE users SET last_login_at = ?2 WHERE id = ?1').bind(user.id, now).run();
    }

    // 32 字节强随机令牌，DB 仅存哈希
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const token = btoa(String.fromCharCode(...tokenBytes)).replaceAll('+', '-').replaceAll('/', '_');
    const sessionId = newId();
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
    await c.env.DB.prepare(
      'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
      .bind(sessionId, user.id, await sha256Hex(token), expiresAt, now)
      .run();

    c.header('Set-Cookie', sessionCookie(token, SESSION_TTL_SECONDS));
    return c.json(
      apiData(c, { user: { id: user.id, email: user.email, displayName: user.display_name } }),
      201,
    );
  });

  app.openapi(sessionGetRoute, async (c) => {
    const user = c.get('user')!;
    return c.json(apiData(c, { user: { id: user.id, email: user.email, displayName: user.displayName } }), 200);
  });

  app.openapi(sessionDeleteRoute, async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const token = cookies[SESSION_COOKIE] ?? '';
    await c.env.DB.prepare('UPDATE sessions SET revoked_at = ?2 WHERE token_hash = ?1 AND revoked_at IS NULL')
      .bind(await sha256Hex(token), nowIso())
      .run();
    c.header('Set-Cookie', clearSessionCookie());
    return c.json(apiData(c, { revoked: true }), 200);
  });
}
