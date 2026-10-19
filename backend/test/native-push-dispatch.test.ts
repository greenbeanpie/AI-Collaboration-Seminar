import { afterEach, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedProject, seedUser, type SeededUser } from './helpers/seed';
import type { Env } from '../src/env';
import { createApp } from '../src/app';
import { newId, nowIso, sha256Hex } from '../src/core/db';
import { dispatchNotifications } from '../src/services/notifications';
import * as nativePush from '../src/services/native-push';
import * as webPush from '../src/services/web-push';

const app = createApp();
const nativeEnv: Env = { ...env, FCM_PROJECT_ID: 'test-native-project', FCM_CLIENT_EMAIL: 'test@example.test', FCM_PRIVATE_KEY: 'test-only-never-used', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '' };
// Public RFC 8291 fixture, not production credentials.
const webEnv: Env = { ...env, FCM_PROJECT_ID: '', FCM_CLIENT_EMAIL: '', FCM_PRIVATE_KEY: '', VAPID_PUBLIC_KEY: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', VAPID_PRIVATE_KEY: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', VAPID_SUBJECT: 'https://example.test' };
const bothEnv = { ...nativeEnv, VAPID_PUBLIC_KEY: webEnv.VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: webEnv.VAPID_PRIVATE_KEY, VAPID_SUBJECT: webEnv.VAPID_SUBJECT };
afterEach(() => { vi.restoreAllMocks(); });

