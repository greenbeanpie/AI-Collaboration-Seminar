import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ account: 'a', read: vi.fn() }));
vi.mock('../offline/store', () => ({ offlineAccount: () => state.account ? { id: state.account } : null, readSnapshot: state.read, readCachedList: vi.fn(), writeSnapshot: vi.fn(), forgetAccount: () => { state.account = ''; }, rememberAccount: vi.fn() }));
vi.mock('../offline/queue', () => ({ cacheable: () => true, offlineView: (_url: string, data: unknown) => data, seedLocalEntity: vi.fn(), queueOffline: vi.fn() }));
import { listAllItems, request } from './client';
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { state.account = 'a'; state.read.mockReset().mockResolvedValue({ data: { items: ['saved'] } }); vi.stubGlobal('navigator', { onLine: true }); vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Disconnected'))); });

it('falls back only for the opted-in display read while navigator still reports online', async () => {
  await expect(request('/projects/p/tasks', { networkOnly: true, offlineReadFallback: true })).resolves.toEqual({ items: ['saved'] });
  state.read.mockClear();
  await expect(request('/projects/p/tasks', { networkOnly: true })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  expect(state.read).not.toHaveBeenCalled();
  await expect(listAllItems('/projects/p/tasks', {}, { networkOnly: true, offlineReadFallback: true })).resolves.toEqual(['saved']);
});
it('never masks authorization errors, cancellation, account changes or writes', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'AUTH', message: 'Expired' } }, { status: 401 })));
  await expect(request('/projects/p/tasks', { networkOnly: true, offlineReadFallback: true })).rejects.toMatchObject({ status: 401 });
  expect(state.read).not.toHaveBeenCalled();
  state.account = 'a'; vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Cancelled', 'AbortError')));
  await expect(request('/projects/p/tasks', { networkOnly: true, offlineReadFallback: true })).rejects.toMatchObject({ name: 'AbortError' });
  vi.stubGlobal('fetch', vi.fn(async () => { state.account = 'b'; throw new TypeError('Disconnected'); }));
  await expect(request('/projects/p/tasks', { networkOnly: true, offlineReadFallback: true })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  await expect(request('/projects/p/tasks', { method: 'POST', networkOnly: true, offlineReadFallback: true })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  expect(state.read).not.toHaveBeenCalled();
});
