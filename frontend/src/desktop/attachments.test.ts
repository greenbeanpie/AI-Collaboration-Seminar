import { describe, it, expect, vi, beforeEach } from 'vitest';
import { estimateCache, hasPendingTaskFiles, listDesktopFiles } from './attachments';
import { desktopInvoke, isDesktop } from './bridge';
vi.mock('./bridge', () => ({ desktopInvoke: vi.fn(), isDesktop: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(isDesktop).mockReturnValue(true); });
describe('desktop attachment submission gate', () => {
  it('does not invoke native APIs on the web', async () => { vi.mocked(isDesktop).mockReturnValue(false); expect(await hasPendingTaskFiles('p', 't')).toBe(false); expect(desktopInvoke).not.toHaveBeenCalled(); });
  it('blocks waiting, paused and failed uploads until registration completes', async () => {
    for (const status of ['waiting', 'paused', 'failed', 'transferring']) { vi.mocked(desktopInvoke).mockResolvedValue([{ taskId: 't', direction: 'upload', status }]); expect(await hasPendingTaskFiles('p', 't')).toBe(true); }
    vi.mocked(desktopInvoke).mockResolvedValue([{ taskId: 't', direction: 'upload', status: 'complete' }]); expect(await hasPendingTaskFiles('p', 't')).toBe(false);
  });
  it('does not gate on another task or downloads', async () => { vi.mocked(desktopInvoke).mockResolvedValue([{ taskId: 'other', direction: 'upload', status: 'waiting' }, { taskId: 't', direction: 'download', status: 'waiting' }]); expect(await hasPendingTaskFiles('p', 't')).toBe(false); });
  it('fails closed when native storage cannot be read', async () => { vi.mocked(desktopInvoke).mockRejectedValue(new Error('storage unavailable')); await expect(hasPendingTaskFiles('p', 't')).rejects.toThrow('storage unavailable'); });
  it('scopes enumeration and totals explicitly', async () => { vi.mocked(desktopInvoke).mockResolvedValue([]); await listDesktopFiles('project'); expect(desktopInvoke).toHaveBeenCalledWith('desktop_list_files', { projectId: 'project' }); expect(estimateCache([{ fileId: 'a', name: 'a', sizeBytes: 7 }, { fileId: 'b', name: 'b', sizeBytes: 11 }])).toEqual({ count: 2, sizeBytes: 18 }); });
});
