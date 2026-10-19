import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { env, BASE } from './helpers/env';
import { authCookie, seedUser } from './helpers/seed';
import { nativeChallenge } from '../src/services/native-auth';
import { sha256Hex } from '../src/core/db';

const verifier = 'a'.repeat(43); const state = 's'.repeat(43);
function app() { return createApp(); }
function call(path: string, body?: unknown, cookie?: string, origin?: string) {
  return app().fetch(new Request(BASE + '/api/v1/auth/native' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), env);
}
async function begin() {
  const response = await call('/transactions', { codeChallenge: await nativeChallenge(verifier), state }); expect(response.status).toBe(201);
  return (await response.json() as { data: { transactionId: string; authorizationPath: string } }).data;
}
async function approved() {
  const user = await seedUser(); const transaction = await begin();
  const res = await call(`/transactions/${transaction.transactionId}/approve`, {}, authCookie(user.token)); expect(res.status).toBe(200);
  const redirect = new URL((await res.json() as { data: { redirectUri: string } }).data.redirectUri);
  return { user, transaction, redirect, code: redirect.searchParams.get('code')! };
}
beforeEach(async () => { await env.DB.prepare('DELETE FROM auth_password_rate_limits').run(); });

describe('Native browser S256 authorization', () => {
  it('implements the RFC 7636 S256 test vector', async () => {
    expect(await nativeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('requires authenticated approval, returns fixed callback and mints a separate HttpOnly session once', async () => {
    const transaction = await begin();
    expect(transaction.authorizationPath).toBe(`/app/native-authorize?transaction=${transaction.transactionId}`);
    expect((await call(`/transactions/${transaction.transactionId}`)).status).toBe(401);
    expect((await call(`/transactions/${transaction.transactionId}/approve`, {})).status).toBe(401);
    const { user, redirect, code } = await approved();
    expect(redirect.protocol).toBe('buwei-native-preview:'); expect(redirect.host).toBe('auth'); expect(redirect.pathname).toBe('/callback'); expect(redirect.searchParams.get('state')).toBe(state);
    expect(redirect.toString()).not.toContain(user.token);
    const stored = await env.DB.prepare('SELECT code_hash FROM native_auth_transactions WHERE code_hash = ?1').bind(await sha256Hex(code)).first(); expect(stored).toBeTruthy();
    const exchanged = await call('/exchange', { code, codeVerifier: verifier }); expect(exchanged.status).toBe(201);
    const cookie = exchanged.headers.get('set-cookie')!; expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).not.toContain(user.token);
    expect((await exchanged.json() as { data: { user: { id: string } } }).data.user.id).toBe(user.userId);
    expect((await call('/exchange', { code, codeVerifier: verifier })).status).toBe(400);
  });
  it('rejects incorrect PKCE without consuming the legitimate authorization and serializes concurrent exchange', async () => {
    const { code, user } = await approved();
    expect((await call('/exchange', { code, codeVerifier: 'b'.repeat(43) })).status).toBe(400);
    const responses = await Promise.all(Array.from({ length: 3 }, () => call('/exchange', { code, codeVerifier: verifier })));
    expect(responses.map(response => response.status).sort()).toEqual([201, 400, 400]);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM sessions WHERE user_id = ?1').bind(user.userId).first<{ n: number }>())?.n).toBe(2);
  });
  it('refuses reapproval and refuses revoked or expired browser sessions at exchange', async () => {
    const { code, transaction, user } = await approved();
    expect((await call(`/transactions/${transaction.transactionId}/approve`, {}, authCookie(user.token))).status).toBe(400);
    await env.DB.prepare('UPDATE sessions SET revoked_at = ?2 WHERE token_hash = ?1').bind(await sha256Hex(user.token), new Date().toISOString()).run();
    expect((await call('/exchange', { code, codeVerifier: verifier })).status).toBe(400);
    const another = await approved();
    await env.DB.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ?1").bind(await sha256Hex(another.user.token)).run();
    expect((await call('/exchange', { code: another.code, codeVerifier: verifier })).status).toBe(400);
  });
  it('rejects expired transactions, unsolicited fields and cross-origin approval', async () => {
    const { transaction, user, code } = await approved();
    expect((await call('/transactions', { codeChallenge: await nativeChallenge(verifier), state, redirectUri: 'https://evil.invalid' })).status).toBe(400);
    expect((await call(`/transactions/${transaction.transactionId}/approve`, {}, authCookie(user.token), 'https://evil.invalid')).status).toBe(403);
    await env.DB.prepare("UPDATE native_auth_transactions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1").bind(transaction.transactionId).run();
    expect((await call('/exchange', { code, codeVerifier: verifier })).status).toBe(400);
    expect((await call('/exchange', { code, codeVerifier: 'short' })).status).toBe(400);
  });
  it('persistently rate limits public transaction creation', async () => {
    const challenge = await nativeChallenge(verifier);
    const responses = await Promise.all(Array.from({ length: 31 }, () => call('/transactions', { codeChallenge: challenge, state })));
    expect(responses.filter(response => response.status === 201)).toHaveLength(30);
    expect(responses.filter(response => response.status === 429)).toHaveLength(1);
  });
});
