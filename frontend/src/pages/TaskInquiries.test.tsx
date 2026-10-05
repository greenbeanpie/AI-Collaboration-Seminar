import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskInquiries } from './TaskInquiries';
import { projectRequest } from '../api/simplification';

vi.mock('../api/simplification', () => ({ projectRequest: vi.fn() }));
vi.mock('./aiWorkflowSupport', () => ({ idempotencyKeyForIntent: async () => 'intent-key', completeIntent: vi.fn() }));
const request = vi.mocked(projectRequest);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function show() {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
    <TaskInquiries projectId="p" taskId="target-task" taskTitle="接口规范" meId="requester" members={[
      { userId: 'requester', displayName: '发起人' },
      { userId: 'recipient', displayName: '任意项目成员' },
    ]} />
  </QueryClientProvider>);
}

it('creates a private ticket for any other project member in the corresponding task', async () => {
  request.mockResolvedValue({ items: [] });
  show();
  fireEvent.change(await screen.findByLabelText('质询对象'), { target: { value: 'recipient' } });
  fireEvent.change(screen.getByLabelText('质询内容'), { target: { value: '这个任务的接口字段如何定义？' } });
  fireEvent.click(screen.getByRole('button', { name: '创建质询工单' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith('p', '/tasks/target-task/inquiries', {
    method: 'POST',
    body: { recipientId: 'recipient', body: '这个任务的接口字段如何定义？' },
    idempotencyKey: 'intent-key',
  }));
  expect(screen.getByText('工单和双方回复都保存在“接口规范”任务中，仅发起人与质询对象可见。')).toBeInTheDocument();
});

it('renders a one-to-one ticket and preserves a failed reply draft', async () => {
  request.mockImplementation(async (_project, path, options) => {
    if (path.endsWith('/read')) return { readCount: 1 };
    if (path.includes('/messages') && options?.method === 'POST') throw new Error('网络失败');
    return { items: [{ inquiryId: 'thread', taskId: 'target-task', upstreamTaskId: 'target-task', taskTitle: '接口规范', upstreamTitle: '接口规范', requesterId: 'requester', requesterName: '成员乙', recipientId: 'recipient', recipientName: '成员甲', recipientSource: 'direct', messages: [{ messageId: 'msg', authorId: 'recipient', authorName: '成员甲', body: '使用 JSON', createdAt: '2026-10-03T00:00:00Z' }] }] };
  });
  show();
  expect(await screen.findByRole('heading', { name: '任务质询 · 接口规范' })).toBeInTheDocument();
  expect(await screen.findByText('使用 JSON')).toBeInTheDocument();
  await waitFor(() => expect(request).toHaveBeenCalledWith('p', '/tasks/target-task/inquiries/read', { method: 'POST', body: { messageIds: ['msg'] } }));
  fireEvent.change(screen.getByLabelText('回复工单'), { target: { value: '请补充一个例子' } });
  fireEvent.click(screen.getByRole('button', { name: '发送回复' }));
  expect(await screen.findByText('网络失败')).toBeInTheDocument();
  expect(screen.getByLabelText('回复工单')).toHaveValue('请补充一个例子');
});
