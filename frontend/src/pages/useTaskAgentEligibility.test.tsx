import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CollaborationTask } from '../api/collaboration';
import { useTaskAgentEligibility } from './useTaskAgentEligibility';
const request = vi.hoisted(() => vi.fn());
vi.mock('../api/simplification', () => ({ projectRequest: request }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); });
const task = { taskId: 't1', revision: 3 } as CollaborationTask;
const verdict = (status: string, taskRevision = 3) => ({ status, taskRevision, sourceHash: 'hash', eligible: true, reason: null, jobId: 'j1' });
function Probe({ current = task }) {
  const eligibility = useTaskAgentEligibility('p1', current);
  return <><button disabled={!eligibility.eligible}>代实施</button><p>{eligibility.reason}</p></>;
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = (current = task) => <QueryClientProvider client={client}><Probe current={current} /></QueryClientProvider>;
  const view = render(content()); return { ...view, content };
}
it('polls automatic missing work using only GET and pauses hidden polling', async () => {
  request.mockResolvedValue(verdict('missing')); setup();
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  await waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(1), { timeout: 2200 });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  const count = request.mock.calls.length;
  await new Promise(resolve => setTimeout(resolve, 1700));
  expect(request).toHaveBeenCalledTimes(count);
  expect(request.mock.calls.every(call => !call[2]?.method)).toBe(true);
});
it('rejects stale judgments after editing and never automatically retries failed model work', async () => {
  request.mockResolvedValue(verdict('ready')); const view = setup();
  await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
  view.rerender(view.content({ ...task, revision: 4 }));
  await screen.findByText('任务已更新，正在等待最新适用性判断。');
  expect(screen.getByRole('button')).toBeDisabled();
  expect(request.mock.calls.every(call => !call[2]?.method)).toBe(true);
});
it('hides model eligibility conclusions while preserving the execution restriction', async () => {
  request.mockResolvedValue({ ...verdict('ready'), eligible: false, reason: '任务需核对在读身份、学院归属等要求，AI无法独立核验。' });
  setup();
  await screen.findByText('此任务暂不支持代实施。');
  expect(screen.queryByText(/任务需核对在读身份/)).toBeNull();
  expect(screen.getByRole('button')).toBeDisabled();
});
