import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CollaborationTask } from '../api/collaboration';
import { TaskAgentAction } from './TaskAgentAction';
import { taskAgentEligibilityKey, type TaskAgentEligibility } from './useTaskAgentEligibility';

const request = vi.hoisted(() => vi.fn());
vi.mock('../api/simplification', () => ({ projectRequest: request }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });
const task = { taskId: 't1', revision: 3, title: 'Field research', detail: '', criteria: '' } as CollaborationTask;
const verdict = (overrides: Partial<TaskAgentEligibility> = {}): TaskAgentEligibility => ({ status: 'missing', taskRevision: 3, sourceHash: 'hash', eligible: null, reason: null, jobId: null, ...overrides });
function setup(current = task, copies = 1) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const handoff = vi.fn();
  const content = (item: CollaborationTask) => <QueryClientProvider client={client}>{Array.from({ length: copies }, (_, i) => <TaskAgentAction key={i} projectId="p1" task={item} onHandoff={handoff} />)}</QueryClientProvider>;
  const view = render(content(current));
  return { client, handoff, rerender: (item: CollaborationTask) => view.rerender(content(item)) };
}
describe('server AI task eligibility', () => {
  it('does not judge title keywords: permits field research when the model says true', async () => {
    request.mockResolvedValue(verdict({ status: 'ready', eligible: true }));
    const { handoff } = setup();
    await waitFor(() => expect(screen.getByRole('button', { name: '交给本地 Agent' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '交给本地 Agent' }));
    expect(handoff).toHaveBeenCalledOnce();
    expect(request.mock.calls.every(call => !call[2]?.method)).toBe(true);
  });
  it('explicitly disables a generic task based on the model reason', async () => {
    request.mockResolvedValue(verdict({ status: 'ready', eligible: false, reason: '需到现场采样，无法完整执行。' }));
    const { handoff } = setup({ ...task, title: '任务 A' });
    await screen.findByText('需到现场采样，无法完整执行。');
    expect(screen.getByRole('button', { name: '交给本地 Agent' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '交给本地 Agent' }));
    expect(handoff).not.toHaveBeenCalled();
  });
  it('starts no paid work until clicked and deduplicates shared entry points', async () => {
    let finish!: (value: TaskAgentEligibility) => void;
    request.mockImplementation((_id, _path, options) => options?.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(verdict()));
    setup(task, 2);
    const buttons = await screen.findAllByRole('button', { name: '检查 AI 适用性' });
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(buttons[0]); fireEvent.click(buttons[1]);
    await waitFor(() => expect(request.mock.calls.filter(call => call[2]?.method === 'POST')).toHaveLength(1));
    for (const action of screen.getAllByRole('button', { name: '交给本地 Agent' })) expect(action).toBeDisabled();
    finish(verdict({ status: 'ready', eligible: true }));
    await waitFor(() => { for (const action of screen.getAllByRole('button', { name: '交给本地 Agent' })) expect(action).toBeEnabled(); });
    expect(request.mock.calls.find(call => call[2]?.method === 'POST')?.[2].body).toEqual({ expectedRevision: 3 });
  });
  it('shows a deliberate retry after failure and never automatically repeats POST', async () => {
    request.mockImplementation((_id, _path, options) => options?.method === 'POST' ? Promise.reject(new Error('服务暂不可用')) : Promise.resolve(verdict()));
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '检查 AI 适用性' }));
    const retry = await screen.findByRole('button', { name: '重试 AI 适用性检查' });
    expect(request.mock.calls.filter(call => call[2]?.method === 'POST')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '交给本地 Agent' })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(request.mock.calls.filter(call => call[2]?.method === 'POST')).toHaveLength(2));
    expect(request.mock.calls.filter(call => call[2]?.method === 'POST')[1][2].body).toEqual({ expectedRevision: 3, retry: true });
  });
  it.each(['queued', 'running', 'disabled'] as const)('keeps %s unavailable', async status => {
    request.mockResolvedValue(verdict({ status, eligible: true, reason: status === 'disabled' ? 'AI 未配置' : null }));
    setup();
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '交给本地 Agent' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '检查 AI 适用性' })).toBeNull();
  });
  it('fails closed while loading and retries GET without starting a model', async () => {
    request.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(verdict({ status: 'ready', eligible: true }));
    setup();
    expect(screen.getByRole('button', { name: '交给本地 Agent' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: '重试读取判断' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '交给本地 Agent' })).toBeEnabled());
    expect(request.mock.calls.every(call => !call[2]?.method)).toBe(true);
  });
  it('does not reuse a verdict after an edit, even if a stale GET returns ready', async () => {
    request.mockResolvedValue(verdict({ status: 'ready', eligible: true }));
    const { rerender } = setup();
    await waitFor(() => expect(screen.getByRole('button', { name: '交给本地 Agent' })).toBeEnabled());
    rerender({ ...task, revision: 4, title: '新任务' });
    expect(screen.getByRole('button', { name: '交给本地 Agent' })).toBeDisabled();
    await screen.findByText('任务已更新，请刷新任务列表后重新检查 AI 适用性。');
    expect(screen.getByRole('button', { name: '交给本地 Agent' })).toBeDisabled();
  });
  it('a late POST for the old revision cannot enable the edited task', async () => {
    let finish!: (value: TaskAgentEligibility) => void;
    request.mockImplementation((_id, _path, options) => options?.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(verdict({ taskRevision: options?.signal ? 3 : 4 })));
    const { rerender, client } = setup();
    fireEvent.click(await screen.findByRole('button', { name: '检查 AI 适用性' }));
    await waitFor(() => expect(finish).toBeDefined());
    rerender({ ...task, revision: 4 });
    finish(verdict({ status: 'ready', eligible: true }));
    await waitFor(() => expect(client.getQueryData<TaskAgentEligibility>(taskAgentEligibilityKey('p1', task))?.status).toBe('ready'));
    expect(screen.getByRole('button', { name: '交给本地 Agent' })).toBeDisabled();
  });
  it('polls running work using GET and stops polling when hidden', async () => {
    request.mockResolvedValue(verdict({ status: 'running' }));
    setup();
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(1), { timeout: 2000 });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    const calls = request.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 1700));
    expect(request).toHaveBeenCalledTimes(calls);
    expect(request.mock.calls.every(call => !call[2]?.method)).toBe(true);
  });
});
