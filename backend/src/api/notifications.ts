import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { parseCookies, requireUser, SESSION_COOKIE } from '../core/auth';
import { newId, nowIso, sha256Hex } from '../core/db';
import { AppError, invalidState, notFound, validationFailed } from '../core/errors';
import { decodeCursor, encodeCursor } from '../core/pagination';
import { consumePasswordRateLimit } from '../services/accounts';
import { notificationVisibleSql, revokeDevice } from '../services/notifications';
import { isPushConfigured, safePushEndpoint, validPushKeys } from '../services/web-push';

const itemSchema = z.object({ id: z.string().uuid(), kind: z.string(), title: z.string(), body: z.string(), url: z.string(), createdAt: z.string(), readAt: z.string().nullable(), dismissedAt: z.string().nullable() });
const settingsSchema = z.object({ inAppEnabled: z.boolean(), pushEnabled: z.boolean() }).strict();
const settingsUpdateSchema = settingsSchema.partial().refine(value => Object.keys(value).length > 0, '至少提供一个设置');
const params = z.object({ id: z.string().uuid() });
const endpointSchema = z.string().min(1).max(2048).refine(safePushEndpoint, '不支持的推送服务地址');
const ok = (schema: z.ZodType, name: string) => ({ content: { 'application/json': { schema: apiEnvelope(schema, name) } }, description: name });
const root = '/api/v1/notifications';
const list = createRoute({ method: 'get', path: root, tags: ['notifications'], request: { query: z.object({ cursor: z.string().max(256).optional(), limit: z.string().regex(/^(?:[1-9]\d?|100)$/).transform(Number).optional() }) }, responses: { 200: ok(z.object({ items: z.array(itemSchema), nextCursor: z.string().nullable(), unreadCount: z.number().int() }), 'NotificationListResponse') } });
const getSettings = createRoute({ method: 'get', path: `${root}/settings`, tags: ['notifications'], responses: { 200: ok(settingsSchema, 'NotificationSettingsResponse') } });
const putSettings = createRoute({ method: 'put', path: `${root}/settings`, tags: ['notifications'], request: { body: { required: true, content: { 'application/json': { schema: settingsUpdateSchema } } } }, responses: { 200: ok(settingsSchema, 'NotificationSettingsResponse') } });
const pushStatus = createRoute({ method: 'get', path: `${root}/push/status`, tags: ['notifications'], responses: { 200: ok(z.object({ configured: z.boolean(), publicKey: z.string() }), 'NotificationPushStatusResponse') } });
const subscribe = createRoute({ method: 'post', path: `${root}/push/subscriptions`, tags: ['notifications'], request: { body: { required: true, content: { 'application/json': { schema: z.object({ endpoint: endpointSchema, keys: z.object({ p256dh: z.string().max(100), auth: z.string().max(30) }).strict() }).strict() } } } }, responses: { 200: ok(z.object({ id: z.string().uuid() }), 'NotificationSubscriptionResponse') } });
const lookup = createRoute({ method: 'post', path: `${root}/push/lookup`, tags: ['notifications'], request: { body: { required: true, content: { 'application/json': { schema: z.object({ endpoint: endpointSchema }).strict() } } } }, responses: { 200: ok(z.object({ id: z.string().uuid().nullable() }), 'NotificationSubscriptionLookupResponse') } });
const unsubscribe = createRoute({ method: 'delete', path: `${root}/push/subscriptions/{id}`, tags: ['notifications'], request: { params }, responses: { 200: ok(z.object({ id: z.string().uuid() }), 'NotificationSubscriptionResponse') } });
const read = createRoute({ method: 'post', path: `${root}/{id}/read`, tags: ['notifications'], request: { params }, responses: { 200: ok(itemSchema, 'NotificationResponse') } });
const dismiss = createRoute({ method: 'post', path: `${root}/{id}/dismiss`, tags: ['notifications'], request: { params }, responses: { 200: ok(itemSchema, 'NotificationResponse') } });
const selected = 'SELECT e.id,e.kind,e.title,e.body,e.url,e.created_at AS createdAt,n.read_at AS readAt,n.dismissed_at AS dismissedAt FROM notification_events e JOIN notification_inbox n ON n.event_id=e.id';
type Item = z.infer<typeof itemSchema>;

