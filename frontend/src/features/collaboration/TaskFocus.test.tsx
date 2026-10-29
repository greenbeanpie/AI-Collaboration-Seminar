import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { projectRequest } from '../../api/simplification';
import { TaskFocus } from './TaskFocus';

vi.mock('../../api/simplification', () => ({ projectRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const tasks = Array.from({ length: 7 }, (_, index) => ({ taskId: `t${index}`, title: `重点${index}`, pinned: index === 0, focusReasons: [index === 0 ? '我关注' : '即将到期'] }));
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><TaskFocus projectId="p" /></MemoryRouter></QueryClientProvider>);
}
it('uses server order, expands all, and distinguishes review queues', async () => {
  vi.mocked(projectRequest).mockResolvedValue({ items: tasks, waitingReview: [{ ...tasks[0], taskId: 'waiting', title: '等待结果' }], reviewRequired: [{ ...tasks[0], taskId: 'review', title: '需要审核' }] });
  show();
  await screen.findByRole('link', { name: '重点0' });
  expect(screen.queryByRole('link', { name: '重点5' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看全部 7 项' }));
  expect(screen.getByRole('link', { name: '重点6' })).toHaveAttribute('href', '/app/projects/p/tasks?task=t6');
  expect(screen.getByText('等待验收 · 1 项')).toBeInTheDocument();
  expect(screen.getByText('待我审核 · 1 项')).toBeInTheDocument();
});
it('writes only personal pin intent and refreshes the focus response', async () => {
  vi.mocked(projectRequest).mockResolvedValue({ items: tasks.slice(0, 1), waitingReview: [], reviewRequired: [] });
  show(); fireEvent.click(await screen.findByRole('button', { name: '取消置顶' }));
  await waitFor(() => expect(projectRequest).toHaveBeenCalledWith('p', '/tasks/t0/pin', { method: 'PUT', body: { pinned: false } }));
});
it('does not present a failed focus request as an empty task list', async () => {
  vi.mocked(projectRequest).mockRejectedValue(new Error('重点读取失败')); show();
  await screen.findByText('重点读取失败');
  expect(screen.queryByText('暂时没有需要你处理的任务')).toBeNull();
});
