import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, request: vi.fn() };
});
vi.mock('./store', () => ({ offlineAccount: () => ({ id: 'a' }), writeSnapshot: vi.fn() }));
import { ApiError, request } from '../api/client';
import { writeSnapshot } from './store';
import { prepareProject } from './sync';
beforeEach(() => vi.resetAllMocks());
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
it('allows members to prepare core data when owner-only reads are denied', async () => {
  vi.mocked(request).mockImplementation(async path => {
    if (path.endsWith('/ai/clarifications') || path.endsWith('/collaboration/proposals')) throw new ApiError(403, { requestId: 'fixture', error: { message: 'denied', code: 'FORBIDDEN', retryable: false } });
    return { items: [], nextCursor: null } as never;
  });
  await prepareProject('p');
  expect(writeSnapshot).toHaveBeenCalledWith('/api/v1/projects/p/offline-ready', expect.any(Object), 'a');
});
