import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ account: 'a', cached: new Map<string, unknown>() }));
vi.mock('../offline/store', () => ({
  offlineAccount: () => state.account ? { id: state.account } : null,
  readSnapshot: async (url: string, account = state.account) => state.cached.has(`${account}:${url}`) ? { data: state.cached.get(`${account}:${url}`) } : undefined,
  readCachedList: async () => undefined,
  writeSnapshot: async (url: string, data: unknown, account: string) => { state.cached.set(`${account}:${url}`, data); },
  operations: async () => [], rememberAccount: vi.fn((user: { id: string }) => { state.account = user.id; }), forgetAccount: vi.fn(),
}));
import { request } from './client';
import { collaborationApi } from './collaboration';
import { listTaskFiles } from '../pages/task-files-client';
const url = '/api/v1/projects/p/tasks';
beforeEach(() => { state.account = 'a'; state.cached.clear(); vi.stubGlobal('navigator', { onLine: true }); });
afterEach(() => vi.unstubAllGlobals());
it('returns cache immediately during a hanging network and coalesces background requests', async () => {
  state.cached.set(`a:${url}`, { items: [{ taskId: 'cached' }] });
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const updated = vi.fn(); window.addEventListener('offline-snapshot-updated', updated);
  expect(await request(url)).toEqual({ items: [{ taskId: 'cached' }] });
  await request(url); expect(fetcher).toHaveBeenCalledTimes(1);
  finish(Response.json({ data: { items: [{ taskId: 'updated' }] } }));
  await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(1));
  expect(state.cached.get(`a:${url}`)).toEqual({ items: [{ taskId: 'updated' }] });
  window.removeEventListener('offline-snapshot-updated', updated);
});
it('reads cached clarifications offline without fetching or exposing another account', async () => {
  const clarifications = '/api/v1/projects/p/ai/clarifications';
  state.cached.set(`a:${clarifications}`, { items: [] });
  vi.stubGlobal('navigator', { onLine: false }); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  expect(await request(clarifications)).toEqual({ items: [] });
  state.account = 'b';
  await expect(request(clarifications)).rejects.toMatchObject({ code: 'OFFLINE_NOT_CACHED' });
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not persist late responses after switching accounts', async () => {
  state.cached.set(`a:${url}`, { items: [] });
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  await request(url); state.account = 'b';
  finish(Response.json({ data: { items: [{ taskId: 'private-a' }] } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(state.cached.has(`b:${url}`)).toBe(false);
  expect(state.cached.get(`a:${url}`)).toEqual({ items: [] });
});
it('keeps visible cache and stays silent when background network refresh fails', async () => {
  state.cached.set(`a:${url}`, { items: [{ taskId: 'cached' }] });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
  const updated = vi.fn(); window.addEventListener('offline-snapshot-updated', updated);
  expect(await request(url)).toEqual({ items: [{ taskId: 'cached' }] });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(updated).not.toHaveBeenCalled();
  expect(state.cached.get(`a:${url}`)).toEqual({ items: [{ taskId: 'cached' }] });
  window.removeEventListener('offline-snapshot-updated', updated);
});
it('ignores a late session refresh after a deliberate account switch', async () => {
  const session = '/api/v1/auth/session';
  state.cached.set(`a:${session}`, { user: { id: 'a' } });
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const expired = vi.fn(); window.addEventListener('auth-expired', expired);
  await request(session); state.account = 'b';
  finish(Response.json({ data: { user: { id: 'a' } } }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(state.account).toBe('b'); expect(expired).not.toHaveBeenCalled();
  window.removeEventListener('auth-expired', expired);
});
it('reads fresh paginated task revisions when the online submission workspace requests them', async () => {
  state.cached.set(`a:${url}?limit=50`, { items: [{ taskId: 't', revision: 1 }], nextCursor: null });
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { items: [{ taskId: 't', revision: 2 }], nextCursor: null } }));
  vi.stubGlobal('fetch', fetcher);
  expect(await collaborationApi.tasks('p', { networkOnly: true })).toEqual({ items: [{ taskId: 't', revision: 2 }], nextCursor: null });
  expect(fetcher).toHaveBeenCalledOnce();
});
it('does not omit newly uploaded task files because of a cached empty attachment list', async () => {
  const fileUrl = '/api/v1/projects/p/tasks/t/files';
  state.cached.set(`a:${fileUrl}`, { items: [] });
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { items: [{ fileId: 'new-file', versionId: 'fixed-version' }] } }));
  vi.stubGlobal('fetch', fetcher);
  expect(await listTaskFiles('p', 't')).toEqual([{ fileId: 'new-file', versionId: 'fixed-version' }]);
  expect(fetcher).toHaveBeenCalledOnce();
});
it('keeps task lists and attachment lists readable from snapshots while explicitly offline', async () => {
  vi.stubGlobal('navigator', { onLine: false });
  state.cached.set(`a:${url}?limit=50`, { items: [{ taskId: 'cached-task', revision: 1 }], nextCursor: null });
  state.cached.set('a:/api/v1/projects/p/tasks/t/files', { items: [{ fileId: 'cached-file' }] });
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  expect(await collaborationApi.tasks('p', { networkOnly: false })).toEqual({ items: [{ taskId: 'cached-task', revision: 1 }], nextCursor: null });
  expect(await listTaskFiles('p', 't')).toEqual([{ fileId: 'cached-file' }]);
  expect(fetcher).not.toHaveBeenCalled();
});
