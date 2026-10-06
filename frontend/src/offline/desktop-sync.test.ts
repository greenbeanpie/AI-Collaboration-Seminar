import { beforeEach, expect, it, vi } from 'vitest';
import type { PendingOperation } from './store';
const state = vi.hoisted(() => ({ pendingFiles: true, rows: [] as PendingOperation[], request: vi.fn() }));
vi.mock('../desktop/bridge', () => ({ isDesktop: () => true }));
vi.mock('../desktop/attachments', () => ({ hasPendingTaskFiles: async () => state.pendingFiles }));
vi.mock('../api/client', () => ({ request: state.request, ApiError: class extends Error {} }));
vi.mock('./store', () => ({
  offlineAccount: () => ({ id: 'account-a' }), operations: async () => state.rows,
  snapshots: async () => [], readSnapshot: async () => undefined, writeSnapshot: vi.fn(),
  putOperation: async (row: PendingOperation) => { state.rows = state.rows.map(r => r.key === row.key ? structuredClone(row) : r); },
  removeOperation: async (key: string) => { state.rows = state.rows.filter(r => r.key !== key); },
}));
import { synchronizeOffline } from './sync';

beforeEach(() => {
  vi.stubGlobal('navigator', { onLine: true }); state.request.mockReset(); state.pendingFiles = true;
  state.rows = [{ key: 'fixed-intent', accountId: 'account-a', projectId: 'p', url: '/api/v1/projects/p/tasks/t/submissions', method: 'POST', body: { expectedRevision: 3, body: 'result', materialVersionIds: [] }, localId: 'local', base: null, createdAt: '2026-10-06T00:00:00Z', state: 'pending' }];
  state.request.mockImplementation(async (url: string) => url === '/auth/session' ? { user: { id: 'account-a' } } : url.endsWith('/files') ? { items: [{ versionId: 'new-upload-version', archivedAt: null, materialArchivedAt: null }, { versionId: 'archived', archivedAt: 'now' }] } : { submissionId: 'server-submission' });
});
it('keeps submission local until native attachments are uploaded and registered', async () => {
  await synchronizeOffline();
  expect(state.request).toHaveBeenCalledTimes(1); expect(state.rows).toHaveLength(1);
  state.pendingFiles = false; await synchronizeOffline();
  expect(state.request).toHaveBeenCalledWith('/projects/p/offline-sync', expect.objectContaining({ idempotencyKey: 'fixed-intent', body: expect.objectContaining({ body: expect.objectContaining({ expectedRevision: 3, materialVersionIds: ['new-upload-version'] }) }) }));
  expect(state.rows).toHaveLength(0);
});
it('persists resolved attachment versions before sending and preserves them after uncertain failure', async () => {
  state.pendingFiles = false;
  state.request.mockImplementation(async (url: string) => {
    if (url === '/auth/session') return { user: { id: 'account-a' } };
    if (url.endsWith('/files')) return { items: [{ versionId: 'fixed' }] };
    expect(state.rows[0]?.desktopAttachmentsResolved).toBe(true);
    throw new Error('network interrupted');
  });
  await expect(synchronizeOffline()).rejects.toThrow('network interrupted');
  expect(state.rows[0]?.body.materialVersionIds).toEqual(['fixed']);
  state.request.mockClear();
  state.request.mockImplementation(async (url: string) => url === '/auth/session' ? { user: { id: 'account-a' } } : { submissionId: 'server' });
  await synchronizeOffline();
  expect(state.request.mock.calls.some(([url]) => String(url).endsWith('/files'))).toBe(false);
  expect(state.rows).toHaveLength(0);
});
