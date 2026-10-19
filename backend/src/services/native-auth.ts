import type { Env } from '../env';
import { newId, nowIso, sha256Hex } from '../core/db';
import { loadSessionUser } from '../core/auth';
import { unauthenticated, validationFailed } from '../core/errors';
import { consumePasswordRateLimit, SESSION_TTL_SECONDS } from './accounts';

export const NATIVE_CALLBACK = 'buwei-native-preview://auth/callback';
const randomSecret = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export async function nativeChallenge(verifier: string): Promise<string> {
  const hex = await sha256Hex(verifier);
  return btoa(String.fromCharCode(...hex.match(/../g)!.map(part => parseInt(part, 16)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
const unavailable = () => validationFailed('原生登录请求无效、已过期或已使用，请从应用重新登录');

export async function beginNativeAuth(env: Env, input: { codeChallenge: string; state: string }, ip: string) {
  await consumePasswordRateLimit(env, 'native-begin-ip', ip, 30, 600);
  const now = nowIso();
  await env.DB.prepare('DELETE FROM native_auth_transactions WHERE id IN (SELECT id FROM native_auth_transactions WHERE expires_at <= ?1 LIMIT 100)').bind(now).run();
  const transactionId = newId(); const expiresAt = new Date(Date.now() + 300_000).toISOString();
  await env.DB.prepare('INSERT INTO native_auth_transactions (id, code_challenge, client_state, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(transactionId, input.codeChallenge, input.state, now, expiresAt).run();
  return { transactionId, authorizationPath: `/app/native-authorize?transaction=${transactionId}`, expiresAt };
}

export async function nativeAuthInfo(env: Env, id: string) {
  const row = await env.DB.prepare('SELECT client_state, expires_at FROM native_auth_transactions WHERE id = ?1 AND expires_at > ?2 AND code_hash IS NULL AND consumed_at IS NULL').bind(id, nowIso()).first<{ client_state: string; expires_at: string }>();
  if (!row) throw unavailable();
  return { state: row.client_state, expiresAt: row.expires_at };
}

export async function approveNativeAuth(env: Env, id: string, browserToken: string, userId: string) {
  await consumePasswordRateLimit(env, 'native-approve-user', userId, 30, 600);
  const code = randomSecret(); const now = nowIso();
  const row = await env.DB.prepare(`UPDATE native_auth_transactions SET code_hash = ?2, approved_session_hash = ?3,
    expires_at = min(expires_at, ?4)
    WHERE id = ?1 AND expires_at > ?5 AND code_hash IS NULL AND consumed_at IS NULL
    AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?3 AND user_id = ?6 AND revoked_at IS NULL AND expires_at > ?5 AND auth_method = 'password')
    RETURNING client_state`).bind(id, await sha256Hex(code), await sha256Hex(browserToken), new Date(Date.now() + 60_000).toISOString(), now, userId).first<{ client_state: string }>();
  if (!row) throw unavailable();
  const callback = new URL(NATIVE_CALLBACK); callback.searchParams.set('code', code); callback.searchParams.set('state', row.client_state);
  return { redirectUri: callback.toString() };
}

export async function exchangeNativeAuth(env: Env, input: { code: string; codeVerifier: string }, ip: string) {
  await consumePasswordRateLimit(env, 'native-exchange-ip', ip, 60, 600);
  const codeHash = await sha256Hex(input.code); const challenge = await nativeChallenge(input.codeVerifier);
  const token = randomSecret(); const tokenHash = await sha256Hex(token); const now = nowIso();
  // D1 batches are atomic. Both minting and consuming depend on the same active browser
  // session and unused authorization. A competing exchange cannot mint a second session.
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, auth_method)
      SELECT ?1, s.user_id, ?2, ?3, ?4, 'password'
      FROM native_auth_transactions t JOIN sessions s ON s.token_hash = t.approved_session_hash
      JOIN auth_accounts a ON a.user_id = s.user_id
      WHERE t.code_hash = ?5 AND t.code_challenge = ?6 AND t.consumed_at IS NULL AND t.expires_at > ?4
      AND s.revoked_at IS NULL AND s.expires_at > ?4 AND s.auth_method = 'password' AND a.password_hash IS NOT NULL`)
      .bind(newId(), tokenHash, new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(), now, codeHash, challenge),
    env.DB.prepare(`UPDATE native_auth_transactions SET consumed_at = ?2 WHERE code_hash = ?1 AND consumed_at IS NULL
      AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?3)`)
      .bind(codeHash, now, tokenHash),
  ]);
  if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1) throw unavailable();
  const user = await loadSessionUser(env, token);
  if (!user) throw unauthenticated();
  return { user, token };
}