async function call(user: SeededUser, path: string, method: string, body?: unknown, bindings: Env = nativeEnv) {
  return app.request(`${BASE}/api/v1${path}`, { method, headers: { cookie: authCookie(user.token), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, bindings);
}
async function payload<T>(response: Response): Promise<T> {
  expect(response.status).toBeLessThan(300);
  return (await response.json() as { data: T }).data;
}
async function register(user: SeededUser, installationId = newId()) {
  return payload<{ id: string }>(await call(user, '/notifications/native-devices', 'POST', { platform: 'android', installationId, token: `test-native-device-${newId()}` }));
}
async function source(user: SeededUser, project: string, bindings = nativeEnv): Promise<string> {
  const result = await payload<{ sourceId: string }>(await call(user, `/projects/${project}/sources`, 'POST', { kind: 'paste', title: 'PRIVATE SOURCE TITLE', text: 'PRIVATE SOURCE CONTENT' }, bindings));
  const event = await env.DB.prepare('SELECT id FROM notification_events WHERE event_key=?1').bind(`source_added:${result.sourceId}`).first<{ id: string }>();
  expect(event).not.toBeNull();
  return event!.id;
}
async function state(eventId: string, subscriptionId: string) {
  return env.DB.prepare('SELECT status,attempts FROM notification_push_outbox WHERE event_id=?1 AND subscription_id=?2').bind(eventId, subscriptionId).first<{ status: string; attempts: number }>();
}
async function seedTransportDevice(user: SeededUser, transport: 'webpush' | 'fcm') {
  const id = newId(); const now = nowIso();
  await env.DB.prepare(`INSERT INTO push_subscriptions(id,user_id,session_hash,endpoint,p256dh,auth,created_at,updated_at,transport,installation_id,native_token)
    VALUES(?1,?2,?3,?4,'fixture','fixture',?5,?5,?6,?7,?8)`)
    .bind(id, user.userId, await sha256Hex(user.token), `https://fcm.googleapis.com/send/test-${id}`, now, transport, transport === 'fcm' ? newId() : null, transport === 'fcm' ? `fixture-${id}` : null).run();
  return id;
}

it('registered native device receives transactional fanout and one dispatch when VAPID is absent', async () => {
  const user = await seedUser(); const project = await seedProject(user.userId); const device = await register(user);
  const webId = await seedTransportDevice(user, 'webpush');
  const eventId = await source(user, project);
  expect(await state(eventId, device.id)).toEqual({ status: 'pending', attempts: 0 });
  expect(await state(eventId, webId)).toBeNull();
  const nativeSend = vi.spyOn(nativePush, 'sendNativePush').mockResolvedValue({ status: 200 });
  const webSend = vi.spyOn(webPush, 'sendWebPush').mockResolvedValue({ status: 201 });
  await dispatchNotifications(nativeEnv); await dispatchNotifications(nativeEnv);
  expect(nativeSend).toHaveBeenCalledTimes(1);
  expect(nativeSend.mock.calls[0]![1].user_id).toBe(user.userId);
  expect(nativeSend.mock.calls[0]![2]).toBe(eventId);
  expect(JSON.stringify(nativeSend.mock.calls[0]!.slice(1))).not.toMatch(/PRIVATE SOURCE/);
  expect(webSend).not.toHaveBeenCalled();
  expect(await state(eventId, device.id)).toEqual({ status: 'sent', attempts: 1 });
});

it('more than one batch of disabled-transport rows cannot starve the enabled transport in either direction', async () => {
  const nativeSend = vi.spyOn(nativePush, 'sendNativePush').mockResolvedValue({ status: 200 });
  const webSend = vi.spyOn(webPush, 'sendWebPush').mockResolvedValue({ status: 201 });
  for (const enabled of ['fcm', 'webpush'] as const) {
    nativeSend.mockClear(); webSend.mockClear();
    const user = await seedUser(); const project = await seedProject(user.userId);
    const disabled = enabled === 'fcm' ? 'webpush' : 'fcm';
    for (let index = 0; index < 21; index++) await seedTransportDevice(user, disabled);
    const target = await seedTransportDevice(user, enabled);
    const eventId = await source(user, project, bothEnv);
    await env.DB.prepare(`UPDATE notification_push_outbox SET available_at='2020-01-01T00:00:00.000Z'
      WHERE event_id=?1 AND subscription_id IN (SELECT id FROM push_subscriptions WHERE transport=?2)`).bind(eventId, disabled).run();
    await dispatchNotifications(enabled === 'fcm' ? nativeEnv : webEnv);
    expect(await state(eventId, target)).toEqual({ status: 'sent', attempts: 1 });
    expect(enabled === 'fcm' ? nativeSend : webSend).toHaveBeenCalledTimes(1);
    expect(enabled === 'fcm' ? webSend : nativeSend).not.toHaveBeenCalled();
    const untouched = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notification_push_outbox o JOIN push_subscriptions s ON s.id=o.subscription_id
      WHERE o.event_id=?1 AND s.transport=?2 AND o.status='pending' AND o.attempts=0`).bind(eventId, disabled).first<{ n: number }>();
    expect(untouched?.n).toBe(21);
    // Keep the next direction independent from the intentionally retained pending fixtures.
    await env.DB.prepare("UPDATE notification_push_outbox SET status='cancelled' WHERE event_id=?1 AND status='pending'").bind(eventId).run();
  }
});

it('logout cancels only current-session native work and another authenticated session still delivers', async () => {
  const user = await seedUser(); const project = await seedProject(user.userId); const a = await register(user);
  const another = { ...user, token: `second-device-${newId()}` }; const now = nowIso();
  await env.DB.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at,auth_method) VALUES(?1,?2,?3,?4,?5,'password')")
    .bind(newId(), user.userId, await sha256Hex(another.token), new Date(Date.now() + 86400_000).toISOString(), now).run();
  const b = await register(another); const eventId = await source(user, project);
  expect((await state(eventId, a.id))?.status).toBe('pending'); expect((await state(eventId, b.id))?.status).toBe('pending');
  await payload(await call(user, '/auth/session', 'DELETE'));
  expect((await state(eventId, a.id))?.status).toBe('cancelled'); expect((await state(eventId, b.id))?.status).toBe('pending');
  expect(await env.DB.prepare('SELECT disabled_reason FROM push_subscriptions WHERE id=?1').bind(a.id).first('disabled_reason')).toBe('logout');
  expect(await env.DB.prepare('SELECT disabled_at FROM push_subscriptions WHERE id=?1').bind(b.id).first('disabled_at')).toBeNull();
  const send = vi.spyOn(nativePush, 'sendNativePush').mockResolvedValue({ status: 200 });
  await dispatchNotifications(nativeEnv);
  expect(send).toHaveBeenCalledTimes(1);
  expect((await state(eventId, b.id))?.status).toBe('sent');
});

it('FCM dispatch rechecks membership and stops a queued event after access is revoked', async () => {
  const user = await seedUser(); const project = await seedProject(user.userId); const device = await register(user);
  const eventId = await source(user, project);
  await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(project, user.userId).run();
  const send = vi.spyOn(nativePush, 'sendNativePush').mockResolvedValue({ status: 200 });
  await dispatchNotifications(nativeEnv);
  expect(send).not.toHaveBeenCalled(); expect((await state(eventId, device.id))?.status).toBe('cancelled');
});

it('authorization and transient failures never expire devices; only explicit unregistration disables them', async () => {
  const user = await seedUser(); const project = await seedProject(user.userId); const device = await register(user);
  const send = vi.spyOn(nativePush, 'sendNativePush');
  for (const status of [400, 401, 403, 429, 503]) {
    send.mockResolvedValue({ status }); const eventId = await source(user, project);
    await dispatchNotifications(nativeEnv);
    expect((await state(eventId, device.id))?.status).toBe(status === 429 || status === 503 ? 'pending' : 'failed');
    expect(await env.DB.prepare('SELECT disabled_at FROM push_subscriptions WHERE id=?1').bind(device.id).first('disabled_at')).toBeNull();
  }
  send.mockRejectedValue(new Error('FCM authorization failed'));
  const failedAuth = await source(user, project); await dispatchNotifications(nativeEnv);
  expect((await state(failedAuth, device.id))?.status).toBe('pending');
  expect(await env.DB.prepare('SELECT disabled_at FROM push_subscriptions WHERE id=?1').bind(device.id).first('disabled_at')).toBeNull();
  send.mockResolvedValue({ status: 410 });
  const unregistered = await source(user, project); await dispatchNotifications(nativeEnv);
  expect((await state(unregistered, device.id))?.status).toBe('cancelled');
  expect(await env.DB.prepare('SELECT disabled_reason FROM push_subscriptions WHERE id=?1').bind(device.id).first('disabled_reason')).toBe('expired');
});
