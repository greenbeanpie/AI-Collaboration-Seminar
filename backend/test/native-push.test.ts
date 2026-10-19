import { afterEach, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedUser, type SeededUser } from './helpers/seed';
import { createApp } from '../src/app';
import { registerNativePushRoutes } from '../src/api/native-push';
import { isNativePushConfigured, registerNativeDevice, revokeNativeSession, sendNativePush, type NativePushConfig } from '../src/services/native-push';
import { newId, nowIso, sha256Hex } from '../src/core/db';

const app = createApp();
registerNativePushRoutes(app);
const configured = { ...env, FCM_PROJECT_ID: 'test-project', FCM_CLIENT_EMAIL: 'test@example.test', FCM_PRIVATE_KEY: 'test-only-not-a-real-key' };
const token = 'test-registration-token-abcdefghijklmnopqrstuvwxyz';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function request(user: SeededUser | undefined, path: string, method: string, body?: unknown, bindings = configured) {
  return app.request(`${BASE}/api/v1/notifications/native-devices${path}`, { method,
    headers: { ...(user ? { cookie: authCookie(user.token) } : {}), 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, bindings);
}

it('requires session and valid Android registration; disabled config makes no network calls', async () => {
  const user = await seedUser();
  expect((await request(undefined, '', 'POST', { installationId: newId(), platform: 'android', token })).status).toBe(401);
  expect((await request(user, '', 'POST', { installationId: newId(), platform: 'ios', token })).status).toBe(400);
  expect((await request(user, '', 'POST', { installationId: newId(), platform: 'android', token, userId: newId() })).status).toBe(400);
  expect((await request(user, '', 'POST', { installationId: newId(), platform: 'android', token }, { ...configured, FCM_PRIVATE_KEY: '' })).status).toBe(503);
  const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  expect(isNativePushConfigured(env)).toBe(false);
  expect(await sendNativePush(env, { native_token: token, user_id: user.userId }, newId())).toEqual({ status: 503 });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('registration is idempotent; token rotation and session binding cancel stale deliveries', async () => {
  const user = await seedUser(); const installationId = newId(); const sessionHash = await sha256Hex(user.token);
  const id = await registerNativeDevice(configured, user.userId, sessionHash, installationId, token);
  const eventId = newId(); const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO notification_events(id,event_key,kind,scope,resource_id,title,body,url,created_at) VALUES(?1,?1,'source_added','project',?1,'title','body','/app',?2)").bind(eventId, now),
    env.DB.prepare('INSERT INTO notification_push_outbox(event_id,subscription_id,available_at,created_at,updated_at) VALUES(?1,?2,?3,?3,?3)').bind(eventId, id, now),
  ]);
  expect(await registerNativeDevice(configured, user.userId, sessionHash, installationId, token)).toBe(id);
  expect(await env.DB.prepare('SELECT status FROM notification_push_outbox WHERE event_id=?1').bind(eventId).first('status')).toBe('pending');
  expect(await registerNativeDevice(configured, user.userId, sessionHash, installationId, `${token}-rotated`)).toBe(id);
  expect(await env.DB.prepare('SELECT status FROM notification_push_outbox WHERE event_id=?1').bind(eventId).first('status')).toBe('cancelled');
  const row = await env.DB.prepare('SELECT native_token,session_hash FROM push_subscriptions WHERE id=?1').bind(id).first<{ native_token: string; session_hash: string }>();
  expect(row).toEqual({ native_token: `${token}-rotated`, session_hash: sessionHash });
});

it('account switch with same token disables old account and cannot inherit its event deliveries', async () => {
  const oldUser = await seedUser(); const newUser = await seedUser(); const installation = newId();
  const oldId = await registerNativeDevice(configured, oldUser.userId, await sha256Hex(oldUser.token), installation, token);
  const newIdValue = await registerNativeDevice(configured, newUser.userId, await sha256Hex(newUser.token), installation, token);
  expect(oldId).not.toBe(newIdValue);
  expect(await env.DB.prepare('SELECT disabled_reason FROM push_subscriptions WHERE id=?1').bind(oldId).first('disabled_reason')).toBe('rebound');
  expect(await env.DB.prepare('SELECT disabled_at FROM push_subscriptions WHERE id=?1').bind(newIdValue).first('disabled_at')).toBeNull();
  expect((await request(oldUser, `/${installation}`, 'DELETE')).status).toBe(200);
  expect(await env.DB.prepare('SELECT disabled_at FROM push_subscriptions WHERE id=?1').bind(newIdValue).first('disabled_at')).toBeNull();
});

it('logout and deletion affect only current account/session, preserving another native session', async () => {
  const user = await seedUser(); const other = await seedUser(); const installA = newId(); const installB = newId(); const hash = await sha256Hex(user.token);
  const a = await registerNativeDevice(configured, user.userId, hash, installA, `${token}-A`);
  const b = await registerNativeDevice(configured, user.userId, await sha256Hex('other-session'), installB, `${token}-B`);
  expect((await request(other, `/${installA}`, 'DELETE')).status).toBe(404);
  expect((await request(user, `/${installB}`, 'DELETE')).status).toBe(404);
  await revokeNativeSession(env, user.userId, hash);
  expect(await env.DB.prepare('SELECT disabled_reason FROM push_subscriptions WHERE id=?1').bind(a).first('disabled_reason')).toBe('logout');
  expect(await env.DB.prepare('SELECT disabled_at FROM push_subscriptions WHERE id=?1').bind(b).first('disabled_at')).toBeNull();
});

async function keyConfig(): Promise<NativePushConfig & typeof env> {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey) as ArrayBuffer);
  return { ...configured, FCM_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----` };
}

it('uses signed OAuth and HTTP v1 data-only payload with no private notification text', async () => {
  const config = await keyConfig(); const requests: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(url.includes('oauth2') ? { access_token: 'mock-access', expires_in: 3600 } : { name: 'projects/test/messages/1' }), { status: 200 });
  }));
  const eventId = newId(); const userId = newId();
  expect(await sendNativePush(config, { native_token: token, user_id: userId }, eventId)).toEqual({ status: 200 });
  expect(requests).toHaveLength(2);
  const assertion = new URLSearchParams(requests[0]!.init?.body as string).get('assertion')!;
  expect(assertion.split('.')).toHaveLength(3);
  expect(requests[1]!.url).toBe('https://fcm.googleapis.com/v1/projects/test-project/messages:send');
  expect(requests[1]!.init?.headers).toMatchObject({ authorization: 'Bearer mock-access' });
  const payload = JSON.parse(requests[1]!.init?.body as string);
  expect(payload.message.data).toEqual({ eventId, userId });
  expect(payload.message.notification).toBeUndefined();
  expect(payload.message.android.ttl).toBe('60s');
});

it('only UNREGISTERED expires a token; missing project and transient failures retain tokens', async () => {
  const config = await keyConfig(); let details: unknown[] = []; let sendStatus = 404;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('oauth2')
    ? new Response(JSON.stringify({ access_token: 'mock-error-access', expires_in: 3600 }))
    : new Response(JSON.stringify({ error: { details } }), { status: sendStatus })));
  expect((await sendNativePush(config, { native_token: token, user_id: newId() }, newId())).status).toBe(400);
  details = [{ errorCode: 'UNREGISTERED' }];
  expect((await sendNativePush(config, { native_token: token, user_id: newId() }, newId())).status).toBe(410);
  details = []; sendStatus = 503;
  expect((await sendNativePush(config, { native_token: token, user_id: newId() }, newId())).status).toBe(503);
});
