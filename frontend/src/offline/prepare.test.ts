import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ account: 'a' }));
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, request: vi.fn() };
});
vi.mock('./store', () => ({ offlineAccount: () => ({ id: state.account }), writeSnapshot: vi.fn(), readSnapshot: vi.fn() }));
import { ApiError, request } from '../api/client';
import { readSnapshot, writeSnapshot } from './store';
import { ensureProjectPrepared, prepareProject } from './sync';
beforeEach(() => { state.account = 'a'; vi.resetAllMocks(); });
afterEach(() => vi.unstubAllGlobals());
it('prepares task data and supporting pages even when an independent endpoint fails', async () => {
  vi.mocked(request).mockImplementation(async path => {
    if (path.endsWith('/sources')) throw new Error('sources unavailable');
    return { items: [], nextCursor: null } as never;
  });
  await expect(prepareProject('p')).rejects.toThrow('sources unavailable');
  expect(vi.mocked(request).mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
    '/api/v1/projects/p/tasks', '/api/v1/projects/p/ai/clarifications', '/api/v1/projects/p/collaboration/proposals', '/api/v1/projects/p/members/me',
  ]));
  expect(writeSnapshot).not.toHaveBeenCalled();
});
it.each(['automatic', 'explicit'] as const)('does not prepare the old project under a new account after a %s storage check', async mode => {
  let complete!: (value: boolean) => void;
  vi.stubGlobal('navigator', { onLine: true, storage: { persisted: () => new Promise(resolve => { complete = resolve; }) } });
  const pending = mode === 'explicit' ? prepareProject('p') : ensureProjectPrepared('p');
  await vi.waitFor(() => expect(complete).toBeDefined());
  state.account = 'b'; complete(false);
  await expect(pending).rejects.toThrow('账户或本机数据已变化');
  expect(request).not.toHaveBeenCalled(); expect(writeSnapshot).not.toHaveBeenCalled();
});
it('stops a delayed preparation after clearing and logging back into the same account', async () => {
  let complete!: (value: boolean) => void;
  vi.stubGlobal('navigator', { onLine: true, storage: { persisted: () => new Promise(resolve => { complete = resolve; }) } });
  const pending = prepareProject('p');
  await vi.waitFor(() => expect(complete).toBeDefined());
  window.dispatchEvent(new CustomEvent('account-device-cleared', { detail: { accountId: 'a' } }));
  complete(false);
  await expect(pending).rejects.toThrow('账户或本机数据已变化'); expect(request).not.toHaveBeenCalled();
});
it('skips automatic preparation while a complete snapshot is fresh but forces an explicit download', async () => {
  vi.mocked(readSnapshot).mockResolvedValue({ data: { preparedAt: new Date().toISOString(), coverageVersion: 3 } } as never);
  vi.mocked(request).mockResolvedValue({ items: [], nextCursor: null } as never);
  expect(await ensureProjectPrepared('p')).toBe(false); expect(request).not.toHaveBeenCalled();
  await prepareProject('p'); expect(request).toHaveBeenCalled();
  expect(writeSnapshot).toHaveBeenCalledWith('/api/v1/projects/p/offline-ready', expect.any(Object), 'a');
});
it('prepares complete submission and task-file metadata cursor chains instead of only the first screen', async () => {
  vi.mocked(request).mockImplementation(async (path, options) => {
    if (path === '/api/v1/projects/p/tasks') return { items: [{ taskId: 't' }], nextCursor: null } as never;
    if (path.endsWith('/submissions') || path.endsWith('/files')) return { items: [{ id: options?.query?.cursor ? 'second' : 'first' }], nextCursor: options?.query?.cursor ? null : 'next' } as never;
    return { items: [], nextCursor: null } as never;
  });
  await prepareProject('p');
  for (const path of ['/api/v1/projects/p/tasks/t/submissions', '/api/v1/projects/p/tasks/t/files']) {
    expect(request).toHaveBeenCalledWith(path, expect.objectContaining({ query: { limit: 100, cursor: null }, requireOfflinePersistence: true }));
    expect(request).toHaveBeenCalledWith(path, expect.objectContaining({ query: { limit: 100, cursor: 'next' } }));
  }
  expect(writeSnapshot).toHaveBeenCalledWith('/api/v1/projects/p/offline-ready', expect.objectContaining({ coverageVersion: 3 }), 'a');
});
it('refreshes an old preparation marker even if its time is recent', async () => {
  vi.mocked(readSnapshot).mockResolvedValue({ data: { preparedAt: new Date().toISOString() } } as never);
  vi.mocked(request).mockResolvedValue({ items: [], nextCursor: null } as never);
  expect(await ensureProjectPrepared('p')).toBe(true); expect(request).toHaveBeenCalled();
});
it('prepares automatically again after freshness expires and writes a marker only on success', async () => {
  vi.mocked(readSnapshot).mockResolvedValue({ data: { preparedAt: new Date(Date.now() - 11 * 60_000).toISOString() } } as never);
  vi.mocked(request).mockResolvedValue({ items: [], nextCursor: null } as never);
  expect(await ensureProjectPrepared('p')).toBe(true);
  expect(writeSnapshot).toHaveBeenCalledOnce();
});
it('coalesces automatic triggers during one complete project preparation', async () => {
  let complete!: (value: never) => void;
  vi.mocked(request).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; })).mockResolvedValue({ items: [], nextCursor: null } as never);
  const first = ensureProjectPrepared('p');
  await vi.waitFor(() => expect(complete).toBeDefined());
  const second = ensureProjectPrepared('p');
  complete({ items: [], nextCursor: null } as never);
  expect(await first).toBe(true); expect(await second).toBe(false);
  expect(vi.mocked(request).mock.calls.filter(([path]) => path === '/api/v1/projects/p/tasks')).toHaveLength(1);
});
it('allows members to prepare core data when owner-only reads are denied', async () => {
  vi.mocked(request).mockImplementation(async path => {
    if (path.endsWith('/ai/clarifications') || path.endsWith('/collaboration/proposals')) throw new ApiError(403, { requestId: 'fixture', error: { message: 'denied', code: 'FORBIDDEN', retryable: false } });
    return { items: [], nextCursor: null } as never;
  });
  await prepareProject('p');
  expect(writeSnapshot).toHaveBeenCalledWith('/api/v1/projects/p/offline-ready', expect.any(Object), 'a');
});
