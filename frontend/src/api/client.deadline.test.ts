import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ account: 'a', read: vi.fn(), forget: vi.fn(), view: vi.fn() }));
vi.mock('../offline/store', async (original) => ({ ...await original<typeof import('../offline/store')>(),
  offlineAccount: () => state.account ? { id: state.account } : null,
  readSnapshot: state.read, readCachedList: vi.fn(), writeSnapshot: vi.fn(),
  forgetAccount: state.forget, rememberAccount: vi.fn((user: { id: string }) => { state.account = user.id; }),
}));
vi.mock('../offline/queue', () => ({ cacheable: () => true, offlineView: state.view, seedLocalEntity: vi.fn(), queueOffline: vi.fn() }));
import { request } from './client';
import { writeSnapshot } from '../offline/store';

beforeEach(() => {
  state.account = 'a'; state.read.mockReset(); state.forget.mockReset();
  state.view.mockReset().mockImplementation((_url: string, value: unknown) => value); vi.mocked(writeSnapshot).mockReset();
  vi.useFakeTimers(); vi.stubGlobal('navigator', { onLine: true });
});
it('rejects an account switch while a project response is being saved to IndexedDB', async () => {
  let complete!: () => void;
  vi.mocked(writeSnapshot).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { private: 'a' } })));
  const pending = request('/projects/p/tasks', { networkOnly: true });
  await vi.advanceTimersByTimeAsync(0);
  state.account = 'b'; complete();
  await expect(pending).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
});
it('rejects an account switch while applying local intent overlays to a project response', async () => {
  let complete!: (value: unknown) => void;
  state.view.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { private: 'a' } })));
  const pending = request('/projects/p/tasks');
  await vi.advanceTimersByTimeAsync(0);
  state.account = 'b'; complete({ private: 'a' });
  await expect(pending).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
});
it('allows the first session response to establish its remembered offline identity', async () => {
  state.account = '';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { user: { id: 'new' } } })));
  await expect(request('/auth/session')).resolves.toEqual({ user: { id: 'new' } });
  expect(state.account).toBe('new');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function hangingTransport() {
  return vi.fn((_url: RequestInfo | URL, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
}
it('ends an uncached GET when the network reports online but never responds', async () => {
  vi.stubGlobal('fetch', hangingTransport());
  const outcome = expect(request('/projects/p/tasks', { networkOnly: true })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', status: 0 });
  await vi.advanceTimersByTimeAsync(15_000); await outcome;
});
it('bounds authentication and explicitly classified short writes at thirty seconds without promising an offline queue', async () => {
  vi.stubGlobal('fetch', hangingTransport());
  const outcome = expect(request('/auth/register', { method: 'POST', networkOnly: true, body: {} })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', details: { outcomeUnknown: true } });
  await vi.advanceTimersByTimeAsync(30_000); await outcome;
  const classified = expect(request('/projects/p/short-control', { method: 'PATCH', shortControl: true, body: {} })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(30_000); await classified;
});
it('covers a stalled response body with the same read deadline', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, options?: RequestInit) => {
    const response = Response.json({ data: { items: [] } });
    vi.spyOn(response, 'text').mockImplementation(() => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));
    return response;
  }));
  const outcome = expect(request('/projects/p/tasks', { networkOnly: true })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(15_000); await outcome;
});
it('uses a saved display copy after a deadline but preserves caller cancellation', async () => {
  state.read.mockResolvedValue({ data: { items: ['saved'] } }); vi.stubGlobal('fetch', hangingTransport());
  const pending = request('/projects/p/tasks', { networkOnly: true, offlineReadFallback: true });
  await vi.advanceTimersByTimeAsync(15_000); expect(await pending).toEqual({ items: ['saved'] });
  state.read.mockClear();
  const controller = new AbortController();
  const cancelled = expect(request('/projects/p/tasks', { networkOnly: true, offlineReadFallback: true, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await cancelled; expect(state.read).not.toHaveBeenCalled();
});
it('keeps slow writes outside the GET deadline and bounds an opted-in sync write', async () => {
  let complete!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })));
  const slowWrite = request('/projects/p/ai/action', { method: 'POST', body: {} });
  await vi.advanceTimersByTimeAsync(60_000);
  complete(Response.json({ data: { saved: true } })); await expect(slowWrite).resolves.toEqual({ saved: true });
  const fetcher = hangingTransport(); vi.stubGlobal('fetch', fetcher);
  const sync = expect(request('/projects/p/offline-sync', { method: 'POST', networkOnly: true, timeoutMs: 90_000, idempotencyKey: 'same-intent', body: {} })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  await vi.advanceTimersByTimeAsync(90_000); await sync;
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('Idempotency-Key')).toBe('same-intent');
});
it('rejects an old account response before an old 401 can clear the new session', async () => {
  let complete!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })));
  const pending = request('/projects/p/tasks', { networkOnly: true });
  state.account = 'b'; complete(Response.json({ error: { message: 'expired' } }, { status: 401 }));
  await expect(pending).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
  expect(state.forget).not.toHaveBeenCalled();
});
it('rejects an account switch while reading the response body', async () => {
  let complete!: (body: string) => void;
  const response = Response.json({ data: {} });
  vi.spyOn(response, 'text').mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  vi.stubGlobal('fetch', vi.fn(async () => response));
  const pending = request('/projects/p/tasks', { networkOnly: true });
  await vi.advanceTimersByTimeAsync(0);
  state.account = 'b'; complete(JSON.stringify({ data: { private: 'a' } }));
  await expect(pending).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
});
