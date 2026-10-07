import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { downloadSourcePdf, listAllProjectItems, readTrackedSourceJobs, writeTrackedSourceJobs, sourceFileId, rememberSourceFile } from './source-workflows';
import { rememberAccount, forgetAccount } from '../offline/store';
import type { User } from '../api/types';

afterEach(() => { vi.unstubAllGlobals(); forgetAccount(); sessionStorage.clear(); });

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

it('preserves binary download failure reasons even without correlation metadata', async () => {
  const message = '来源不存在或无权读取\n原始详情';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({error:{message,code:'INTERNAL',retryable:false}},{status:500})));
  await expect(downloadSourcePdf('project','file')).rejects.toMatchObject({message,code:'INTERNAL',status:500});
});


describe('account-isolated source tracking', () => {
  const job = { jobId: 'j', sourceId: 's', sourceVersionId: 'v', sourceTitle: '私有资料', fileId: 'f' };
  it('never reads another account jobs or source-file associations in the same project', () => {
    rememberAccount({ id: 'account-a' } as User);
    writeTrackedSourceJobs('project', [job]);
    rememberSourceFile('project', 'v', 'f');
    expect(sessionStorage.getItem('ai-office:source-jobs:account-a:project')).not.toBeNull();
    expect(sessionStorage.getItem('ai-office:source-files:account-a:project')).not.toBeNull();
    rememberAccount({ id: 'account-b' } as User);
    expect(readTrackedSourceJobs('project')).toEqual([]);
    expect(sourceFileId('project', 'v')).toBeNull();
    writeTrackedSourceJobs('project', [{ ...job, jobId: 'b-job' }]);
    rememberSourceFile('project', 'v', 'b-file');
    rememberAccount({ id: 'account-a' } as User);
    expect(readTrackedSourceJobs('project')).toEqual([job]);
    expect(sourceFileId('project', 'v')).toBe('f');
  });
  it('ignores legacy cache entries with unknown owners and separates anonymous tracking', () => {
    sessionStorage.setItem('ai-office:v1:project:source-jobs', JSON.stringify([job]));
    sessionStorage.setItem('ai-office:v1:project:source-files', JSON.stringify({ v: 'f' }));
    forgetAccount();
    expect(readTrackedSourceJobs('project')).toEqual([]);
    expect(sourceFileId('project', 'v')).toBeNull();
    writeTrackedSourceJobs('project', [job]);
    rememberSourceFile('project', 'v', 'anonymous-file');
    expect(sessionStorage.getItem('ai-office:source-jobs:anonymous:project')).not.toBeNull();
    rememberAccount({ id: 'account-a' } as User);
    expect(readTrackedSourceJobs('project')).toEqual([]);
    expect(sourceFileId('project', 'v')).toBeNull();
  });
});