export function registerNotificationRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use(`${root}/*`, requireUser, async (c, next) => {
    const expected = c.req.header('X-Notification-Account');
    if (!['GET','HEAD','OPTIONS'].includes(c.req.method) && expected && expected !== c.get('user')!.id) throw invalidState('登录账户已变化，请在当前账户重新操作');
    await next();
  });
  app.openapi(list, async c => {
    const query = c.req.valid('query'); const cursor = decodeCursor(query.cursor); const limit = query.limit ?? 50;
    if (query.cursor && (!cursor || !z.string().uuid().safeParse(cursor.id).success || !z.string().datetime().safeParse(cursor.createdAt).success)) throw validationFailed('分页游标无效');
    const userId = c.get('user')!.id;
    const [rows, total] = await Promise.all([
      c.env.DB.prepare(`${selected} WHERE n.user_id=?1 AND ${notificationVisibleSql('?1')}
        AND (?2 IS NULL OR e.created_at<?2 OR (e.created_at=?2 AND e.id<?3)) ORDER BY e.created_at DESC,e.id DESC LIMIT ?4`)
        .bind(userId,cursor?.createdAt??null,cursor?.id??null,limit+1).all<Item>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM notification_events e JOIN notification_inbox n ON n.event_id=e.id WHERE n.user_id=?1 AND n.read_at IS NULL AND n.dismissed_at IS NULL AND ${notificationVisibleSql('?1')}`).bind(userId).first<{ n: number }>(),
    ]);
    const items = rows.results.slice(0,limit); const last = items.at(-1);
    return c.json(apiData(c,{items,nextCursor:rows.results.length>limit&&last?encodeCursor({id:last.id,createdAt:last.createdAt}):null,unreadCount:total?.n??0}),200);
  });
  app.openapi(getSettings, async c => {
    const row = await c.env.DB.prepare('SELECT in_app_enabled,push_enabled FROM notification_settings WHERE user_id=?1').bind(c.get('user')!.id).first<{ in_app_enabled:number;push_enabled:number }>();
    return c.json(apiData(c,{inAppEnabled:row?.in_app_enabled!==0,pushEnabled:row?.push_enabled!==0}),200);
  });
  app.openapi(putSettings, async c => {
    const input=c.req.valid('json'); const id=c.get('user')!.id; const now=nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO notification_settings(user_id,in_app_enabled,push_enabled,updated_at) VALUES(?1,COALESCE(?2,1),COALESCE(?3,1),?4)
        ON CONFLICT(user_id) DO UPDATE SET in_app_enabled=COALESCE(?2,notification_settings.in_app_enabled),push_enabled=COALESCE(?3,notification_settings.push_enabled),updated_at=excluded.updated_at`).bind(id,input.inAppEnabled===undefined?null:input.inAppEnabled?1:0,input.pushEnabled===undefined?null:input.pushEnabled?1:0,now),
      c.env.DB.prepare("UPDATE notification_push_outbox SET status='cancelled',lease_until=NULL,updated_at=?2 WHERE status IN ('pending','sending') AND ?3=0 AND subscription_id IN (SELECT id FROM push_subscriptions WHERE user_id=?1)").bind(id,now,input.pushEnabled===false?0:1),
    ]);
    const saved = await c.env.DB.prepare('SELECT in_app_enabled,push_enabled FROM notification_settings WHERE user_id=?1').bind(id).first<{in_app_enabled:number;push_enabled:number}>();
    return c.json(apiData(c,{inAppEnabled:saved?.in_app_enabled!==0,pushEnabled:saved?.push_enabled!==0}),200);
  });
  app.openapi(pushStatus, c => { const configured=isPushConfigured(c.env); return c.json(apiData(c,{configured,publicKey:configured?c.env.VAPID_PUBLIC_KEY!:''}),200); });
  app.openapi(subscribe, async c => {
    if (!isPushConfigured(c.env)) throw new AppError('INVALID_STATE','系统推送尚未配置，站内通知仍可使用',503,false);
    const user=c.get('user')!; const input=c.req.valid('json');
    await consumePasswordRateLimit(c.env,'push-subscribe-user',user.id,120,3600);
    if (!await validPushKeys(input.keys.p256dh,input.keys.auth)) throw validationFailed('推送订阅密钥无效');
    const existing=await c.env.DB.prepare('SELECT id,user_id FROM push_subscriptions WHERE endpoint=?1').bind(input.endpoint).first<{id:string;user_id:string}>();
    if (existing&&existing.user_id!==user.id) throw invalidState('该设备订阅已绑定其他账户，请先在浏览器取消订阅后重试');
    const count=await c.env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?1 AND disabled_at IS NULL').bind(user.id).first<{n:number}>();
    if (!existing&&(count?.n??0)>=20) throw invalidState('已达到设备订阅数量上限');
    const id=existing?.id??newId(); const now=nowIso(); const token=parseCookies(c.req.header('cookie'))[SESSION_COOKIE]??'';
    await c.env.DB.prepare(`INSERT INTO push_subscriptions(id,user_id,session_hash,endpoint,p256dh,auth,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)
      ON CONFLICT(endpoint) DO UPDATE SET session_hash=excluded.session_hash,p256dh=excluded.p256dh,auth=excluded.auth,disabled_at=NULL,disabled_reason=NULL,updated_at=excluded.updated_at WHERE push_subscriptions.user_id=excluded.user_id`)
      .bind(id,user.id,await sha256Hex(token),input.endpoint,input.keys.p256dh,input.keys.auth,now).run();
    const owned=await c.env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint=?1 AND user_id=?2').bind(input.endpoint,user.id).first<{id:string}>();
    if (!owned) throw invalidState('该设备订阅已绑定其他账户');
    return c.json(apiData(c,{id:owned.id}),200);
  });
  app.openapi(lookup,async c=>{const row=await c.env.DB.prepare('SELECT id FROM push_subscriptions WHERE user_id=?1 AND endpoint=?2 AND disabled_at IS NULL').bind(c.get('user')!.id,c.req.valid('json').endpoint).first<{id:string}>();return c.json(apiData(c,{id:row?.id??null}),200);});
  app.openapi(unsubscribe,async c=>{const id=c.req.valid('param').id;const userId=c.get('user')!.id;
    const owned=await c.env.DB.prepare('SELECT id FROM push_subscriptions WHERE id=?1 AND user_id=?2').bind(id,userId).first();if(!owned)throw notFound('订阅不存在');
    await revokeDevice(c.env,userId,id);return c.json(apiData(c,{id}),200);
  });
  for (const route of [read,dismiss]) app.openapi(route,async c=>{
    const id=c.req.valid('param').id;const userId=c.get('user')!.id;const column=route===read?'read_at':'dismissed_at';
    await c.env.DB.prepare(`UPDATE notification_inbox SET ${column}=COALESCE(${column},?3) WHERE event_id=?1 AND user_id=?2
      AND EXISTS(SELECT 1 FROM notification_events e WHERE e.id=?1 AND ${notificationVisibleSql('?2')})`).bind(id,userId,nowIso()).run();
    const row=await c.env.DB.prepare(`${selected} WHERE e.id=?1 AND n.user_id=?2 AND ${notificationVisibleSql('?2')}`).bind(id,userId).first<Item>();
    if(!row)throw notFound('通知不存在');return c.json(apiData(c,row),200);
  });
}
