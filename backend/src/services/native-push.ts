import type { Env } from '../env';
import { newId, nowIso, sha256Hex } from '../core/db';
import { invalidState } from '../core/errors';

/** Optional deployment secrets. No Firebase credential is shipped to the APK. */
export interface NativePushConfig {
  FCM_PROJECT_ID?: string;
  FCM_CLIENT_EMAIL?: string;
  FCM_PRIVATE_KEY?: string;
}
type NativeEnv = Env & NativePushConfig;
export function isNativePushConfigured(env: NativePushConfig | Env): boolean {
  const config = env as NativePushConfig;
  return Boolean(config.FCM_PROJECT_ID && config.FCM_CLIENT_EMAIL && config.FCM_PRIVATE_KEY);
}

/** A fresh account/session binding never inherits queued events from a previous binding. */
export async function registerNativeDevice(env: NativeEnv, userId: string, sessionHash: string, installationId: string, token: string): Promise<string> {
  const existing = await env.DB.prepare("SELECT id,session_hash,native_token,disabled_at FROM push_subscriptions WHERE user_id=?1 AND installation_id=?2 AND transport='fcm'")
    .bind(userId, installationId).first<{ id: string; session_hash: string; native_token: string; disabled_at: string | null }>();
  // Repeated refresh of the same token/session is idempotent and must not cancel delivery.
  if (existing?.session_hash === sessionHash && existing.native_token === token && existing.disabled_at === null) return existing.id;
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?1 AND disabled_at IS NULL').bind(userId).first<{ n: number }>();
  if (!existing && (count?.n ?? 0) >= 20) throw invalidState('已达到设备订阅数量上限');
  const id = existing?.id ?? newId();
  const now = nowIso();
  // Endpoint is an opaque account/installation key; token remains in its own column.
  const endpoint = `fcm:${await sha256Hex(`${userId}:${installationId}`)}`;
  await env.DB.batch([
    env.DB.prepare(`UPDATE notification_push_outbox SET status='cancelled',lease_until=NULL,updated_at=?3
      WHERE status IN ('pending','sending') AND subscription_id IN
      (SELECT id FROM push_subscriptions WHERE transport='fcm' AND (native_token=?1 OR (user_id=?2 AND installation_id=?4)))`)
      .bind(token, userId, now, installationId),
    env.DB.prepare(`UPDATE push_subscriptions SET disabled_at=?2,disabled_reason='rebound',updated_at=?2
      WHERE transport='fcm' AND native_token=?1 AND disabled_at IS NULL`).bind(token, now),
    env.DB.prepare(`INSERT INTO push_subscriptions(id,user_id,session_hash,endpoint,p256dh,auth,created_at,updated_at,transport,installation_id,native_token)
      VALUES(?1,?2,?3,?4,'','',?5,?5,'fcm',?6,?7)
      ON CONFLICT(user_id,installation_id) WHERE transport='fcm' DO UPDATE SET session_hash=excluded.session_hash,
      native_token=excluded.native_token,disabled_at=NULL,disabled_reason=NULL,created_at=excluded.created_at,updated_at=excluded.updated_at`)
      .bind(id, userId, sessionHash, endpoint, now, installationId, token),
  ]);
  const saved = await env.DB.prepare("SELECT id FROM push_subscriptions WHERE user_id=?1 AND installation_id=?2 AND transport='fcm'")
    .bind(userId, installationId).first<{ id: string }>();
  if (!saved) throw invalidState('无法保存设备注册');
  return saved.id;
}

/** Logout revokes every native installation bound to this exact session only. */
export async function revokeNativeSession(env: Env, userId: string, sessionHash: string): Promise<void> {
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare(`UPDATE push_subscriptions SET disabled_at=?3,disabled_reason='logout',updated_at=?3
      WHERE user_id=?1 AND session_hash=?2 AND transport='fcm' AND disabled_at IS NULL`).bind(userId, sessionHash, now),
    env.DB.prepare(`UPDATE notification_push_outbox SET status='cancelled',lease_until=NULL,updated_at=?3
      WHERE status IN ('pending','sending') AND subscription_id IN
      (SELECT id FROM push_subscriptions WHERE user_id=?1 AND session_hash=?2 AND transport='fcm')`).bind(userId, sessionHash, now),
  ]);
}

function base64url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Only OAuth credentials are cached, never notification visibility or account permissions.
let cached: { key: string; token: string; expires: number } | undefined;
async function accessToken(env: NativeEnv): Promise<string> {
  const cacheKey = await sha256Hex(`${env.FCM_CLIENT_EMAIL}:${env.FCM_PRIVATE_KEY}`);
  if (cached?.key === cacheKey && cached.expires > Date.now() + 60_000) return cached.token;
  const issued = Math.floor(Date.now() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({
    iss: env.FCM_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: issued, exp: issued + 3600,
  }))}`;
  const pem = env.FCM_PRIVATE_KEY!.replace(/\\n/g, '\n').replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${base64url(signature)}` }),
  });
  if (!response.ok) throw new Error('FCM authorization failed');
  const result = await response.json() as { access_token?: string; expires_in?: number };
  if (!result.access_token || !Number.isFinite(result.expires_in) || result.expires_in! <= 0) throw new Error('Invalid FCM authorization response');
  cached = { key: cacheKey, token: result.access_token, expires: Date.now() + Math.min(result.expires_in!, 3600) * 1000 };
  return cached.token;
}

/** Return the same delivery contract as Web Push. Only UNREGISTERED disables a token. */
export async function sendNativePush(env: NativeEnv, device: { native_token: string; user_id: string }, eventId: string): Promise<{ status: number }> {
  if (!isNativePushConfigured(env)) return { status: 503 };
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FCM_PROJECT_ID!)}/messages:send`, {
    method: 'POST', headers: { authorization: `Bearer ${await accessToken(env)}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    // Data-only delivery lets the app reject old-account messages before showing anything.
    body: JSON.stringify({ message: { token: device.native_token,
      data: { eventId, userId: device.user_id }, android: { priority: 'high', ttl: '60s', collapse_key: eventId } } }),
  });
  if (response.ok) return { status: response.status };
  const error = await response.json().catch(() => null) as { error?: { details?: Array<{ errorCode?: string }> } } | null;
  if (error?.error?.details?.some(detail => detail.errorCode === 'UNREGISTERED')) return { status: 410 };
  // A missing project is a configuration error, not evidence the device token expired.
  return { status: response.status === 404 ? 400 : response.status };
}
