import type { Env } from '../env';

export type SecretPurpose = 'ai-config' | 'checkpoint' | 'media-grant' | 'rate-limit';
export interface SecretKeyring { purpose: SecretPurpose; current?: string; legacy: string }
export const aiSecret = (env: Env): SecretKeyring => ({ purpose: 'ai-config', current: env.AI_CONFIG_SECRET, legacy: env.AUTH_SECRET });
export const checkpointSecret = (env: Env): SecretKeyring => ({ purpose: 'checkpoint', current: env.CHECKPOINT_SECRET, legacy: env.AUTH_SECRET });

/** Domain separation also applies when separate deployment bindings are unavailable. */
async function derive(secret: string, purpose: SecretPurpose): Promise<Uint8Array> {
  if (!secret) throw new Error('加密密钥未配置');
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('ai-office-secrets-v2'), info: new TextEncoder().encode(purpose) }, material, 256));
}
export async function purposeSecret(env: Env, purpose: 'media-grant' | 'rate-limit'): Promise<string> {
  const secret = purpose === 'media-grant' ? env.MEDIA_GRANT_SECRET : env.RATE_LIMIT_SECRET;
  return Array.from(await derive(secret || env.AUTH_SECRET, purpose), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function key(secret: string | SecretKeyring, legacy = false): Promise<CryptoKey> {
  if (!(typeof secret === 'string' ? secret : legacy ? secret.legacy : secret.current || secret.legacy)) throw new Error('加密密钥未配置');
  const bytes = typeof secret === 'string' || legacy
    ? await crypto.subtle.digest('SHA-256', new TextEncoder().encode(typeof secret === 'string' ? secret : secret.legacy))
    : await derive(secret.current || secret.legacy, secret.purpose);
  return crypto.subtle.importKey('raw', bytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value: string, secret: string | SecretKeyring): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const prefix = typeof secret === 'string' ? '' : `v2:${secret.purpose}:`;
  const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, ...(prefix ? { additionalData: new TextEncoder().encode(prefix) } : {}) }, await key(secret), new TextEncoder().encode(value)));
  return prefix + btoa(String.fromCharCode(...iv, ...bytes));
}
export async function unseal(value: string, secret: string | SecretKeyring): Promise<string> {
  const versioned = value.startsWith('v2:');
  const prefix = versioned ? `v2:${typeof secret === 'string' ? '' : secret.purpose}:` : '';
  if (versioned && (typeof secret === 'string' || !value.startsWith(prefix))) throw new Error('加密用途不匹配');
  const bytes = Uint8Array.from(atob(value.slice(prefix.length)), c => c.charCodeAt(0));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), ...(prefix ? { additionalData: new TextEncoder().encode(prefix) } : {}) }, await key(secret, !versioned), bytes.slice(12)));
}
