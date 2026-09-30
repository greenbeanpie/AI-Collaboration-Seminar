import { describe, expect, it } from 'vitest';
import { pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import { hashPassword, verifyPassword } from '../src/services/password';
describe('Workers password KDF', () => {
 it('native node crypto supports 600000 PBKDF2 SHA256 iterations', async () => {
  const key = await promisify(pbkdf2)('test-password-123', new Uint8Array(16).fill(3), 600000, 32, 'sha256');
  expect(key.byteLength).toBe(32);
 });
 it('salted hashes verify full passwords and cannot fall back to lower iteration counts', async () => {
  const password = '中文-password-very-long-123';
  const first = await hashPassword(password); const second = await hashPassword(password);
  expect(first).not.toBe(second);
  expect(await verifyPassword(password, first)).toBe(true);
  expect(await verifyPassword(password + '-wrong', first)).toBe(false);
  expect(await verifyPassword(password, first.replace('$600000$', '$100000$'))).toBe(false);
  expect(await verifyPassword(password, 'malformed')).toBe(false);
 });
});
