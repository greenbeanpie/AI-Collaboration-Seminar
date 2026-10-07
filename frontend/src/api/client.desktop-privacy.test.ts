import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ account: 'a', resolve: undefined as undefined | ((value: boolean) => void), queued: vi.fn() }));
vi.mock('../desktop/bridge', () => ({ isDesktop: () => true }));
vi.mock('../desktop/attachments', () => ({ hasPendingTaskFiles: () => new Promise<boolean>(resolve => { state.resolve = resolve; }) }));
vi.mock('../offline/store', () => ({ offlineAccount: () => ({ id: state.account }), readSnapshot: vi.fn(), readCachedList: vi.fn(), writeSnapshot: vi.fn(), rememberAccount: vi.fn(), forgetAccount: vi.fn() }));
vi.mock('../offline/queue', () => ({ queueOffline: state.queued, cacheable: () => false, offlineView: vi.fn(), seedLocalEntity: vi.fn() }));
import { request } from './client';
beforeEach(() => { state.account = 'a'; state.resolve = undefined; state.queued.mockReset(); vi.stubGlobal('navigator', { onLine: true }); });
it('does not queue a desktop submission under another account after attachment lookup', async () => {
  const pending = request('/projects/p/tasks/t/submissions', { method: 'POST', body: { body: 'private result' } });
  await vi.waitFor(() => expect(state.resolve).toBeDefined());
  state.account = 'b'; state.resolve!(true);
  await expect(pending).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
  expect(state.queued).not.toHaveBeenCalled();
});
it('does not queue an old submission after device clearing and same-account login', async () => {
  const pending = request('/projects/p/tasks/t/submissions', { method: 'POST', body: { body: 'private result' } });
  await vi.waitFor(() => expect(state.resolve).toBeDefined());
  window.dispatchEvent(new CustomEvent('account-device-cleared', { detail: { accountId: 'a' } }));
  state.resolve!(true);
  await expect(pending).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
  expect(state.queued).not.toHaveBeenCalled();
});
