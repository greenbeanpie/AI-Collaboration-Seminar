import { scrypt, timingSafeEqual } from 'node:crypto';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const SCRYPT_N = 32768;
export const SCRYPT_R = 8;
export const SCRYPT_P = 3;
export const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const HASH_PREFIX = `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}`;
const encode = (value: Uint8Array): string => btoa(String.fromCharCode(...value));
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), c => c.charCodeAt(0));
// Same memory-hard work for unknown accounts; this hash never authenticates an account.
export const DUMMY_PASSWORD_HASH = `${HASH_PREFIX}$${encode(new Uint8Array(16))}$${encode(new Uint8Array(32))}`;

/** OWASP scrypt alternative: N=2^15, r=8, p=3; 32 MiB working memory with 64 MiB allocation limit. */
function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) throw new Error('Password length outside permitted range');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${HASH_PREFIX}$${encode(salt)}$${encode(await derive(password, salt))}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (password.length > PASSWORD_MAX_LENGTH) return false;
  const parts = encoded.split('$');
  // Never silently lower work factors or fall back to production-incompatible PBKDF2.
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== HASH_PREFIX) return false;
  let salt: Uint8Array; let expected: Uint8Array;
  try { salt = decode(parts[4]!); expected = decode(parts[5]!); } catch { return false; }
  if (salt.byteLength !== 16 || expected.byteLength !== 32) return false;
  return timingSafeEqual(await derive(password, salt), expected);
}
