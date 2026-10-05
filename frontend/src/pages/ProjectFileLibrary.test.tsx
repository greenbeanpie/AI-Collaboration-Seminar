import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { DataOf } from '../api/types';
import { ApiError } from '../api/client';
import { cancelPageDialog } from '../dialogs/dialog-service';
import { ProjectFileLibrary } from './ProjectFileLibrary';
import { SourcesPage } from './SourcesPage';
import { readTrackedSourceJobs, writeTrackedSourceJobs } from './source-workflows';

const mocked = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('../api/client', async original => ({ ...await original<typeof import('../api/client')>(), api: mocked }));
vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p' }) }));
vi.mock('./SourceFullText', () => ({ SourceFullText: () => null }));
vi.mock('./SourceProcessingCard', () => ({ SourceProcessingCard: () => null }));

type ProjectFile = DataOf<'FileListResponse'>['items'][number];
type Source = DataOf<'SourceListResponse'>['items'][number];
const now = '2026-10-02T00:00:00.000Z';
const pendingFile: ProjectFile = { fileId: 'f', name: '未完成.pdf', status: 'pending', sizeBytes: null, createdAt: now, deletedAt: null, lifecycleVersion: 1, canDelete: true, sourceIds: [] };
let files: ProjectFile[];
let sources: Source[];

function mount(page = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onChanged = vi.fn();
  const rendered = render(<MemoryRouter><QueryClientProvider client={client}>{page ? <SourcesPage /> : <ProjectFileLibrary projectId="p" pageSize={2} onChanged={onChanged} />}</QueryClientProvider></MemoryRouter>);
  return { client, onChanged, ...rendered };
}

beforeEach(() => {
  sessionStorage.clear();
  files = [{ ...pendingFile }]; sources = [];
  mocked.get.mockReset(); mocked.post.mockReset(); mocked.delete.mockReset();
  mocked.get.mockImplementation(async (path: string, query?: { deleted?: boolean }) => {
    if (path.endsWith('/capabilities')) return { features: { aiEnabled: true, webFetch: true }, limits: { listMaxPageSize: 2, maxFileBytes: 1_000_000, maxPdfPages: 100 } };
    if (path.endsWith('/files')) return { items: files.filter(file => Boolean(file.deletedAt) === Boolean(query?.deleted)), nextCursor: null };
    if (path.endsWith('/sources')) return { items: sources.filter(source => Boolean(source.deletedAt) === Boolean(query?.deleted)), nextCursor: null };
    if (path.startsWith('/api/v1/jobs/')) return { jobId: 'old-job', status: 'failed', result: null, error: { message: '处理失败' } };
    throw new Error(`Unexpected GET ${path}`);
  });
  mocked.delete.mockImplementation(async (path: string) => {
    const id = path.split('/').at(-1);
    const file = files.find(file => file.fileId === id)!;
    file.deletedAt = now; file.lifecycleVersion += 1;
    sources = sources.map(source => file.sourceIds.includes(source.sourceId) ? { ...source, deletedAt: now, lifecycleVersion: source.lifecycleVersion + 1 } : source);
    return { fileId: file.fileId, deletedAt: file.deletedAt, lifecycleVersion: file.lifecycleVersion, affectedSourceIds: file.sourceIds };
  });
  mocked.post.mockImplementation(async (path: string) => {
    if (!path.endsWith('/restore')) throw new Error(`Unexpected POST ${path}`);
    const file = files.find(file => path.includes(`/files/${file.fileId}/`));
    if (file) {
      file.deletedAt = null; file.lifecycleVersion += 1;
      sources = sources.map(source => file.sourceIds.includes(source.sourceId) ? { ...source, deletedAt: null, lifecycleVersion: source.lifecycleVersion + 1 } : source);
      return { fileId: file.fileId, deletedAt: null, lifecycleVersion: file.lifecycleVersion, affectedSourceIds: file.sourceIds };
    }
    const source = sources.find(source => path.includes(`/sources/${source.sourceId}/`))!;
    source.deletedAt = null; source.lifecycleVersion += 1;
    return { purpose: 'reference', revision: 1, sourceId: source.sourceId, deletedAt: null, lifecycleVersion: source.lifecycleVersion };
  });
});
afterEach(async () => { await act(async () => cancelPageDialog()); cleanup(); });

