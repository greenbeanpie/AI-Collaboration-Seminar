import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopFilesPanel } from './DesktopFilesPanel';

const mock = vi.hoisted(() => ({ list: vi.fn(), remote: vi.fn(), prepare: vi.fn(), cache: vi.fn(), transfer: vi.fn(), confirm: vi.fn(), remove: vi.fn() }));
vi.mock('../api/client', () => ({ listAllItems: mock.remote, projectPath: (id: string, tail: string) => id + tail }));
vi.mock('../offline/sync', () => ({ prepareProject: mock.prepare }));
vi.mock('../dialogs/dialog-service', () => ({ confirmPage: mock.confirm }));
vi.mock('./attachments', () => ({ listDesktopFiles: mock.list, cacheProjectFiles: mock.cache, transferDesktopFiles: mock.transfer, removeDesktopFile: mock.remove, stageDesktopFiles: vi.fn(), pauseDesktopFile: vi.fn(), resumeDesktopFile: vi.fn(), exportDesktopFile: vi.fn(), estimateCache: (rows: {sizeBytes: number}[]) => ({ count: rows.length, sizeBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0) }) }));
beforeEach(() => { vi.clearAllMocks(); mock.list.mockResolvedValue([]); mock.remote.mockResolvedValue([{ fileId: 'a', name: 'A.pdf', sizeBytes: 10, status: 'available', deletedAt: null }, { fileId: 'b', name: 'B.pdf', sizeBytes: 20, status: 'available', deletedAt: null }]); mock.prepare.mockResolvedValue(undefined); mock.cache.mockResolvedValue([]); mock.transfer.mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('desktop offline cache controls', () => {
  it('prepares complete text before queueing selected file downloads', async () => {
    render(<DesktopFilesPanel projectId="p"/>);
    fireEvent.click(screen.getByRole('button', { name: '下载整个项目' }));
    await screen.findByLabelText('B.pdf'); fireEvent.click(screen.getByLabelText('B.pdf'));
    fireEvent.click(screen.getByRole('button', { name: '确认下载' }));
    await waitFor(() => expect(mock.cache).toHaveBeenCalledWith('p', [{ fileId: 'a', name: 'A.pdf', sizeBytes: 10 }]));
    expect(mock.prepare).toHaveBeenCalledWith('p');
    expect(mock.prepare.mock.invocationCallOrder[0]).toBeLessThan(mock.cache.mock.invocationCallOrder[0]);
  });
  it('keeps confirmation open and queues no downloads after incomplete text preparation', async () => {
    mock.prepare.mockRejectedValue(new Error('project text unavailable'));
    render(<DesktopFilesPanel projectId="p"/>);
    fireEvent.click(screen.getByRole('button', { name: '下载整个项目' })); await screen.findByLabelText('A.pdf');
    fireEvent.click(screen.getByRole('button', { name: '确认下载' }));
    await screen.findByText('project text unavailable'); expect(mock.cache).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: '确认下载' })).toBeInTheDocument();
  });
  it('protects unuploaded bytes when the page confirmation is declined', async () => {
    mock.list.mockResolvedValue([{ id: 'r', projectId: 'p', name: 'draft.txt', sizeBytes: 8, transferredBytes: 0, direction: 'upload', status: 'paused' }]); mock.confirm.mockResolvedValue(false);
    render(<DesktopFilesPanel projectId="p"/>); fireEvent.click(await screen.findByRole('button', { name: '放弃此附件' }));
    await waitFor(() => expect(mock.confirm).toHaveBeenCalled()); expect(mock.remove).not.toHaveBeenCalled();
  });
  it('does not query while hidden and refreshes on visibility restoration', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    render(<DesktopFilesPanel projectId="p"/>); expect(mock.list).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible'); await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(mock.list).toHaveBeenCalledWith('p');
  });
});
