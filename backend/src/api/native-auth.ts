import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope, apiErrorEnvelope } from '../core/openapi';
import { parseCookies, requireUser, SESSION_COOKIE, sessionCookie } from '../core/auth';
import { SESSION_TTL_SECONDS } from '../services/accounts';
import { approveNativeAuth, beginNativeAuth, exchangeNativeAuth, nativeAuthInfo } from '../services/native-auth';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const state = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const errors = { 400: { description: '无效、过期或已使用的请求', content: { 'application/json': { schema: apiErrorEnvelope } } }, 429: { description: '请求频率受限', content: { 'application/json': { schema: apiErrorEnvelope } } } };
const begin = createRoute({ method: 'post', path: '/api/v1/auth/native/transactions', tags: ['auth'], summary: '创建 S256 PKCE 原生授权事务', request: { body: { required: true, content: { 'application/json': { schema: z.object({ codeChallenge: opaque, state, clientType: z.enum(['android', 'windows']).optional() }).strict() } } } }, responses: { ...errors, 201: { description: '授权事务', content: { 'application/json': { schema: apiEnvelope(z.object({ transactionId: z.string().uuid(), authorizationPath: z.string(), expiresAt: z.string() }), 'NativeAuthTransactionResponse') } } } } });
const params = { params: z.object({ transactionId: z.string().uuid() }) };
const info = createRoute({ method: 'get', path: '/api/v1/auth/native/transactions/{transactionId}', tags: ['auth'], summary: '浏览器读取待确认原生授权', request: params, responses: { ...errors, 200: { description: '待确认事务', content: { 'application/json': { schema: apiEnvelope(z.object({ state, expiresAt: z.string(), clientType: z.enum(['android', 'windows']), callbackBase: z.enum(['buwei-native-preview://auth/callback', 'buwei-windows-native://auth/callback']) }), 'NativeAuthInfoResponse') } } } } });
const approve = createRoute({ method: 'post', path: '/api/v1/auth/native/transactions/{transactionId}/approve', tags: ['auth'], summary: '由当前密码会话批准一次性原生登录', request: params, responses: { ...errors, 200: { description: '固定应用回调地址', content: { 'application/json': { schema: apiEnvelope(z.object({ redirectUri: z.string() }), 'NativeAuthApprovalResponse') } } } } });
const exchange = createRoute({ method: 'post', path: '/api/v1/auth/native/exchange', tags: ['auth'], summary: '一次性授权码和 PKCE 换取独立 Cookie 会话', request: { body: { required: true, content: { 'application/json': { schema: z.object({ code: opaque, codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/) }).strict() } } } }, responses: { ...errors, 201: { description: '原生会话（Set-Cookie）', content: { 'application/json': { schema: apiEnvelope(z.object({ user: z.object({ id: z.string().uuid(), username: z.string().nullable(), email: z.string().nullable(), displayName: z.string(), isAdmin: z.boolean(), role: z.enum(['super_admin', 'admin', 'user']) }) }), 'NativeAuthSessionResponse') } } } } });

export function registerNativeAuthRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/auth/native/transactions/:transactionId', requireUser);
  app.use('/api/v1/auth/native/transactions/:transactionId/approve', requireUser);
  app.openapi(begin, async c => c.json(apiData(c, await beginNativeAuth(c.env, c.req.valid('json'), c.req.header('cf-connecting-ip') ?? 'unknown')), 201));
  app.openapi(info, async c => c.json(apiData(c, await nativeAuthInfo(c.env, c.req.valid('param').transactionId)), 200));
  app.openapi(approve, async c => c.json(apiData(c, await approveNativeAuth(c.env, c.req.valid('param').transactionId, parseCookies(c.req.header('cookie'))[SESSION_COOKIE] ?? '', c.get('user')!.id)), 200));
  app.openapi(exchange, async c => {
    const result = await exchangeNativeAuth(c.env, c.req.valid('json'), c.req.header('cf-connecting-ip') ?? 'unknown');
    c.header('Set-Cookie', sessionCookie(result.token, SESSION_TTL_SECONDS));
    return c.json(apiData(c, { user: result.user }), 201);
  });
}

