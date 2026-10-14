import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from './client';
import { clearOfflineAccount, rememberAccount, readSnapshot, writeSnapshot, projectRevoked, restoreProjectAccess, revokeProjectAccess } from '../offline/store';
const user = { id: 'access-client', username: 'access', displayName: 'Access', email: null, isAdmin: false, role: 'user' as const };
const denied = (status: number) => Response.json({ error: { code: 'PERMISSION_DENIED', message: '拒绝请求', retryable: false } }, { status });
afterEach(async () => { await clearOfflineAccount(user.id); localStorage.clear(); vi.unstubAllGlobals(); });
it('clears a visible snapshot when background validation confirms root refusal', async () => {
  rememberAccount(user, true); await writeSnapshot('/api/v1/projects/p', { private: true });
  vi.stubGlobal('fetch', vi.fn(async () => denied(403)));
  expect(await request('/projects/p')).toEqual({ private: true });
  await vi.waitFor(() => expect(projectRevoked(user.id, 'p')).toBe(true));
  expect(await readSnapshot('/api/v1/projects/p')).toBeUndefined();
});
it('a deleted subresource or forbidden write does not revoke a still-accessible project', async () => {
  rememberAccount(user, true); await writeSnapshot('/api/v1/projects/p', { name: 'accessible' });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/v1/projects/p' ? Response.json({ data: { name: 'accessible', permissions: { teamManage: false } } }) : denied(404)));
  await expect(request('/projects/p/materials/deleted', { networkOnly: true })).rejects.toMatchObject({ status: 404 });
  expect(projectRevoked(user.id, 'p')).toBe(false); expect(await readSnapshot('/api/v1/projects/p')).toBeTruthy();
});
it('rejects late successful responses even if access was restored after the revocation', async () => {
  rememberAccount(user, true);
  let complete!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })));
  const pending = request('/projects/p/tasks', { networkOnly: true });
  const outcome = expect(pending).rejects.toMatchObject({ code: 'PROJECT_ACCESS_CHANGED' });
  await revokeProjectAccess(user.id, 'p'); restoreProjectAccess(user.id, 'p');
  complete(Response.json({ data: { old: true } })); await outcome;
  expect(await readSnapshot('/api/v1/projects/p/tasks')).toBeUndefined();
});
