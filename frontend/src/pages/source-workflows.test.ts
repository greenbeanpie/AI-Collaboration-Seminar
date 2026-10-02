import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { listAllProjectItems } from './source-workflows';

afterEach(() => vi.unstubAllGlobals());

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data, requestId: 'server-request' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('project list pagination', () => {
  it('preserves the recycle filter on every page of file records', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ items: [{ fileId: 'file-1' }], nextCursor: 'cursor-1' }))
      .mockResolvedValueOnce(response({ items: [{ fileId: 'file-2' }], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    const items = await listAllProjectItems<'FileListResponse'>('project-1', '/files', 1, undefined, { deleted: true });
    expect(items.map(item => item.fileId)).toEqual(['file-1', 'file-2']);
    expect(fetchMock.mock.calls.every(([url]) => new URL(String(url), window.location.origin).searchParams.get('deleted') === 'true')).toBe(true);
  });

  it('loads every page before returning source records', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ items: [{ sourceId: 'source-1' }], nextCursor: 'cursor-1' }))
      .mockResolvedValueOnce(response({ items: [{ sourceId: 'source-2' }], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);

    const items = await listAllProjectItems<'SourceListResponse'>('project-1', '/sources', 1);

    expect(items.map((item) => item.sourceId)).toEqual(['source-1', 'source-2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('limit=1');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('cursor=cursor-1');
  });

  it('surfaces a missing cursor field instead of presenting an incomplete list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ items: [] })));

    await expect(listAllProjectItems<'SourceListResponse'>('project-1', '/sources', 100))
      .rejects.toMatchObject({ code: 'INVALID_PAGINATION' } satisfies Partial<ApiError>);
  });

  it('stops when the service repeats a cursor', async () => {
    const fetchMock = vi.fn().mockImplementation(() => response({ items: [], nextCursor: 'same-cursor' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listAllProjectItems<'SourceListResponse'>('project-1', '/sources', 100))
      .rejects.toMatchObject({ code: 'INVALID_PAGINATION' } satisfies Partial<ApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops at the bounded page count', async () => {
    const fetchMock = vi.fn().mockImplementation((input: string) => {
      const cursor = new URL(input, window.location.origin).searchParams.get('cursor');
      const nextIndex = cursor ? Number(cursor.replace('cursor-', '')) + 1 : 1;
      return response({ items: [], nextCursor: `cursor-${nextIndex}` });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(listAllProjectItems<'SourceListResponse'>('project-1', '/sources', 100))
      .rejects.toMatchObject({ code: 'PAGINATION_LIMIT' } satisfies Partial<ApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(200);
  });
});
