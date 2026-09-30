import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, listAllItems, request } from './client';

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

  it('loads every cursor page before reporting a complete list', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      calls.push(url.searchParams.get('cursor') ?? 'first-page');
      const page = url.searchParams.has('cursor')
        ? { items: [{ eventId: 'event-2', type: 'task.updated', actorType: 'user', actorId: 'user-1', entityType: 'task', entityId: 'task-2', payload: {}, occurredAt: '2026-01-02T00:00:00Z' }], nextCursor: null }
        : { items: [{ eventId: 'event-1', type: 'task.created', actorType: 'user', actorId: 'user-1', entityType: 'task', entityId: 'task-1', payload: {}, occurredAt: '2026-01-01T00:00:00Z' }], nextCursor: 'page-two' };
      return new Response(JSON.stringify({ data: page, requestId: 'page-request' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));

    const events = await listAllItems<'EventListResponse'>('/api/v1/projects/project-1/events', { limit: 1 }, { requireNextCursor: true });

    expect(events.map((event) => event.eventId)).toEqual(['event-1', 'event-2']);
    expect(calls).toEqual(['first-page', 'page-two']);
  });

  it('stops on a repeated cursor instead of presenting duplicate data as complete', async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify({
      data: { items: [], nextCursor: 'same-cursor' }, requestId: 'page-request',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listAllItems<'EventListResponse'>('/api/v1/projects/project-1/events', {}, { requireNextCursor: true })).rejects.toMatchObject({ code: 'INVALID_PAGINATION' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a cursor-paged API response that omits nextCursor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Response(JSON.stringify({
      data: { items: [] }, requestId: 'page-request',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    await expect(listAllItems<'EventListResponse'>('/api/v1/projects/project-1/events', {}, { requireNextCursor: true }))
      .rejects.toMatchObject({ code: 'INVALID_PAGINATION' });
  });

  it('reuses an explicit idempotency key across a retried mutation', async () => {
    const fetchMock = vi.fn().mockImplementation(() => new Response(JSON.stringify({ data: { jobId: 'job-1' }, requestId: 'job-request' }), {
      status: 202, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const intent = { idempotencyKey: 'one-user-intent' };

    await api.post<'JobRetryResponse'>('/api/v1/projects/project-1/assignment-suggestions', { taskIds: ['task-1'] }, intent);
    await api.post<'JobRetryResponse'>('/api/v1/projects/project-1/assignment-suggestions', { taskIds: ['task-1'] }, intent);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, options]) => new Headers(options?.headers).get('Idempotency-Key'))).toEqual(['one-user-intent', 'one-user-intent']);
  });
});