describe('project file recycle library', () => {
  it('shows an unfinished upload without a source and cancel leaves it untouched', async () => {
    mount();
    expect(await screen.findByText('上传未完成')).toBeInTheDocument();
    expect(screen.getByText('大小待上传后确认')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '移入回收站：未完成.pdf' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('解析、OCR、要求提取和文件总结');
    expect(screen.getByRole('dialog')).toHaveTextContent('原文件、已有正文与历史仍会保留');
    expect(screen.getByRole('dialog')).toHaveTextContent('费用无法撤回');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocked.delete).not.toHaveBeenCalled();
    expect(screen.getByText('未完成.pdf')).toBeInTheDocument();
  });

  it('deletes a pending file once, restores the same file and never starts parse or summary', async () => {
    const { onChanged, client } = mount();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const button = await screen.findByRole('button', { name: '移入回收站：未完成.pdf' });
    fireEvent.click(button); fireEvent.click(button);
    expect(await screen.findAllByRole('dialog')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '确认移入回收站' }));
    await waitFor(() => expect(mocked.delete).toHaveBeenCalledTimes(1));
    expect(mocked.delete).toHaveBeenCalledWith('/api/v1/projects/p/files/f', { body: { expectedLifecycleVersion: 1 } });
    await screen.findByText('资料已移入回收站，原文件和历史已保留。');
    expect(onChanged).toHaveBeenCalledWith({ projectId: 'p', fileId: 'f', sourceIds: [], restored: false });
    for (const key of ['sources', 'sourceVersion', 'sourceProcessing', 'jobs', 'materials', 'project', 'requirementSets']) expect(invalidate).toHaveBeenCalledWith({ queryKey: [key, 'p'] });
    fireEvent.click(screen.getByRole('button', { name: '回收站' }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复文件：未完成.pdf' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('恢复不会自动启动');
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledTimes(1));
    expect(mocked.post).toHaveBeenCalledWith('/api/v1/projects/p/files/f/restore', { expectedLifecycleVersion: 2 });
    expect(await screen.findByText('资料已恢复。未自动启动任何 AI 处理，请按需手动开始。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '文件库' }));
    expect(await screen.findByText('上传未完成')).toBeInTheDocument();
    expect(files[0].fileId).toBe('f');
    expect(mocked.post.mock.calls.every(([path]) => String(path).endsWith('/restore'))).toBe(true);
  });

  it('hides both delete and restore controls when backend permission is false', async () => {
    files = [{ ...pendingFile, canDelete: false }, { ...pendingFile, fileId: 'recycled', name: '已回收.pdf', deletedAt: now, canDelete: false }];
    mount();
    await screen.findByText('未完成.pdf');
    expect(screen.queryByRole('button', { name: '移入回收站：未完成.pdf' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '回收站' }));
    await screen.findByText('已回收.pdf');
    expect(screen.queryByRole('button', { name: '恢复文件：已回收.pdf' })).not.toBeInTheDocument();
  });

  it('cancels a pending confirmation when switching views', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '移入回收站：未完成.pdf' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: '回收站' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocked.delete).not.toHaveBeenCalled();
  });

  it('rechecks lifecycle version and permissions after confirmation before mutation', async () => {
    const { client } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '移入回收站：未完成.pdf' }));
    await screen.findByRole('dialog');
    await act(async () => { client.setQueryData(['files', 'p', 'active'], [{ ...pendingFile, lifecycleVersion: 2, canDelete: false }]); });
    await waitFor(() => expect(screen.queryByRole('button', { name: '移入回收站：未完成.pdf' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '确认移入回收站' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('状态或操作权限已变化');
    expect(mocked.delete).not.toHaveBeenCalled();
  });

  it('reports a conflict without automatically retrying a lifecycle mutation', async () => {
    mocked.delete.mockRejectedValue(new ApiError(409, { error: { code: 'LIFECYCLE_CONFLICT', message: '记录已变化', retryable: false }, requestId: 'r' }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '移入回收站：未完成.pdf' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认移入回收站' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('记录已变化');
    expect(mocked.delete).toHaveBeenCalledTimes(1);
  });

  it('restores paste/web sources once and avoids duplicate file-linked source controls', async () => {
    files = [{ ...pendingFile, deletedAt: now }];
    sources = [
      { purpose: 'reference', revision: 1, sourceId: 'file-source', kind: 'file', fileId: 'f', title: '文件来源', currentVersionId: null, createdAt: now, deletedAt: now, lifecycleVersion: 2, canDelete: true },
      { purpose: 'reference', revision: 1, sourceId: 'text-source', kind: 'paste', fileId: null, title: '文字来源', currentVersionId: null, createdAt: now, deletedAt: now, lifecycleVersion: 7, canDelete: true },
    ];
    mount();
    fireEvent.click(screen.getByRole('button', { name: '回收站' }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复来源：文字来源' }));
    expect(screen.queryByRole('button', { name: '恢复来源：文件来源' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '确认恢复' }));
    await waitFor(() => expect(mocked.post).toHaveBeenCalledWith('/api/v1/projects/p/sources/text-source/restore', { expectedLifecycleVersion: 7 }));
  });

  it('removes obsolete local job tracking after a file and its source enter recycle', async () => {
    files = [{ ...pendingFile, sourceIds: ['s'] }];
    sources = [{ purpose: 'reference', revision: 1, sourceId: 's', kind: 'file', fileId: 'f', title: '文件关联来源', currentVersionId: null, createdAt: now, deletedAt: null, lifecycleVersion: 1, canDelete: true }];
    writeTrackedSourceJobs('p', [{ jobId: 'old-job', sourceId: 's', sourceVersionId: 'v', sourceTitle: '文件关联来源', fileId: 'f', status: 'failed' }]);
    mount(true);
    await screen.findByRole('button', { name: '重试任务' });
    fireEvent.click(await screen.findByRole('button', { name: '移入回收站：未完成.pdf' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认移入回收站' }));
    await waitFor(() => expect(readTrackedSourceJobs('p')).toEqual([]));
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试任务' })).not.toBeInTheDocument());
    expect(mocked.post).not.toHaveBeenCalled();
  });
});
