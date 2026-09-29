import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';

interface ChallengeData {
  data: { challengeId: string; expiresAt: string; resendAfterSeconds: number; devCode?: string };
}

async function createChallenge(email: string): Promise<{ res: Response; body: ChallengeData }> {
  const res = await SELF.fetch(`${BASE}/api/v1/auth/challenges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const body = (await res.json()) as ChallengeData;
  return { res, body };
}

async function login(email: string, challengeId: string, code: string): Promise<{ res: Response; cookie: string | null }> {
  const res = await SELF.fetch(`${BASE}/api/v1/auth/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, challengeId, code }),
  });
  const setCookie = res.headers.get('set-cookie');
  const cookie = setCookie?.split(';')[0] ?? null;
  return { res, cookie };
}

describe('验证码登录全流程', () => {
  it('请求验证码 → 换取会话 → 读取/注销会话', async () => {
    const email = `flow-${crypto.randomUUID()}@example.com`;
    const { res, body } = await createChallenge(email);
    expect(res.status).toBe(201);
    expect(body.data.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    // 回显模式（local）返回 devCode
    expect(body.data.devCode).toMatch(/^\d{6}$/);

    const { res: loginRes, cookie } = await login(email, body.data.challengeId, body.data.devCode!);
    expect(loginRes.status).toBe(201);
    expect(cookie).toContain('ai_office_session=');
    const loginBody = (await loginRes.json()) as { data: { user: { id: string; email: string; displayName: string } } };
    expect(loginBody.data.user.email).toBe(email);
    expect(loginBody.data.user.displayName.length).toBeGreaterThan(0);

    const me = await SELF.fetch(`${BASE}/api/v1/auth/session`, { headers: { cookie: cookie! } });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { data: { user: { email: string } } };
    expect(meBody.data.user.email).toBe(email);

    const logout = await SELF.fetch(`${BASE}/api/v1/auth/session`, { method: 'DELETE', headers: { cookie: cookie! } });
    expect(logout.status).toBe(200);
    const after = await SELF.fetch(`${BASE}/api/v1/auth/session`, { headers: { cookie: cookie! } });
    expect(after.status).toBe(401);
  });

  it('同一用户再次登录复用同一账号', async () => {
    const email = `again-${crypto.randomUUID()}@example.com`;
    const first = await createChallenge(email);
    const l1 = await login(email, first.body.data.challengeId, first.body.data.devCode!);
    expect(l1.res.status).toBe(201);
    const user1 = ((await l1.res.json()) as { data: { user: { id: string } } }).data.user.id;

    // 回拨挑战时间以越过 60s 发送间隔
    await env.DB.prepare('UPDATE auth_challenges SET requested_at = ?2 WHERE email = ?1')
      .bind(email, new Date(Date.now() - 61_000).toISOString())
      .run();

    const second = await createChallenge(email);
    expect(second.res.status).toBe(201);
    const l2 = await login(email, second.body.data.challengeId, second.body.data.devCode!);
    expect(l2.res.status).toBe(201);
    const user2 = ((await l2.res.json()) as { data: { user: { id: string } } }).data.user.id;
    expect(user2).toBe(user1);
  });

  it('错误验证码 → 400；尝试 5 次后 → 429', async () => {
    const email = `attempts-${crypto.randomUUID()}@example.com`;
    const { body } = await createChallenge(email);
    for (let i = 0; i < 5; i++) {
      const bad = await login(email, body.data.challengeId, '000000');
      expect(bad.res.status).toBe(400);
      expect(((await bad.res.json()) as { error: { code: string } }).error.code).toBe('AUTH_CHALLENGE_INVALID');
    }
    const sixth = await login(email, body.data.challengeId, '000000');
    expect(sixth.res.status).toBe(429);
    expect(((await sixth.res.json()) as { error: { code: string } }).error.code).toBe('AUTH_ATTEMPTS_EXCEEDED');
  });

  it('过期验证码 → 410', async () => {
    const email = `expired-${crypto.randomUUID()}@example.com`;
    const { body } = await createChallenge(email);
    await env.DB.prepare("UPDATE auth_challenges SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1")
      .bind(body.data.challengeId)
      .run();
    const res = await login(email, body.data.challengeId, body.data.devCode!);
    expect(res.res.status).toBe(410);
    expect(((await res.res.json()) as { error: { code: string } }).error.code).toBe('AUTH_CHALLENGE_EXPIRED');
  });

  it('单邮箱 60 秒内重复请求 → 429', async () => {
    const email = `resend-${crypto.randomUUID()}@example.com`;
    const first = await createChallenge(email);
    expect(first.res.status).toBe(201);
    const second = await createChallenge(email);
    expect(second.res.status).toBe(429);
    expect((second.body as unknown as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
  });

  it('不信任明文：库中不存验证码原文', async () => {
    const email = `hmac-${crypto.randomUUID()}@example.com`;
    const { body } = await createChallenge(email);
    const row = await env.DB.prepare('SELECT code_hmac FROM auth_challenges WHERE id = ?1')
      .bind(body.data.challengeId)
      .first<{ code_hmac: string }>();
    expect(row?.code_hmac).not.toBe(body.data.devCode);
    expect(row?.code_hmac?.length).toBe(64); // SHA-256 hex
  });

  it('写请求携带不在白名单的 Origin → 403', async () => {
    const res = await SELF.fetch(`${BASE}/api/v1/auth/challenges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: `origin-${crypto.randomUUID()}@example.com` }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('PERMISSION_DENIED');
  });
});
