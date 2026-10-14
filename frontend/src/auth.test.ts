import { afterEach, expect, it, vi } from 'vitest';
import { adminRequest } from './auth';
import { ApiError } from './api/client';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('sends cookies without an empty bearer header and accepts only enveloped responses', async () => {
  const mock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ data: { ok: true }, requestId: 'fixture' })));
  vi.stubGlobal('fetch', mock);
  await expect(adminRequest('/api/v1/admin/account-invitations')).resolves.toEqual({ ok: true });
  expect(mock.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  expect(new Headers(mock.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
  mock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
  await expect(adminRequest('/api/v1/admin/account-invitations')).rejects.toThrow('服务返回了无法识别的响应');
});
it('preserves error code and trace for denied admin sessions', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: '需要系统管理员权限', retryable: false }, requestId: 'admin-trace' }), { status: 403 })));
  await expect(adminRequest('/api/v1/admin/account-invitations')).rejects.toMatchObject({ code: 'FORBIDDEN', requestId: 'admin-trace' });
  await expect(adminRequest('/api/v1/admin/account-invitations')).rejects.toBeInstanceOf(ApiError);
});
it('reports invalid operational token clearly and never persists it', async () => {
  const mock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 401 })); vi.stubGlobal('fetch', mock);
  await expect(adminRequest('/api/v1/admin/ai-config', { token: ' bad-token ' })).rejects.toThrow('管理员令牌无效或已失效');
  expect(new Headers(mock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer bad-token');
  expect(localStorage.length).toBe(0);
});

it('account management bypasses browser HTTP cache', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { items: [], nextCursor: null } }), { status: 200, headers: { 'content-type': 'application/json' } })));
  await adminRequest('/api/v1/admin/accounts?cursor=fixture');
  expect(fetch).toHaveBeenCalledWith('/api/v1/admin/accounts?cursor=fixture', expect.objectContaining({ cache: 'no-store' }));
});

it('bounds short mutations and labels the result unknown rather than failed', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_path: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))));
  const pending = expect(adminRequest('/api/v1/admin/resource-policy', { method: 'PUT', body: {} })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', details: { outcomeUnknown: true } });
  await vi.advanceTimersByTimeAsync(30_000); await pending;
});

it('cancels the caller wait without returning a late response', async () => {
  vi.stubGlobal('fetch', vi.fn((_path: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)))));
  const controller = new AbortController(), reason = new DOMException('页面已离开', 'AbortError');
  const pending = expect(adminRequest('/api/v1/admin/resource-policy', { signal: controller.signal })).rejects.toBe(reason);
  controller.abort(reason); await pending;
});
