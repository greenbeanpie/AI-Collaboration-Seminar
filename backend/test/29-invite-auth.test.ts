import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { createApp } from '../src/app';
import { createChallenge } from '../src/services/auth-codes';
import type { Env } from '../src/env';

beforeEach(async () => {
  vi.unstubAllGlobals();
  await env.DB.batch([env.DB.prepare('DELETE FROM auth_challenges'), env.DB.prepare('DELETE FROM auth_email_daily_usage'), env.DB.prepare('DELETE FROM auth_email_recipient_usage'), env.DB.prepare('DELETE FROM auth_email_ip_attempts')]);
});
const invited = (): Env => ({ ...env, ENV_NAME: 'production', AUTH_MODE: 'invite-only', AUTH_ALLOWED_EMAILS: 'owner@example.test', EMAIL_MODE: 'resend', EMAIL_FROM: 'login@auth.example.test', RESEND_API_KEY: 'fixture-key', EMAIL_DAILY_LIMIT: '30', ALLOWED_ORIGINS: BASE });
const post = (path: string, body: unknown, bindings: Env) => createApp().fetch(new Request(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(body) }), bindings);

describe('OTP 入口停用与保留邮件适配器的原子配额', () => {
  it('旧邀请邮箱名单或邮件配置不能重新启用 OTP 认证', async () => {
    const mock = vi.fn(); vi.stubGlobal('fetch', mock);
    for (const settings of [invited(), { ...invited(), AUTH_ALLOWED_EMAILS: '' }, { ...invited(), AUTH_MODE: 'turnstile' as const }]) {
      expect((await post('/api/v1/auth/challenges', { email: 'owner@example.test' }, settings)).status).toBe(410);
      expect((await post('/api/v1/auth/sessions', { email: 'owner@example.test', challengeId: crypto.randomUUID(), code: '123456' }, settings)).status).toBe(400);
    }
    expect(mock).not.toHaveBeenCalled();
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_challenges').first<{ n: number }>())?.n).toBe(0);
  });
  it('十二个并发请求最多预占三封邮件，不超全站额度', async () => {
    const addresses = Array.from({ length: 12 }, (_, i) => `person${i}@example.test`);
    const bindings = { ...invited(), AUTH_ALLOWED_EMAILS: addresses.join(','), EMAIL_DAILY_LIMIT: '3' };
    const sendVerificationCode = vi.fn(async () => {});
    const results = await Promise.allSettled(addresses.map((email, i) => createChallenge(bindings, { email, ip: `192.0.2.${i}`, emailProvider: { sendVerificationCode } })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
    expect(sendVerificationCode).toHaveBeenCalledTimes(3);
    expect((await env.DB.prepare('SELECT SUM(sends) AS n FROM auth_email_daily_usage').first<{ n: number }>())?.n).toBe(3);
  });
  it('验证码记录被清理后仍保留逐邮箱日额度', async () => {
    const sendVerificationCode = vi.fn(async () => {});
    for (let i = 0; i < 6; i++) {
      await createChallenge(invited(), { email: 'owner@example.test', ip: null, emailProvider: { sendVerificationCode } });
      // Emulate expiration cleanup; counters must not rely on transient challenges.
      await env.DB.prepare('DELETE FROM auth_challenges').run();
    }
    await expect(createChallenge(invited(), { email: 'owner@example.test', ip: null, emailProvider: { sendVerificationCode } })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(sendVerificationCode).toHaveBeenCalledTimes(6);
    const recipient = await env.DB.prepare('SELECT email_hash, sends FROM auth_email_recipient_usage').first<{ email_hash: string; sends: number }>();
    expect(recipient?.sends).toBe(6);
    expect(recipient?.email_hash).not.toContain('owner');
  });

  it('验证码记录清理后仍保留 IP 每小时额度', async () => {
    const addresses = Array.from({ length: 12 }, (_, i) => `ip-person${i}@example.test`);
    const bindings = { ...invited(), AUTH_ALLOWED_EMAILS: addresses.join(',') };
    const sendVerificationCode = vi.fn(async () => {});
    for (const email of addresses.slice(0, 10)) {
      await createChallenge(bindings, { email, ip: '192.0.2.10', emailProvider: { sendVerificationCode } });
      await env.DB.prepare('DELETE FROM auth_challenges').run();
    }
    await expect(createChallenge(bindings, { email: addresses[10]!, ip: '192.0.2.10', emailProvider: { sendVerificationCode } })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(sendVerificationCode).toHaveBeenCalledTimes(10);
  });

  it('同一邮箱并发只发一次，供应商失败仍计入发送额度', async () => {
    const sendVerificationCode = vi.fn(async () => { throw new Error('provider failed'); });
    await Promise.allSettled([1, 2].map(() => createChallenge(invited(), { email: 'owner@example.test', ip: null, emailProvider: { sendVerificationCode } })));
    expect(sendVerificationCode).toHaveBeenCalledTimes(1);
    expect((await env.DB.prepare('SELECT SUM(sends) AS n FROM auth_email_daily_usage').first<{ n: number }>())?.n).toBe(1);
  });
});
