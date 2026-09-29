import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('GET /api/v1/health', () => {
  it('返回存活状态并携带 requestId', async () => {
    const res = await SELF.fetch('https://example.com/api/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; environment: string; time: string }; requestId: string };
    expect(body.data.status).toBe('ok');
    expect(body.data.environment).toBe('local');
    expect(typeof body.data.time).toBe('string');
    const headerId = res.headers.get('x-request-id');
    expect(headerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.requestId).toBe(headerId);
  });
});

describe('GET /api/v1/health/deps', () => {
  it('报告 D1 与 R2 依赖状态且不触发付费调用', async () => {
    const res = await SELF.fetch('https://example.com/api/v1/health/deps');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { d1: string; r2: string } };
    expect(['ok', 'error']).toContain(body.data.d1);
    expect(['ok', 'error']).toContain(body.data.r2);
  });
});
