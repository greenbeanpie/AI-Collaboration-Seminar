import type { Env } from '../env';

export interface PushSubscription { endpoint: string; p256dh: string; auth: string }
export interface PushPayload { title: string; body: string; data: { userId: string; notificationId: string; url: string } }
const encoder = new TextEncoder();
export function base64url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
export function decodeBase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error('Invalid push key');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
}
export function safePushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint); const h = url.hostname;
    return endpoint.length <= 2048 && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
      (h === 'fcm.googleapis.com' || h === 'updates.push.services.mozilla.com' || h.endsWith('.push.services.mozilla.com') || h === 'web.push.apple.com' || h.endsWith('.notify.windows.com'));
  } catch { return false; }
}
export async function validPushKeys(p256dh: string, auth: string): Promise<boolean> {
  try {
    const pub = decodeBase64url(p256dh);
    if (pub.length !== 65 || pub[0] !== 4 || decodeBase64url(auth).length !== 16) return false;
    await crypto.subtle.importKey('raw', pub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return true;
  } catch { return false; }
}
function subject(env: Env): string {
  return env.VAPID_SUBJECT ?? env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).find(s => s.startsWith('https://')) ?? '';
}
export function isPushConfigured(env: Env): boolean {
  try {
    const pub = decodeBase64url(env.VAPID_PUBLIC_KEY ?? '');
    const contact = new URL(subject(env));
    return pub.length === 65 && pub[0] === 4 && decodeBase64url(env.VAPID_PRIVATE_KEY ?? '').length === 32 &&
      ['https:', 'mailto:'].includes(contact.protocol) && !contact.username && !contact.password;
  } catch { return false; }
}
async function hkdf(secret: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}
/** RFC 8291 / RFC 8188, one aes128gcm record. Optional inputs support the published RFC test vector. */
export async function encryptPush(payload: Uint8Array, subscription: Pick<PushSubscription, 'p256dh' | 'auth'>, fixture?: { keyPair: CryptoKeyPair; salt: Uint8Array }): Promise<Uint8Array> {
  if (payload.length > 3993) throw new Error('Push payload too large');
  const ua = decodeBase64url(subscription.p256dh); const auth = decodeBase64url(subscription.auth);
  if (ua.length !== 65 || ua[0] !== 4 || auth.length !== 16) throw new Error('Invalid push key');
  const recipient = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const pair = fixture?.keyPair ?? await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
  const salt = fixture?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error('Invalid push salt');
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: recipient } as unknown as SubtleCryptoDeriveKeyAlgorithm, pair.privateKey, 256));
  const ikm = await hkdf(shared, auth, join(encoder.encode('WebPush: info\0'), ua, pub), 32);
  const cek = await hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, join(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21); header.set(salt); new DataView(header.buffer).setUint32(16, 4096); header[20] = pub.length;
  return join(header, pub, ciphertext);
}
export async function sendWebPush(env: Env, subscription: PushSubscription, payload: PushPayload): Promise<{ status: number }> {
  if (!isPushConfigured(env)) throw new Error('Push is not configured');
  if (!safePushEndpoint(subscription.endpoint) || !/^\/app\/(?!\/)[A-Za-z0-9/?=&_%.-]+$/.test(payload.data.url) || payload.data.url.includes('..')) throw new Error('Invalid push destination');
  const pub = decodeBase64url(env.VAPID_PUBLIC_KEY!);
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: base64url(pub.slice(1, 33)), y: base64url(pub.slice(33)), d: env.VAPID_PRIVATE_KEY! }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const jwt = `${base64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))}.${base64url(encoder.encode(JSON.stringify({ aud: new URL(subscription.endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject(env) })))}`;
  // WebCrypto returns the JOSE-compatible 64-octet r||s signature, not DER.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(jwt)));
  if (signature.length !== 64) throw new Error('Invalid VAPID signature');
  const body = await encryptPush(encoder.encode(JSON.stringify(payload)), subscription);
  const response = await fetch(subscription.endpoint, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `vapid t=${jwt}.${base64url(signature)}, k=${env.VAPID_PUBLIC_KEY}`, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Topic: payload.data.notificationId.replaceAll('-', '').slice(0, 32) },
    body,
  });
  await response.body?.cancel();
  return { status: response.status };
}
