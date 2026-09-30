import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { ADMIN_TOKEN } from './helpers/constants';
import { aiConfigSchema } from '../src/ai/config';

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
  it('种子配置未启用；禁止未测试直接启用', async () => {
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
    expect(put.status).toBe(409);
    const capsAfter = await SELF.fetch(`${BASE}/api/v1/capabilities`);
    const after = (await capsAfter.json()) as { data: { features: { aiEnabled: boolean } } };
    expect(after.data.features.aiEnabled).toBe(false);
  });
});

describe('AI 能力探测', () => {
  it('自定义地址和密钥加密保存，全部用途探测后启用；变更配置使证据失效', async () => {
    const row = await env.DB.prepare('SELECT config_json FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{ config_json: string }>();
    const config = aiConfigSchema.parse(JSON.parse(row!.config_json));
    const body = Object.fromEntries(Object.entries(config).map(([p, model]) => [p, { ...model, provider: 'openai-compatible', model: 'test-model', apiUrl: 'https://model.example.com/v1/chat/completions', apiKey: 'fixture-key' }]));
    const save = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ ...body, enabled: false }) });
    expect(save.status).toBe(201);
    const stored = await env.DB.prepare('SELECT config_json FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{ config_json: string }>();
    expect(stored!.config_json).not.toContain('fixture-key');
    const read = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { headers: adminHeaders });
    const loaded = (await read.json() as { data: { config: Record<string, Record<string, unknown>> } }).data.config;
    expect(JSON.stringify(loaded)).not.toContain('apiKeyEncrypted');
    expect(loaded.textEconomy!.keyConfigured).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('https://model.example.com/v1/chat/completions');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-key');
      const messages = JSON.parse(String(init?.body)).messages;
      const content = Array.isArray(messages[0].content) ? '{"seen":true}' : messages[0].content.includes('你好') ? '你好，我是助手。' : '{"ok":true,"n":1}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 8, completion_tokens: 4 } }));
    }));
    for (const purpose of ['textEconomy', 'visionEconomy', 'review']) {
      const res = await SELF.fetch(`${BASE}/api/v1/admin/ai-config/probe`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ purpose }) });
      expect((await res.json() as { data: { passed: boolean } }).data.passed).toBe(true);
    }
    const enable = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ ...loaded, enabled: true }) });
    expect(enable.status).toBe(201);
    const changed = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ ...loaded, textEconomy: { ...loaded.textEconomy, model: 'changed' }, enabled: true }) });
    expect(changed.status).toBe(409);
  });
  it('模型正常时四项检查通过，并记录 ai_calls（费用未知）', async () => {
    const beforeCalls = await env.DB.prepare('SELECT COUNT(*) AS n FROM ai_calls').first<{ n: number }>();
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
    expect(calls.results.length).toBe((beforeCalls?.n ?? 0) + 2); // 中文 + JSON 两次真实调用记录
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

  it('探测失败不产生通过证据，启用仍被拒绝', async () => {
    const row = await env.DB.prepare('SELECT config_json FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{ config_json: string }>();
    const config = aiConfigSchema.parse(JSON.parse(row!.config_json));
    const body = Object.fromEntries(
      Object.entries(config).map(([p, model]) => [p, { ...model, provider: 'openai-compatible', model: 'probe-fail-model', apiUrl: 'https://model.example.com/v1/chat/completions', apiKey: 'fixture-key' }]),
    );
    const save = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ ...body, enabled: false }) });
    expect(save.status).toBe(201);
    const saved = await env.DB.prepare('SELECT id FROM ai_config_versions ORDER BY version DESC LIMIT 1').first<{ id: string }>();

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'plain english only' } }], usage: {} }))));
    const probe = await SELF.fetch(`${BASE}/api/v1/admin/ai-config/probe`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ purpose: 'textEconomy' }) });
    expect(probe.status).toBe(200);
    expect(((await probe.json()) as { data: { passed: boolean } }).data.passed).toBe(false);
    const evidence = await env.DB.prepare('SELECT passed FROM ai_probes WHERE config_version_id = ?1 AND purpose = ?2').bind(saved!.id, 'textEconomy').first<{ passed: number }>();
    expect(evidence?.passed).toBe(0);

    // 配置未变（apiKey 留空以复用已存密钥）但证据不足 → 仍禁止启用
    const enableBody = Object.fromEntries(Object.entries(body).map(([p, model]) => [p, { ...model, apiKey: '' }]));
    const enable = await SELF.fetch(`${BASE}/api/v1/admin/ai-config`, { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ ...enableBody, enabled: true }) });
    expect(enable.status).toBe(409);
  });
});
