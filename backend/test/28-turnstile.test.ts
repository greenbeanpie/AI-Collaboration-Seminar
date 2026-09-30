import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from '../src/services/turnstile';
import type { Env } from '../src/env';
const env = { ENV_NAME: 'local', TURNSTILE_REQUIRED: 'true', TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'fixture-secret', ALLOWED_ORIGINS: 'https://team.greenbp.dpdns.org' } as Env;
afterEach(() => vi.unstubAllGlobals());
describe('邮件验证码 Turnstile（受控 mock）', () => {
  it('未配置、缺token都拒绝且不调用邮件', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(verifyTurnstile({ ...env, TURNSTILE_SECRET_KEY: '' }, 'token', null)).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE' });
    await expect(verifyTurnstile(env, undefined, null)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('仅接受正确主机、用途和成功结果', async () => {
    const mock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ success: true, hostname: 'team.greenbp.dpdns.org', action: 'email_login' })));
    vi.stubGlobal('fetch', mock);
    await verifyTurnstile(env, 'token', '192.0.2.1');
    const body = JSON.parse(String(mock.mock.calls[0]?.[1]?.body));
    expect(body.remoteip).toBe('192.0.2.1');
    expect(body.response).toBe('token');
    for (const result of [{ success: false }, { success: true, hostname: 'other.example', action: 'email_login' }, { success: true, hostname: 'team.greenbp.dpdns.org', action: 'other' }]) {
      mock.mockImplementation(async () => new Response(JSON.stringify(result)));
      await expect(verifyTurnstile(env, 'token', null)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
  it('仅显式未启用时跳过，网络失败如实显示', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
    await verifyTurnstile({ ...env, TURNSTILE_REQUIRED: 'false' }, undefined, null);
    expect(fetch).not.toHaveBeenCalled();
    await expect(verifyTurnstile(env, 'token', null)).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE' });
  });
});
