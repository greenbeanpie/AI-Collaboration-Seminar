import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ActivityJob } from '../api/ai-activity';
import { ProjectAiChat } from './ProjectAiChat';
import { chatResourceHref, type ChatMessage } from '../api/project-chat';
const mocks = vi.hoisted(() => ({ read: vi.fn(), operations: vi.fn(), send: vi.fn(), clear: vi.fn(), retry: vi.fn(), userId: 'user-1', jobs: {} as Record<string, unknown> }));
vi.mock('../auth', () => ({ useSession: () => ({ data: { id: mocks.userId } }) }));
vi.mock('../api/project-chat', async original => ({ ...await original<typeof import('../api/project-chat')>(), readChat: mocks.read, readChatOperations: mocks.operations, sendChat: mocks.send, clearChat: mocks.clear }));
vi.mock('../pages/aiWorkflowSupport', async original => ({ ...await original<typeof import('../pages/aiWorkflowSupport')>(), retryBackendJob: mocks.retry, useVisibleJobPoller: (id: string | null) => ({ job: id ? mocks.jobs[id] ?? null : null, isSettled: id ? ['succeeded', 'failed'].includes((mocks.jobs[id] as ActivityJob)?.status) : false, error: null, loading: false, refresh: vi.fn() }) }));
const question: ChatMessage = { id: 'm1', questionId: 'q1', role: 'user', content: '截止日期是什么？', createdAt: '2026-10-07T00:00:00Z', jobId: 'j1' };
const answer: ChatMessage = { ...question, id: 'm2', role: 'assistant', content: '**10 月 18 日** <script>alert(1)</script>', references: [{ title: '项目通知', href: '/app/projects/p1/data?source=s1', detail: '第 3 页' }] };
const failed = { jobId: 'j1', status: 'failed', error: { message: '读取失败' }, activity: { code: 'failed', updatedAt: null, lastResponseAt: null, progress: null, canResume: true, uncertain: true, resumeReason: null } } as unknown as ActivityJob;
function show(projectId = 'p1', client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return { client, ...render(<QueryClientProvider client={client}><MemoryRouter><ProjectAiChat projectId={projectId} /></MemoryRouter></QueryClientProvider>) };
}
beforeEach(() => {
  mocks.userId = 'user-1'; mocks.jobs = {}; Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  mocks.read.mockResolvedValue({ items: [], nextCursor: null, pendingJobId: null });
  mocks.operations.mockResolvedValue({ items: [], nextCursor: null });
  mocks.send.mockResolvedValue({ questionId: 'q2', jobId: 'j2' }); mocks.clear.mockResolvedValue({ cleared: true }); mocks.retry.mockResolvedValue('retry-j1');
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('sends once with Enter, preserves Shift+Enter and Chinese composition, and limits questions', async () => {
  show(); await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  const input = screen.getByLabelText('向 AI 提问'); fireEvent.change(input, { target: { value: '项目目标是什么？' } });
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Enter' }); expect(mocks.send).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input); fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce()); expect(mocks.send.mock.calls[0].slice(0, 2)).toEqual(['p1', '项目目标是什么？']); expect(input).toHaveAttribute('maxlength', '4000');
});
it('shows actual resource operations, folds completed answers, renders safe markdown and paginates operations', async () => {
  mocks.jobs.j1 = { jobId: 'j1', status: 'succeeded' };
  mocks.read.mockResolvedValue({ items: [question, answer], nextCursor: null, pendingJobId: null });
  mocks.operations.mockImplementation((_p, _q, cursor) => Promise.resolve({ items: [{ id: cursor ? 'op2' : 'op1', kind: cursor ? 'search' : 'read', label: cursor ? '搜索截止日期' : '已读取项目通知', status: 'completed', attempt: cursor ? 2 : 1, at: '2026-10-07T00:00:00Z', href: cursor ? null : '/app/projects/p1/data?source=s1' }], nextCursor: cursor ? null : 'op1' }));
  const { container } = show(); await screen.findByText('已读取项目通知');
  expect(container.querySelector('details')).not.toHaveAttribute('open'); expect(container.querySelector('script')).toBeNull(); expect(screen.getByRole('link', { name: '项目通知' })).toHaveAttribute('href', '/app/projects/p1/data?source=s1');
  fireEvent.click(screen.getByText('加载更多操作')); await screen.findByText('搜索截止日期'); expect(mocks.operations.mock.calls.some(call => call[2] === 'op1')).toBe(true);
});
it('restores failed history and resumes original question without posting another message', async () => {
  mocks.jobs.j1 = failed; mocks.jobs['retry-j1'] = { jobId: 'retry-j1', status: 'running' };
  mocks.read.mockResolvedValue({ items: [question], nextCursor: null, pendingJobId: null });
  const { container } = show(); await screen.findByText('从停止处继续'); expect(container.querySelector('details')).toHaveAttribute('open'); expect(screen.getByText(/可能再次计费/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('从停止处继续')); await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith('p1', 'j1'));
  expect(mocks.send).not.toHaveBeenCalled(); expect(screen.getByText('清空历史记录')).toBeDisabled();
});
it('clears failed history and allows a fresh question, and retains draft when sending fails', async () => {
  mocks.jobs.j1 = failed; mocks.read.mockResolvedValue({ items: [question], nextCursor: null, pendingJobId: null });
  show(); await screen.findByText('重新发起'); fireEvent.click(screen.getByText('清空历史记录'));
  await waitFor(() => expect(screen.queryByText(question.content)).not.toBeInTheDocument()); expect(mocks.clear).toHaveBeenCalledOnce();
  mocks.send.mockRejectedValue(new Error('服务暂不可用')); fireEvent.change(screen.getByLabelText('向 AI 提问'), { target: { value: '保留这个问题' } }); fireEvent.click(screen.getByText('发送'));
  await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce()); expect(screen.getByLabelText('向 AI 提问')).toHaveValue('保留这个问题');
});
it('pauses input offline and resets drafts and cached history on account or project changes', async () => {
  const { client, rerender } = show(); await waitFor(() => expect(mocks.read).toHaveBeenCalled()); fireEvent.change(screen.getByLabelText('向 AI 提问'), { target: { value: '私密草稿' } });
  await act(async () => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline')); }); expect(screen.getByText('发送')).toBeDisabled(); expect(screen.getByText(/已离线/)).toBeInTheDocument();
  await act(async () => { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); window.dispatchEvent(new Event('online')); });
  mocks.userId = 'user-2'; rerender(<QueryClientProvider client={client}><MemoryRouter><ProjectAiChat projectId="p2" /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByLabelText('向 AI 提问')).toHaveValue(''); await waitFor(() => expect(client.getQueryCache().find({ queryKey: ['project-ai-chat', 'p2', 'user-2'] })).toBeDefined());
});
it('keeps resource navigation within the current project', () => {
  expect(chatResourceHref('p1', 'javascript:alert(1)')).toBeNull(); expect(chatResourceHref('p1', '/app/projects/p2/data')).toBeNull(); expect(chatResourceHref('p1', '//evil.example/app/projects/p1/data')).toBeNull(); expect(chatResourceHref('p1', '/app/projects/p1/data#page=3')).toBe('/app/projects/p1/data#page=3');
});
it('does not restore deleted history when a pre-clear background read completes late', async () => {
  mocks.jobs.j1 = failed;
  mocks.read.mockResolvedValue({ items: [question], nextCursor: null, pendingJobId: null });
  const { client } = show();
  await screen.findByText('重新发起');
  let finish!: (value: unknown) => void;
  mocks.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  let refresh!: Promise<void>;
  await act(async () => { refresh = client.refetchQueries({ queryKey: ['project-ai-chat', 'p1', 'user-1'] }); });
  fireEvent.click(screen.getByText('清空历史记录'));
  await waitFor(() => expect(screen.queryByText(question.content)).not.toBeInTheDocument());
  await act(async () => { finish({ items: [question], nextCursor: null, pendingJobId: null }); await refresh; });
  expect(screen.queryByText(question.content)).not.toBeInTheDocument();
  expect(screen.getByText('可以询问项目目标、任务进度或资料中的要求。')).toBeInTheDocument();
});
it('prepends older chronological history without dropping an answer whose question is on the older page', async () => {
  mocks.jobs.j1 = { jobId: 'j1', status: 'succeeded' }; mocks.jobs.old = { jobId: 'old', status: 'succeeded' };
  const olderQuestion = { ...question, id: 'old-m1', questionId: 'old-q', jobId: 'old', content: '更早问题' };
  const olderAnswer = { ...olderQuestion, id: 'old-m2', role: 'assistant', content: '更早回答' };
  mocks.read.mockImplementation((_p, cursor) => Promise.resolve(cursor ? { items: [olderQuestion], nextCursor: null, pendingJobId: null } : { items: [olderAnswer, question, answer], nextCursor: 'older', pendingJobId: null }));
  const { container } = show(); await screen.findByText('更早回答'); expect(screen.queryByText('更早问题')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('加载更早对话')); await screen.findByText('更早问题');
  const rounds = [...container.querySelectorAll('.project-chat-round')]; expect(rounds[0].textContent).toContain('更早问题'); expect(rounds[0].textContent).toContain('更早回答'); expect(rounds[1].textContent).toContain('截止日期是什么'); expect(rounds).toHaveLength(2);
});
it('updates the same operation status across paged results and folds once the job finishes', async () => {
  mocks.jobs.j1 = { jobId: 'j1', status: 'running' };
  mocks.read.mockResolvedValue({ items: [question], nextCursor: null, pendingJobId: 'j1' });
  let status = 'running';
  mocks.operations.mockImplementation((_p, _q, cursor) => Promise.resolve({ items: [{ id: cursor ? 'op2' : 'op1', kind: 'read', label: cursor ? '已读取主目标' : '正在读取项目通知', status: cursor ? 'completed' : status, at: '2026-10-07T00:00:00Z', attempt: 1, href: cursor ? '/app/projects/other/data' : null }], nextCursor: cursor ? null : 'op1' }));
  const { client, container } = show(); await screen.findByText('正在读取项目通知'); expect(container.querySelector('details')).toHaveAttribute('open');
  fireEvent.click(screen.getByText('加载更多操作')); await screen.findByText('已读取主目标'); expect(screen.getByText('资源不可访问')).toBeInTheDocument();
  status = 'completed'; await act(async () => { await client.invalidateQueries({ queryKey: ['project-chat-operations'] }); });
  await waitFor(() => expect(container.querySelector('.project-chat-operation.is-running')).toBeNull()); expect(screen.getByText('已读取主目标')).toBeInTheDocument(); expect(container.querySelectorAll('.project-chat-operation')).toHaveLength(2);
  mocks.jobs.j1 = { jobId: 'j1', status: 'succeeded' }; mocks.read.mockResolvedValue({ items: [question, answer], nextCursor: null, pendingJobId: null });
  await act(async () => { await client.invalidateQueries({ queryKey: ['project-ai-chat'] }); }); await waitFor(() => expect(container.querySelector('details')).not.toHaveAttribute('open'));
});
it('retains an operation page when the job fails while that page is loading', async () => {
  mocks.jobs.j1 = { jobId: 'j1', status: 'running' };
  mocks.read.mockResolvedValue({ items: [question], nextCursor: null, pendingJobId: null });
  const first = { items: [{ id: 'op1', kind: 'read', label: '第一项资源', status: 'completed', at: question.createdAt, attempt: 1, href: null }], nextCursor: 'more' };
  const next = { items: [{ id: 'op2', kind: 'read', label: '下一页资源', status: 'completed', at: question.createdAt, attempt: 1, href: null }], nextCursor: null };
  let finish!: (value: unknown) => void;
  let loading = true;
  mocks.operations.mockImplementation((_p, _q, cursor) => {
    if (!cursor) return Promise.resolve(first);
    if (loading) { loading = false; return new Promise(resolve => { finish = resolve; }); }
    return Promise.resolve(next);
  });
  const { client } = show();
  await screen.findByText('第一项资源');
  fireEvent.click(screen.getByText('加载更多操作'));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  mocks.jobs.j1 = failed;
  await act(async () => { await client.invalidateQueries({ queryKey: ['project-ai-chat'] }); });
  await act(async () => { finish(next); });
  await screen.findByText('下一页资源');
  expect(screen.getByText('第一项资源')).toBeInTheDocument();
});
