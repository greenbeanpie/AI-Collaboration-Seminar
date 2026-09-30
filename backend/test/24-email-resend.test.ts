import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResendEmailProvider } from '../src/email/resend';

/** 仅为单测构造的最小 Env；不访问网络，不发送真实邮件 */
function fakeEnv(overrides: Record<string, unknown> = {}) {
  return { ENV_NAME: 'production', RESEND_API_KEY: 'test-key', EMAIL_FROM: 'no-reply@example.com', ...overrides } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('A02 Resend 邮件适配器（全部为 mock，不发送真实请求）', () => {
  it('缺少 RESEND_API_KEY → EMAIL_UNAVAILABLE 且不发起请求', async () => {
    const mock = vi.fn();
    vi.stubGlobal('fetch', mock);
    const provider = createResendEmailProvider(fakeEnv({ RESEND_API_KEY: undefined }));
    await expect(provider.sendVerificationCode('a@example.test', '123456', 'ch-1')).rejects.toMatchObject({
      code: 'EMAIL_UNAVAILABLE',
      retryable: true,
    });
    expect(mock).not.toHaveBeenCalled();
  });

  it('生产环境禁止测试发件人与缺少发件人，网络错误明确返回', async () => {
    const mock = vi.fn(async () => { throw new Error('network'); }); vi.stubGlobal('fetch', mock);
    for (const from of ['', '补位 <onboarding@resend.dev>']) {
      await expect(createResendEmailProvider(fakeEnv({ EMAIL_FROM: from })).sendVerificationCode('a@example.test', '123456', 'ch')).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE' });
    }
    expect(mock).not.toHaveBeenCalled();
    await expect(createResendEmailProvider(fakeEnv()).sendVerificationCode('a@example.test', '123456', 'ch')).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE', retryable: true });
  });

  it('供应商非 2xx → EMAIL_UNAVAILABLE 并保留状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('domain not verified', { status: 422 })));
    const provider = createResendEmailProvider(fakeEnv());
    await expect(provider.sendVerificationCode('a@example.test', '123456', 'ch-2')).rejects.toMatchObject({
      code: 'EMAIL_UNAVAILABLE',
      retryable: true,
      details: { status: 422 },
    });
  });

  it('成功路径只调用一次，请求体包含验证码与发件人', async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify({ id: 'mail-1' }), { status: 200 }));
    vi.stubGlobal('fetch', mock);
    const provider = createResendEmailProvider(fakeEnv());
    await provider.sendVerificationCode('a@example.test', '654321', 'ch-3');

    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://api.resend.com/emails');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-key');
    const body = JSON.parse(String(init.body)) as { from: string; to: string[]; subject: string; html: string };
    expect(body.to).toEqual(['a@example.test']);
    expect(body.from).toBe('no-reply@example.com');
    expect(body.html).toContain('654321');
  });
});
