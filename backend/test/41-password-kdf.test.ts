import { describe, expect, it } from 'vitest';
import { scrypt } from 'node:crypto';
import { hashPassword, verifyPassword, SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_MAXMEM } from '../src/services/password';

describe('Workers memory-hard password KDF', () => {
  it('native node crypto supports OWASP scrypt N32768 r8 p3 with 64MiB maxmem', async () => {
    const key = await new Promise<Uint8Array>((resolve, reject) => scrypt('test-password-123', new Uint8Array(16).fill(3), 32, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }, (error, value) => error ? reject(error) : resolve(value)));
    expect(key.byteLength).toBe(32);
  });
  it('salted hashes verify full passwords and reject weaker KDF parameters and legacy PBKDF2', async () => {
    const password = '中文-password-very-long-123';
    const first = await hashPassword(password); const second = await hashPassword(password);
    expect(first).toMatch(/^scrypt\$32768\$8\$3\$/);
    expect(first).not.toBe(second);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword(password + '-wrong', first)).toBe(false);
    expect(await verifyPassword(password, first.replace('$32768$', '$16384$'))).toBe(false);
    expect(await verifyPassword(password, first.replace('$8$3$', '$8$1$'))).toBe(false);
    expect(await verifyPassword(password, 'pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')).toBe(false);
    expect(await verifyPassword(password, 'malformed')).toBe(false);
  });
});
