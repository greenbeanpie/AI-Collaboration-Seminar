import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeCreationFile, creationFileHash, newCreationFile, readCreationDraft, writeCreationDraft, type CreationDraft, type CreationFile } from './project-creation-workflow';

const response = (data: unknown) => Response.json({ data, requestId: 'fixture' });
const original = () => new File(['hello'], 'original.txt', { type: 'text/plain', lastModified: 1 });
const hash = createHash('sha256').update('hello').digest('hex');
const initialized = (changes: Partial<CreationFile> = {}): CreationFile => ({ ...newCreationFile(original()), fileId: 'f', sha256: hash, ...changes });
const source = { sourceId: 's', sourceVersionId: 'v' };
beforeEach(() => { sessionStorage.clear(); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

describe('creation file reconciliation', () => {
  it('verifies an accepted PUT with a lost response by exact private bytes, without another PUT or init', async () => {
    const calls: { url: string; method: string; credentials?: RequestCredentials; body?: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', credentials: init?.credentials, body: init?.body });
      if (init?.method === 'PUT') throw new TypeError('accepted response lost');
      if (String(url).endsWith('/content')) return new Response('hello');
      return response(source);
    }));
    const progress: CreationFile[] = [];
    const result = await completeCreationFile('p', initialized(), original(), file => progress.push(file), () => false);
    expect(result).toMatchObject({ fileId: 'f', uploadConfirmed: true, sourceId: 's', status: 'complete' });
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['PUT /api/v1/projects/p/files/f/content', 'GET /api/v1/projects/p/files/f/content', 'POST /api/v1/projects/p/sources']);
    expect(calls.every(call => call.credentials === 'include')).toBe(true);
    expect(progress.some(file => file.uploadAttempted && !file.uploadConfirmed)).toBe(true);
    expect(JSON.parse(String(calls[2].body))).toEqual({ kind: 'file', fileId: 'f', title: 'original.txt' });
  });

  it('reconciles an interrupted upload on retry before attempting any second PUT', async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => String(url).endsWith('/content') && !init?.method ? new Response('hello') : response(source));
    vi.stubGlobal('fetch', fetch);
    const result = await completeCreationFile('p', initialized({ uploadAttempted: true }), original(), vi.fn(), () => false);
    expect(result.sourceId).toBe('s'); expect(fetch.mock.calls).toHaveLength(2);
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/projects/p/files/f/content'); expect(fetch.mock.calls[0][1]?.method).toBeUndefined();
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('never treats a 404 verification as a successful upload and preserves the existing file ID on retry', async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method) return new Response(null, { status: 404 });
      if (init.method === 'PUT') return response({ fileId: 'f', sizeBytes: 5, sha256: hash, mimeDetected: 'text/plain' });
      expect(String(url)).toBe('/api/v1/projects/p/sources'); return response(source);
    });
    vi.stubGlobal('fetch', fetch);
    await completeCreationFile('p', initialized({ uploadAttempted: true }), original(), vi.fn(), () => false);
    expect(fetch.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['GET', 'PUT', 'POST']);
    expect(fetch.mock.calls[1][0]).toBe('/api/v1/projects/p/files/f/content');
  });

  it('refuses mismatched bytes after a lost PUT instead of linking an unrelated source', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') throw new TypeError('response lost');
      return new Response('other');
    });
    vi.stubGlobal('fetch', fetch);
    await expect(completeCreationFile('p', initialized(), original(), vi.fn(), () => false)).rejects.toThrow('已存储内容与所选原文件不同');
    expect(fetch.mock.calls).toHaveLength(2); expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('rejects a changed reselected file with the same name and size before sending any data', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const changed = new File(['other'], 'original.txt', { type: 'text/plain', lastModified: 1 });
    await expect(completeCreationFile('p', initialized({ uploadAttempted: true }), changed, vi.fn(), () => false)).rejects.toThrow('内容已变化');
    expect(fetch).not.toHaveBeenCalled(); expect(await creationFileHash(original())).toBe(hash);
  });

  it('rejects upload addresses outside the current project without transmitting original bytes', async () => {
    const fetch = vi.fn(async () => response({ fileId: 'f', upload: { method: 'PUT', url: '/api/v1/projects/another/files/f/content' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(completeCreationFile('p', newCreationFile(original()), original(), vi.fn(), () => false)).rejects.toThrow('不符合当前项目的上传地址');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not repeat successful source records and can link a confirmed upload without original bytes', async () => {
    const fetch = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => response(source)); vi.stubGlobal('fetch', fetch);
    await completeCreationFile('p', initialized({ uploadConfirmed: true, sourceId: 's', sourceVersionId: 'v', status: 'complete' }), undefined, vi.fn(), () => false);
    expect(fetch).not.toHaveBeenCalled();
    const record = initialized({ uploadConfirmed: true });
    await completeCreationFile('p', record, undefined, vi.fn(), () => false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Idempotency-Key')).toBe(record.sourceKey);
  });

  it('persists metadata and ownership only, never file bytes, and restores pending files with reselection guidance', () => {
    const draft: CreationDraft = { version: 1, userId: 'alice', createKey: 'stable-key', payload: { name: 'Project', description: '', deadlinePrecision: 'unknown', aiCollaborationEnabled: false }, createAttempted: true, project: { id: 'p', name: 'Project', revision: 2, status: 'active' }, files: [initialized({ uploadAttempted: true })], interrupted: false };
    expect(writeCreationDraft(draft)).toBe(true);
    const raw = sessionStorage.getItem(sessionStorage.key(0)!); expect(raw).not.toContain('hello'); expect(raw).not.toContain('rawBody');
    expect(readCreationDraft('alice')).toMatchObject({ createKey: 'stable-key', interrupted: true, project: { id: 'p', revision: 2 }, files: [{ fileId: 'f', status: 'needs_file', sourceKey: draft.files[0].sourceKey }] });
    expect(readCreationDraft('bob')).toBeNull();
    sessionStorage.setItem(sessionStorage.key(0)!, JSON.stringify({ ...draft, userId: 'bob' })); expect(readCreationDraft('alice')).toBeNull();
  });

  it('reports unavailable session storage without suppressing a usable live flow', () => {
    const draft: CreationDraft = { version: 1, userId: 'alice', createKey: 'stable-key', payload: { name: 'Project', description: '', deadlinePrecision: 'unknown', aiCollaborationEnabled: false }, createAttempted: true, project: null, files: [], interrupted: false };
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(writeCreationDraft(draft)).toBe(false);
  });
});
