import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { OfflineWorkspaceStatus } from './OfflineWorkspaceStatus';
import { ensureProjectPrepared, preparedAt, prepareProject, synchronizeOffline } from './sync';
import { operations } from './store';
vi.mock('./sync', () => ({ ensureProjectPrepared: vi.fn(), preparedAt: vi.fn(), prepareProject: vi.fn(), synchronizeOffline: vi.fn(), resolveOperation: vi.fn() }));
vi.mock('./store', async (original) => ({ ...await original<typeof import('./store')>(), operations: vi.fn() }));
beforeEach(() => { vi.mocked(preparedAt).mockResolvedValue(null); vi.mocked(ensureProjectPrepared).mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
function show(online = true) {
  vi.stubGlobal('navigator', { onLine: online });
  vi.mocked(operations).mockResolvedValue([]);
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/app/projects/p/tasks']}><OfflineWorkspaceStatus accountId="me"/></MemoryRouter></QueryClientProvider>);
}
it('checks preparation on entry, reconnection and focus and makes offline readiness visible', async () => {
  show(); await act(async () => {});
  expect(ensureProjectPrepared).toHaveBeenCalledWith('p');
  expect(screen.getByLabelText('离线工作与同步')).toHaveTextContent('尚未完成项目离线准备');
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(ensureProjectPrepared).toHaveBeenCalledTimes(2);
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(ensureProjectPrepared).toHaveBeenCalledTimes(3);
  expect(prepareProject).not.toHaveBeenCalled();
});
it('coalesces concurrent synchronization triggers', async () => {
  let finish!: () => void;
  vi.mocked(synchronizeOffline).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  show(); await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
  expect(synchronizeOffline).toHaveBeenCalledTimes(1);
  await act(async () => finish()); expect(ensureProjectPrepared).toHaveBeenCalledTimes(1);
});
it('forces the explicit download and shows a completed snapshot plus attachment and storage boundaries', async () => {
  vi.mocked(preparedAt).mockResolvedValue('2026-10-13T01:00:00Z');
  show(); await act(async () => {});
  expect(screen.getByLabelText('离线工作与同步')).toHaveTextContent('上次项目准备完成');
  expect(screen.getByLabelText('离线工作与同步')).toHaveTextContent('附件原文件需另行下载');
  expect(screen.getByLabelText('离线工作与同步')).toHaveTextContent('不支持存储保护检查');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '刷新本机项目快照' })));
  expect(prepareProject).toHaveBeenCalledOnce();
});
it('shows a specific quota failure without hiding the prior completed snapshot', async () => {
  vi.mocked(preparedAt).mockResolvedValue('2026-10-13T01:00:00Z');
  show(false); await act(async () => {});
  await act(async () => window.dispatchEvent(new CustomEvent('offline-storage-failed', { detail: { message: '本机存储空间不足，无法保存。' } })));
  expect(screen.getByRole('alert')).toHaveTextContent('本机存储空间不足');
  expect(screen.getByLabelText('离线工作与同步')).toHaveTextContent('上次项目准备完成');
});
it('retains offline and failed-sync notices', async () => {
  show(false); expect(screen.getByText('离线工作台')).toBeInTheDocument(); expect(synchronizeOffline).not.toHaveBeenCalled();
  vi.stubGlobal('navigator', { onLine: true }); vi.mocked(synchronizeOffline).mockRejectedValue(new Error('暂时不可连接'));
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(screen.getByRole('alert')).toHaveTextContent('暂时不可连接'); expect(screen.getByRole('button', { name: '重试同步' })).toBeInTheDocument();
});
