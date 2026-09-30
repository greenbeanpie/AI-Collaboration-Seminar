import { pbkdf2, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export const PASSWORD_ITERATIONS = 600_000;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
const derive = promisify(pbkdf2);
const encode = (value: Uint8Array): string => btoa(String.fromCharCode(...value));
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), c => c.charCodeAt(0));
// Same KDF work for unknown accounts; this value never authenticates any account.
export const DUMMY_PASSWORD_HASH = `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${encode(new Uint8Array(16))}$${encode(new Uint8Array(32))}`;

/** Workers nodejs_compat native PBKDF2 supports the full 600000-iteration SHA256 work factor. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) throw new Error('Password length outside permitted range');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derive(password, salt, PASSWORD_ITERATIONS, 32, 'sha256');
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${encode(salt)}$${encode(key)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (password.length > PASSWORD_MAX_LENGTH) return false;
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256' || parts[1] !== String(PASSWORD_ITERATIONS)) return false;
  let salt: Uint8Array; let expected: Uint8Array;
  try { salt = decode(parts[2]!); expected = decode(parts[3]!); } catch { return false; }
  if (salt.byteLength !== 16 || expected.byteLength !== 32) return false;
  const computed = await derive(password, salt, PASSWORD_ITERATIONS, 32, 'sha256');
  return timingSafeEqual(computed, expected);
}
