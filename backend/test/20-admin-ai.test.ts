import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { ADMIN_TOKEN } from './helpers/constants';

const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };

function gatewayMock(content: string) {
  return vi.fn(async () => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 11, completion_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('管理端鉴权', () => {
  it('无令牌/错误令牌 → 401', async () => {
    const anon = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`);
    expect(anon.status).toBe(401);
    const bad = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(bad.status).toBe(401);
  });
});

describe('AI 配置版本化', () => {
  it('种子配置 version=1 未启用；写入新版本启用后 capabilities 跟随', async () => {
    const get = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { headers: adminHeaders });
    expect(get.status).toBe(200);
    const current = (await get.json()) as { data: { version: number; enabled: boolean } };
    expect(current.data.version).toBe(1);
    expect(current.data.enabled).toBe(false);

    const capsBefore = await SELF.fetch(`${BASE}/api/v1/capabilities`);
    const before = (await capsBefore.json()) as { data: { features: { aiEnabled: boolean } } };
    expect(before.data.features.aiEnabled).toBe(false);

    const put = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        textEconomy: {
          provider: 'workers-ai',
          model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
          timeoutMs: 60000,
          maxInputChars: 48000,
          maxOutputTokens: 4096,
          supportsJson: true,
          supportsVision: false,
          pricePerMTokens: null,
        },
        visionEconomy: {
          provider: 'workers-ai',
          model: '@cf/meta/llama-3.2-11b-vision-instruct',
          timeoutMs: 90000,
          maxInputChars: 12000,
          maxOutputTokens: 2048,
          supportsJson: true,
          supportsVision: true,
          pricePerMTokens: null,
        },
        review: {
          provider: 'workers-ai',
          model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
          timeoutMs: 120000,
          maxInputChars: 96000,
          maxOutputTokens: 6144,
          supportsJson: true,
          supportsVision: false,
          pricePerMTokens: null,
        },
        enabled: true,
        notes: '测试启用',
      }),
    });
    expect(put.status).toBe(201);
    const putData = (await put.json()) as { data: { version: number; enabled: boolean } };
    expect(putData.data.version).toBe(2);
    expect(putData.data.enabled).toBe(true);

    const capsAfter = await SELF.fetch(`${BASE}/api/v1/capabilities`);
    const after = (await capsAfter.json()) as { data: { features: { aiEnabled: boolean } } };
    expect(after.data.features.aiEnabled).toBe(true);
  });
});

describe('AI 能力探测', () => {
  it('模型正常时四项检查通过，并记录 ai_calls（费用未知）', async () => {
    const mock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ content: unknown }>;
      };
      const first = body.messages?.[0]?.content;
      const text = typeof first === 'string' ? first : '';
      if (text.includes('你好')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '你好，我是中文助手。' } }],
            usage: { prompt_tokens: 11, completion_tokens: 5 },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok": true, "n": 1}' } }],
          usage: { prompt_tokens: 8, completion_tokens: 4 },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', mock);

    const res = await SELF.fetch(`${BASE}/api/v1/admin/ai-config/probe`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ purpose: 'textEconomy' }),
    });
    expect(res.status).toBe(200);
    const report = (await res.json()) as { data: { passed: boolean; checks: Array<{ name: string; passed: boolean }> } };
    expect(report.data.passed).toBe(true);
    const byName = Object.fromEntries(report.data.checks.map((c) => [c.name, c.passed]));
    expect(byName).toEqual({
      chinese_text: true,
      json_output: true,
      vision_accept: true,
      usage_fields: true,
    });
    expect(mock).toHaveBeenCalled();

    const calls = await env.DB.prepare('SELECT cost_usd, cost_status FROM ai_calls').all<{ cost_usd: number | null; cost_status: string }>();
    expect(calls.results.length).toBe(2); // 中文 + JSON 两次真实调用记录
    for (const row of calls.results) {
      expect(row.cost_usd).toBeNull();
      expect(row.cost_status).toBe('unknown');
    }
  });

  it('模型 500 时探测失败且报告不可重试细节', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream exploded', { status: 500 })),
    );
    const res = await SELF.fetch(`${BASE}/api/v1/admin/ai-config/probe`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ purpose: 'textEconomy' }),
    });
    expect(res.status).toBe(200);
    const report = (await res.json()) as { data: { passed: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> } };
    expect(report.data.passed).toBe(false);
    expect(report.data.checks[0]?.passed).toBe(false);
    expect(report.data.checks[0]?.detail).toContain('500');
  });
});
