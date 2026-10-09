import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CollaborationTask } from '../api/collaboration';
import { useTaskAgentEligibility } from './useTaskAgentEligibility';
const request = vi.hoisted(() => vi.fn());
vi.mock('../api/simplification', () => ({ projectRequest: request }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); vi.restoreAllMocks(); });
const task = { taskId: 't1', revision: 3 } as CollaborationTask;
const verdict = (status: string, taskRevision = 3) => ({ status, taskRevision, sourceHash: 'hash', eligible: true, reason: null as string | null, jobId: 'j1' });
function Probe({ current = task }) {
  const eligibility = useTaskAgentEligibility('p1', current);
  return <><button disabled={!eligibility.eligible}>代实施</button><button onClick={eligibility.check}>检查</button><button onClick={eligibility.reload}>刷新</button><p>{eligibility.reason}</p></>;
}
const batch = (value: ReturnType<typeof verdict>, taskId = 't1') => ({ items: [{ taskId, eligibility: value }] });
const action = () => screen.getByRole('button', { name: '代实施' });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = (current = task) => <QueryClientProvider client={client}><Probe current={current} /></QueryClientProvider>;
  const view = render(content()); return { ...view, content, client };
}
it('polls automatic missing work using only GET and pauses hidden polling', async () => {
  vi.useFakeTimers(); request.mockResolvedValue(batch(verdict('missing'))); setup();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(request).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
  expect(request).toHaveBeenCalledTimes(2);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  const count = request.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(request).toHaveBeenCalledTimes(count);
  expect(request.mock.calls.every(call => !call[2]?.method)).toBe(true);
});
it('rejects stale judgments after editing and never automatically retries failed model work', async () => {
  request.mockResolvedValue(batch(verdict('ready'))); const view = setup();
  await waitFor(() => expect(action()).toBeEnabled());
  view.rerender(view.content({ ...task, revision: 4 }));
  await screen.findByText('任务已更新，正在等待最新适用性判断。');
  expect(action()).toBeDisabled();
  expect(request.mock.calls.every(call => !call[2]?.method)).toBe(true);
});
it('hides model eligibility conclusions while preserving the execution restriction', async () => {
  request.mockResolvedValue(batch({ ...verdict('ready'), eligible: false, reason: '任务需核对在读身份、学院归属等要求，AI无法独立核验。' }));
  setup();
  await screen.findByText('此任务暂不支持代实施。');
  expect(screen.queryByText(/任务需核对在读身份/)).toBeNull();
  expect(action()).toBeDisabled();
});

it('preserves the reason of a failed server eligibility check', async () => {
  request.mockResolvedValue(batch({ ...verdict('failed'), reason:'模型执行失败或配置未完成\n原始详情' }));
  setup();
  await screen.findByText('模型执行失败或配置未完成 原始详情');
  expect(action()).toBeDisabled();
});

it('batches twenty mounted tasks and shares a card/dialog lookup', async () => {
  request.mockImplementation(async (_project, path: string) => ({ items: path.split('taskIds=')[1].split(',').map(taskId => ({ taskId, eligibility: verdict('ready') })) }));
  const client = new QueryClient();
  render(<QueryClientProvider client={client}>{Array.from({ length: 20 }, (_, index) => <Probe key={index} current={{ ...task, taskId: `t${index}` }} />)}<Probe current={{ ...task, taskId: 't0' }} /></QueryClientProvider>);
  await waitFor(() => expect(screen.getAllByRole('button', { name: '代实施' }).every(button => !button.hasAttribute('disabled'))).toBe(true));
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0][1].split('taskIds=')[1].split(',')).toHaveLength(20);
});

