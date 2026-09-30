import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('API client', () => {
  it('keeps requests same-origin and carries the session cookie', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: { user: { id: 'user-1', email: 'member@example.com', displayName: '成员' } },
      requestId: 'server-id',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const data = await request<'AuthSessionGetResponse'>('/api/v1/auth/session');

    expect(data.user.email).toBe('member@example.com');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/auth/session');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: 'include', method: 'GET' });
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('X-Request-Id')).toBeTruthy();
  });

  it('surfaces API failures instead of supplying local demo data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'AI_UNAVAILABLE', message: '模型服务尚未启用', retryable: true },
      requestId: 'trace-123',
    }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'trace-123' } })));

    await expect(request<'AgentSessionCreateResponse'>('/api/v1/projects/project-1/agent-sessions', {
      method: 'POST', body: { mode: 'do' },
    })).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', status: 503, requestId: 'trace-123' });
  });
});
