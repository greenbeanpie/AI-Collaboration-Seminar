import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('契约层公共行为', () => {
  it('未知路由返回统一 ApiFailure 结构', async () => {
    const res = await SELF.fetch('https://example.com/api/v1/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; message: string; retryable: boolean };
      requestId: string;
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.retryable).toBe(false);
    expect(typeof body.error.message).toBe('string');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('透传前端携带的合法 X-Request-Id', async () => {
    const id = '123e4567-e89b-42d3-a456-426614174000';
    const res = await SELF.fetch('https://example.com/api/v1/health', {
      headers: { 'x-request-id': id },
    });
    expect(res.headers.get('x-request-id')).toBe(id);
  });

  it('拒绝非法格式的 X-Request-Id 并重新生成', async () => {
    const res = await SELF.fetch('https://example.com/api/v1/health', {
      headers: { 'x-request-id': '../etc/passwd' },
    });
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('提供 OpenAPI 3.1 契约文档', async () => {
    const res = await SELF.fetch('https://example.com/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi.startsWith('3.1')).toBe(true);
    expect(Object.keys(doc.paths)).toContain('/api/v1/health');
    expect(Object.keys(doc.paths)).toContain('/api/v1/capabilities');
  });
});
