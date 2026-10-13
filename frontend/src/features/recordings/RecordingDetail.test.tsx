import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { projectRequest } from '../../api/simplification';
import { RecordingDetail } from './RecordingDetail';
vi.mock('../../api/simplification', () => ({ projectRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function open(online: boolean, recorded: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online);
  vi.mocked(projectRequest).mockImplementation(async (_project, tail) => tail === '/recording-sessions'
    ? { items: recorded ? [{ sessionId: 'r' }] : [] }
    : { sessionId: 'r', status: 'complete', processingStatus: 'ready', summaryRevision: 1, summaryMarkdown: '本机缓存的会议摘要', interruptions: [], segments: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, networkMode: 'always' } } });
  render(<QueryClientProvider client={client}><RecordingDetail projectId="p" materialId="m" /></QueryClientProvider>);
  if (recorded) await screen.findByText('本机缓存的会议摘要');
  else await vi.waitFor(() => expect(projectRequest).toHaveBeenCalled());
}
it('opens prepared recording metadata offline and reads current metadata online', async () => {
  await open(false, true);
  expect(projectRequest).toHaveBeenCalledWith('p', '/recording-sessions', expect.objectContaining({ networkOnly: false, offlineReadFallback: true, signal: expect.any(AbortSignal), query: { materialId: 'm', limit: 1 } }));
  expect(projectRequest).toHaveBeenCalledWith('p', '/recording-sessions/r', expect.objectContaining({ networkOnly: false, offlineReadFallback: true, query: { cursor: undefined, limit: 50 } }));
  cleanup(); vi.mocked(projectRequest).mockClear();
  await open(true, true);
  expect(projectRequest).toHaveBeenCalledWith('p', '/recording-sessions', expect.objectContaining({ networkOnly: true, offlineReadFallback: true }));
});
it('does not turn an ordinary prepared material with no recording into an error panel', async () => {
  await open(false, false);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('region', { name: '会议录制片段' })).toBeNull();
});
