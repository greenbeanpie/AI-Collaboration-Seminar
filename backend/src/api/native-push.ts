import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { parseCookies, requireUser, SESSION_COOKIE } from '../core/auth';
import { sha256Hex } from '../core/db';
import { AppError, invalidState, notFound } from '../core/errors';
import { consumePasswordRateLimit } from '../services/accounts';
import { revokeDevice } from '../services/notifications';
import { isNativePushConfigured, registerNativeDevice } from '../services/native-push';

const root = '/api/v1/notifications/native-devices';
const installation = z.string().uuid();
const output = { content: { 'application/json': { schema: apiEnvelope(z.object({ id: z.string().uuid() }), 'NativePushDeviceResponse') } }, description: '原生推送设备' };
const register = createRoute({ method: 'post', path: root, tags: ['notifications'], request: { body: { required: true, content: { 'application/json': { schema: z.object({
  installationId: installation, platform: z.literal('android'), token: z.string().min(20).max(4096).regex(/^[A-Za-z0-9:_-]+$/),
}).strict() } } } }, responses: { 200: output } });
const remove = createRoute({ method: 'delete', path: `${root}/{installationId}`, tags: ['notifications'], request: { params: z.object({ installationId: installation }) }, responses: { 200: output } });

export function registerNativePushRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use(root, requireUser);
  app.use(`${root}/*`, requireUser);
  app.openapi(register, async c => {
    if (!isNativePushConfigured(c.env)) throw new AppError('INVALID_STATE', '即时推送尚未配置，站内通知仍可使用', 503, false);
    const userId = c.get('user')!.id;
    const expected = c.req.header('X-Notification-Account');
    if (expected && expected !== userId) throw invalidState('登录账户已变化');
    await consumePasswordRateLimit(c.env, 'native-push-register', userId, 120, 3600);
    const input = c.req.valid('json');
    const sessionHash = await sha256Hex(parseCookies(c.req.header('cookie'))[SESSION_COOKIE]!);
    const id = await registerNativeDevice(c.env, userId, sessionHash, input.installationId, input.token);
    return c.json(apiData(c, { id }), 200);
  });
  app.openapi(remove, async c => {
    const userId = c.get('user')!.id;
    const sessionHash = await sha256Hex(parseCookies(c.req.header('cookie'))[SESSION_COOKIE]!);
    const owned = await c.env.DB.prepare("SELECT id FROM push_subscriptions WHERE transport='fcm' AND installation_id=?1 AND user_id=?2 AND session_hash=?3")
      .bind(c.req.valid('param').installationId, userId, sessionHash).first<{ id: string }>();
    if (!owned) throw notFound('设备不存在');
    await revokeDevice(c.env, userId, owned.id, sessionHash);
    return c.json(apiData(c, { id: owned.id }), 200);
  });
}
