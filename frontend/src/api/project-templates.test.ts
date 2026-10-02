import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { projectTemplateApi } from './project-templates';
import { creationFileHash } from '../pages/project-creation-workflow';
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });
it('reuses the same private file ID after a lost upload and reconciliation response, including a reselected File', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const file = new File(['original bytes'], 'original.txt', { type: 'text/plain' }); const sha256 = await creationFileHash(file);
  const paths: string[] = []; let first = true;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'PUT') { const parsed = new URL(String(url), 'http://localhost'); paths.push(parsed.pathname); if (first) { first = false; throw new Error('uploaded but response lost'); } return Response.json({ requestId: 'replay', data: { revision: 2, files: [{ id: parsed.pathname.split('/').at(-1), name: file.name, sizeBytes: file.size, sha256 }] } }); }
    throw new Error('reconciliation unavailable');
  }));
  await expect(projectTemplateApi.upload('owner', 'draft', 1, file)).rejects.toThrow();
  const reselected = new File(['original bytes'], 'original.txt', { type: 'text/plain' });
  const response = await projectTemplateApi.upload('owner', 'draft', 1, reselected);
  expect(paths).toHaveLength(2); expect(new Set(paths).size).toBe(1); expect(response.files).toHaveLength(1); expect(response.revision).toBe(2);
});