it('disables a cached ready verdict after a failed manual read', async () => {
  request.mockResolvedValueOnce(batch(verdict('ready'))).mockRejectedValueOnce(new Error('权限已撤销'));
  setup(); await waitFor(() => expect(action()).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await screen.findByText('权限已撤销'); expect(action()).toBeDisabled();
});

it('ignores a cancelled older GET after an explicit check starts', async () => {
  let finishRead: (value: ReturnType<typeof batch>) => void = () => {};
  request.mockResolvedValueOnce(batch(verdict('failed')));
  setup(); await screen.findByText('自动检查失败，可重试。');
  request.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  request.mockResolvedValueOnce(verdict('queued'));
  fireEvent.click(screen.getByRole('button', { name: '检查' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  await act(async () => finishRead(batch(verdict('ready'))));
  await screen.findByText('AI 正在判断任务能否完整执行，请稍候。');
  expect(action()).toBeDisabled(); expect(request.mock.calls[2][2].method).toBe('POST');
});

it('stops reads after unmount or logout clears the QueryClient', async () => {
  vi.useFakeTimers(); request.mockResolvedValue(batch(verdict('running')));
  const view = setup(); await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  view.unmount(); await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(request).toHaveBeenCalledOnce();
  const client = new QueryClient(); render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  act(() => client.clear()); await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(request).toHaveBeenCalledTimes(2);
});

it('does not restore eligibility after a check finishes following logout', async () => {
  let finishCheck: (value: ReturnType<typeof verdict>) => void = () => {};
  request.mockResolvedValueOnce(batch(verdict('failed')));
  const { client } = setup(); await screen.findByText('自动检查失败，可重试。');
  request.mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: '检查' }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  act(() => client.clear());
  await act(async () => finishCheck(verdict('ready')));
  expect(client.getQueryData(['task-agent-eligibility', 'p1', 't1', 3])).toBeUndefined();
  expect(action()).toBeDisabled();
});

it('splits fifty-one tasks into bounded batches', async () => {
  request.mockImplementation(async (_project, path: string) => ({ items: path.split('taskIds=')[1].split(',').map(taskId => ({ taskId, eligibility: verdict('ready') })) }));
  render(<QueryClientProvider client={new QueryClient()}>{Array.from({ length: 51 }, (_, index) => <Probe key={index} current={{ ...task, taskId: `t${index}` }} />)}</QueryClientProvider>);
  await waitFor(() => expect(screen.getAllByRole('button', { name: '代实施' }).every(button => !button.hasAttribute('disabled'))).toBe(true));
  expect(request.mock.calls.map(call => call[1].split('taskIds=')[1].split(',').length)).toEqual([25, 25, 1]);
});

it('ignores an old revision response while a fresh revision is loading', async () => {
  let finishRead: (value: ReturnType<typeof batch>) => void = () => {};
  request.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  const view = setup(); await waitFor(() => expect(request).toHaveBeenCalledOnce());
  request.mockResolvedValueOnce(batch(verdict('ready', 4)));
  view.rerender(view.content({ ...task, revision: 4 }));
  await waitFor(() => expect(action()).toBeEnabled());
  await act(async () => finishRead(batch(verdict('ready', 3))));
  expect(action()).toBeEnabled();
  expect(view.client.getQueryData<{ taskRevision: number }>(['task-agent-eligibility', 'p1', 't1', 4])?.taskRevision).toBe(4);
});

it('pauses offline polling and immediately revalidates after reconnecting', async () => {
  vi.useFakeTimers(); request.mockResolvedValue(batch(verdict('running'))); setup();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  act(() => window.dispatchEvent(new Event('offline')));
  await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
  expect(request).toHaveBeenCalledOnce();
  online.mockReturnValue(true); act(() => window.dispatchEvent(new Event('online')));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(request).toHaveBeenCalledTimes(2);
});

it('cancels undispatched later batches after logout during the first batch', async () => {
  let finishRead: (value: { items: [] }) => void = () => {};
  request.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  const client = new QueryClient();
  render(<QueryClientProvider client={client}>{Array.from({ length: 51 }, (_, index) => <Probe key={index} current={{ ...task, taskId: `t${index}` }} />)}</QueryClientProvider>);
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  act(() => client.clear()); await act(async () => finishRead({ items: [] }));
  expect(request).toHaveBeenCalledOnce();
});

it('keeps a remounted registration intact when the removed read finishes', async () => {
  let finishRead: (value: ReturnType<typeof batch>) => void = () => {};
  request.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  const client = new QueryClient();
  const content = (mounted: boolean) => <QueryClientProvider client={client}>{mounted && <Probe />}</QueryClientProvider>;
  const view = render(content(true)); await waitFor(() => expect(request).toHaveBeenCalledOnce());
  view.rerender(content(false));
  request.mockResolvedValueOnce(batch({ ...verdict('ready'), eligible: false }));
  view.rerender(content(true)); await screen.findByText('此任务暂不支持代实施。');
  await act(async () => finishRead(batch(verdict('ready'))));
  expect(action()).toBeDisabled();
  request.mockResolvedValueOnce(batch(verdict('ready')));
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await waitFor(() => expect(action()).toBeEnabled());
});

it('resets running backoff when the execution job changes', async () => {
  vi.useFakeTimers(); request.mockResolvedValue(batch(verdict('running'))); setup();
  await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
  const atThirty = request.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(request).toHaveBeenCalledTimes(atThirty);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
  expect(request).toHaveBeenCalledTimes(atThirty + 1);
  request.mockResolvedValue(batch({ ...verdict('running'), jobId: 'j2' }));
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  const reset = request.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(2_001); });
  expect(request).toHaveBeenCalledTimes(reset + 1);
});

it('shares pending checks and prevents another reader from racing a new GET', async () => {
  let finishCheck: (value: ReturnType<typeof verdict>) => void = () => {};
  request.mockResolvedValueOnce(batch(verdict('failed')));
  const client = new QueryClient(); render(<QueryClientProvider client={client}><Probe /><Probe /></QueryClientProvider>);
  await waitFor(() => expect(screen.getAllByText('自动检查失败，可重试。')).toHaveLength(2));
  request.mockImplementationOnce(() => new Promise(resolve => { finishCheck = resolve; }));
  fireEvent.click(screen.getAllByRole('button', { name: '检查' })[0]);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getAllByRole('button', { name: '刷新' })[1]);
  await act(async () => {});
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => finishCheck(verdict('ready')));
  await waitFor(() => expect(screen.getAllByRole('button', { name: '代实施' }).every(button => !button.hasAttribute('disabled'))).toBe(true));
});
