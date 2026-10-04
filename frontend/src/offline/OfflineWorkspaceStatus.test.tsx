import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { OfflineWorkspaceStatus } from './OfflineWorkspaceStatus';
import { prepareProject, synchronizeOffline } from './sync';
import { operations } from './store';
vi.mock('./sync', () => ({ prepareProject: vi.fn(), synchronizeOffline: vi.fn(), resolveOperation: vi.fn() }));
vi.mock('./store', () => ({ operations: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
function show(online = true) {
  vi.stubGlobal('navigator', { onLine: online });
  vi.mocked(operations).mockResolvedValue([]);
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/app/projects/p/tasks']}><OfflineWorkspaceStatus accountId="me"/></MemoryRouter></QueryClientProvider>);
}
it('refreshes automatically on entry, reconnection and focus without a healthy banner', async () => {
  show(); await act(async () => {});
  expect(prepareProject).toHaveBeenCalledWith('p');
  expect(screen.queryByLabelText('离线工作与同步')).toBeNull();
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(prepareProject).toHaveBeenCalledTimes(2);
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(prepareProject).toHaveBeenCalledTimes(3);
});
it('coalesces concurrent synchronization triggers', async () => {
  let finish!: () => void;
  vi.mocked(synchronizeOffline).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  show(); await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); });
  expect(synchronizeOffline).toHaveBeenCalledTimes(1);
  await act(async () => finish()); expect(prepareProject).toHaveBeenCalledTimes(1);
});
it('retains offline and failed-sync notices', async () => {
  show(false); expect(screen.getByText('离线工作台')).toBeInTheDocument(); expect(synchronizeOffline).not.toHaveBeenCalled();
  vi.stubGlobal('navigator', { onLine: true }); vi.mocked(synchronizeOffline).mockRejectedValue(new Error('暂时不可连接'));
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(screen.getByRole('alert')).toHaveTextContent('暂时不可连接'); expect(screen.getByRole('button', { name: '重试同步' })).toBeInTheDocument();
});
