import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { createApp } from '../src/app';
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
});
