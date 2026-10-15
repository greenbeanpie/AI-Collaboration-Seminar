import type { Env } from '../env';
import { invalidState } from '../core/errors';

export type SecretPurpose = 'ai-config' | 'checkpoint' | 'media-grant' | 'rate-limit';
export interface SecretKeyring { purpose: SecretPurpose; current?: string; legacy: string }
export const aiSecret = (env: Env): SecretKeyring => ({ purpose: 'ai-config', current: env.AI_CONFIG_SECRET, legacy: env.AUTH_SECRET });
export const checkpointSecret = (env: Env): SecretKeyring => ({ purpose: 'checkpoint', current: env.CHECKPOINT_SECRET, legacy: env.AUTH_SECRET });

function encodeBytesBase64(iv: Uint8Array, ciphertext: Uint8Array): string {
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.byteLength);
  let binary = '';
  const batchSize = 8192;
  for (let offset = 0; offset < combined.length; offset += batchSize) {
    binary += String.fromCharCode(...combined.subarray(offset, offset + batchSize));
  }
  return btoa(binary);
}

function decodeBase64Bytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

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
  return prefix + encodeBytesBase64(iv, bytes);
}
export async function unseal(value: string, secret: string | SecretKeyring): Promise<string> {
  const versioned = value.startsWith('v2:');
  const prefix = versioned ? `v2:${typeof secret === 'string' ? '' : secret.purpose}:` : '';
  if (versioned && (typeof secret === 'string' || !value.startsWith(prefix))) throw new Error('加密用途不匹配');
  const bytes = decodeBase64Bytes(value.slice(prefix.length));
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), ...(prefix ? { additionalData: new TextEncoder().encode(prefix) } : {}) }, await key(secret, !versioned), bytes.slice(12)));
}

export interface ChunkedEnvelope<Format extends string = string> {
  format: Format;
  chunks: string[];
}

export async function sealChunkedEnvelope<Format extends string>(
  format: Format,
  idKey: 'attempt' | 'id' | 'key',
  idValue: string,
  payload: unknown,
  secret: string | SecretKeyring,
  chunkCodePoints = 16000,
): Promise<ChunkedEnvelope<Format>> {
  const characters = Array.from(JSON.stringify(payload));
  const chunks: string[] = [];
  const total = Math.ceil(characters.length / chunkCodePoints);
  for (let index = 0; index < total; index++) {
    const data = characters.slice(index * chunkCodePoints, (index + 1) * chunkCodePoints).join('');
    chunks.push(await seal(JSON.stringify({ [idKey]: idValue, index, total, data }), secret));
  }
  return { format, chunks };
}

export async function unsealChunkedEnvelope<T>(
  envelope: { format?: string; chunks?: string[] },
  expectedFormat: string,
  idKey: 'attempt' | 'id' | 'key',
  idValue: string,
  secret: string | SecretKeyring,
  errors: { invalidFormat: string; mismatch: string },
): Promise<T> {
  if (envelope.format !== expectedFormat || !Array.isArray(envelope.chunks) || !envelope.chunks.length) {
    throw invalidState(errors.invalidFormat);
  }
  let text = '';
  for (let index = 0; index < envelope.chunks.length; index++) {
    const part = JSON.parse(await unseal(envelope.chunks[index]!, secret)) as Record<string, unknown>;
    if (
      part[idKey] !== idValue ||
      part.index !== index ||
      part.total !== envelope.chunks.length ||
      typeof part.data !== 'string'
    ) {
      throw invalidState(errors.mismatch);
    }
    text += part.data;
  }
  return JSON.parse(text) as T;
}
