import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { request } from '../api/client';
import { clearOfflineAccount, forgetAccount, rememberAccount } from './store';
import { prepareProject } from './sync';

const base = '/api/v1/projects/offline-data';
const material = { materialId: 'm', revision: 2, canEdit: true, currentVersion: { versionId: 'mv', doc: { type: 'doc', content: [] }, markdown: 'prepared body', attachments: [] } };
beforeEach(() => {
  rememberAccount({ id: 'offline-data-owner', username: 'owner', displayName: 'Owner', email: null, isAdmin: false, role: 'user' }, true);
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(async () => { await clearOfflineAccount('offline-data-owner'); forgetAccount(); vi.unstubAllGlobals(); });

it('prepares data workspace and editor reads from only the task screen, preserving archive filter isolation', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    const path = url.pathname;
    let data: unknown = { items: [], nextCursor: null };
    if (path === `${base}/tasks`) data = { items: [{ taskId: 't' }], nextCursor: null };
    if (path === `${base}/tasks/graph`) data = { items: [{ taskId: 't' }], graphRevision: 2, totals: { total: 1 } };
    if (path === `${base}/materials`) data = { items: [{ materialId: 'm', currentVersionId: 'mv' }], nextCursor: null };
    if (path === `${base}/materials/m`) data = material;
    if (path === `${base}/materials/m/versions/mv`) data = material.currentVersion;
    if (path === `${base}/resource-library`) data = { items: [{ resourceType: 'material', resourceId: 'm' }, { resourceType: 'source', resourceId: 's' }], nextCursor: null };
    if (path === `${base}/resource-library/material/m`) data = { resourceType: 'material', resourceId: 'm' };
    if (path === `${base}/resource-library/source/s`) data = { resourceType: 'source', resourceId: 's' };
    if (path === `${base}/sources`) data = { items: [{ sourceId: 's', currentVersionId: 'sv' }], nextCursor: null };
    if (path === `${base}/sources/s`) data = { sourceId: 's', currentVersionId: 'sv' };
    if (path === `${base}/sources/s/versions/sv`) data = { sourceVersionId: 'sv', pages: [] };
    if (path === `${base}/sources/s/versions/sv/processing`) data = { textStatus: 'ready' };
    if (path === `${base}/files`) data = { items: [{ fileId: 'f' }], nextCursor: null };
    return Response.json({ data });
  });
  vi.stubGlobal('fetch', fetcher);
  // Entering tasks must not be required to have mounted the data page or editor first.
  await request(`${base}/tasks`, { query: { limit: 50 } });
  await prepareProject('offline-data');
  vi.stubGlobal('navigator', { onLine: false }); fetcher.mockClear();
  const reads = [
    request(`${base}/resource-library`, { query: { archived: false, limit: 50 } }),
    request(`${base}/files`, { query: { limit: 50 } }),
    request(`${base}/files`, { query: { deleted: false, limit: 100 } }),
    request(`${base}/resource-library/material/m`), request(`${base}/resource-library/source/s`),
    request(`${base}/materials`, { query: { limit: 100 } }), request(`${base}/materials/m`),
    request(`${base}/materials/m/versions`, { query: { limit: 100 } }), request(`${base}/materials/m/versions/mv`),
    request(`${base}/comments`, { query: { targetType: 'material', targetId: 'm', limit: 100 } }),
    request(`${base}/tasks/graph`), request(`${base}/sources`, { query: { deleted: false, limit: 50 } }),
    request(`${base}/sources/s`), request(`${base}/sources/s/versions/sv`), request(`${base}/sources/s/versions/sv/processing`),
    request(`${base}/recording-sessions`, { query: { materialId: 'm', limit: 1 } }),
  ];
  const results = await Promise.all(reads);
  expect(results[6]).toMatchObject({ canEdit: true, currentVersion: { markdown: 'prepared body' } });
  expect(results[0]).toMatchObject({ items: [{ resourceId: 'm' }, { resourceId: 's' }] });
  await expect(request(`${base}/resource-library`, { query: { archived: true, limit: 50 } })).rejects.toMatchObject({ code: 'OFFLINE_NOT_CACHED' });
  expect(fetcher).not.toHaveBeenCalled();
});
