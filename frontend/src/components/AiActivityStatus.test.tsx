import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AiActivityStatus } from './AiActivityStatus';
import type { ActivityJob } from '../api/ai-activity';
const read = vi.hoisted(() => vi.fn());
vi.mock('../api/ai-activity', async original => ({ ...await original<typeof import('../api/ai-activity')>(), readActivityEvents: read }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const job = (status: ActivityJob['status']): ActivityJob => ({ jobId: 'job-1', status, activity: { code: 'calling_model', updatedAt: null, lastResponseAt: '2026-10-07T02:03:04Z', progress: null, canResume: status === 'failed', resumeReason: null, uncertain: true } } as ActivityJob);
it('shows truthful running state and local reply time including seconds; queued has no animation', () => {
  const { container, rerender } = render(<AiActivityStatus job={job('running')} />);
  expect(screen.getByText('AI 处理中')).toBeInTheDocument();
  expect(screen.getByText('当前操作：调用模型')).toBeInTheDocument();
  expect(container.querySelector('time')?.textContent).toMatch(/:04$/);
  expect(container.querySelector('.is-running')).toBeTruthy();
  rerender(<AiActivityStatus job={job('queued')} />);
  expect(container.querySelector('.is-running')).toBeNull();
});
it('does not invent a reply timestamp when missing and stops animation on read failure', () => {
  const known = job('running'); known.activity!.lastResponseAt = null;
  const refresh = vi.fn();
  const { container } = render(<AiActivityStatus job={known} readError={new Error('network')} onRefresh={refresh} />);
  expect(screen.getByText('尚未收到回复')).toBeInTheDocument();
  expect(container.querySelector('.is-running')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /重试/ }));
  expect(refresh).toHaveBeenCalledOnce();
});
it('loads paginated operation records only on expansion', async () => {
  read.mockResolvedValueOnce({ items: [{ id: 1, code: 'calling_model', state: 'completed', at: '2026-10-07T02:03:04Z', progress: null }], nextCursor: 1 }).mockResolvedValueOnce({ items: [{ id: 2, code: 'saving', state: 'failed', at: '2026-10-07T02:03:05Z', progress: null }], nextCursor: null });
  render(<AiActivityStatus job={job('succeeded')} />);
  expect(read).not.toHaveBeenCalled();
  await act(async () => { const details = screen.getByText('操作记录').closest('details')!; details.open = true; fireEvent(details, new Event('toggle')); });
  await waitFor(() => expect(screen.getByText('调用模型 · 完成')).toBeInTheDocument());
  fireEvent.click(screen.getByText('加载更多记录'));
  await waitFor(() => expect(screen.getByText('保存结果 · 失败')).toBeInTheDocument());
  expect(read.mock.calls[1]?.[1]).toBe(1);
});
it('continues uncertain requests directly and blocks repeated click while pending', async () => {
  let finish!: () => void;
  const resume = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<AiActivityStatus job={job('failed')} onResume={resume} />);
  expect(screen.getByText(/可能再次计费/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('从停止处继续'));
  fireEvent.click(screen.getByText('正在续跑'));
  expect(resume).toHaveBeenCalledOnce();
  await act(async () => finish());
});
it('explains a missing checkpoint before allowing a fresh execution', () => {
  const failed = job('failed');
  failed.activity!.resumeReason = '尚未保存检查点，继续时将重新执行本轮。';
  failed.activity!.uncertain = false;
  render(<AiActivityStatus job={failed} onResume={vi.fn()} />);
  expect(screen.getByText('尚未保存检查点，继续时将重新执行本轮。')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '从停止处继续' })).toBeEnabled();
});
it('refreshes expanded operation history when server activity advances', async () => {
  read.mockResolvedValueOnce({ items: [{ id: 1, code: 'calling_model', state: 'started', at: '2026-10-07T02:03:04Z', progress: null }], nextCursor: null }).mockResolvedValueOnce({ items: [{ id: 2, code: 'saving', state: 'started', at: '2026-10-07T02:03:05Z', progress: null }], nextCursor: null });
  const known = job('running');
  const { rerender } = render(<AiActivityStatus job={known} />);
  await act(async () => { const details = screen.getByText('操作记录').closest('details')!; details.open = true; fireEvent(details, new Event('toggle')); });
  await waitFor(() => expect(screen.getByText('调用模型 · 开始')).toBeInTheDocument());
  rerender(<AiActivityStatus job={{ ...known, activity: { ...known.activity!, updatedAt: '2026-10-07T02:03:05Z' } }} />);
  await waitFor(() => expect(screen.getByText('保存结果 · 开始')).toBeInTheDocument());
  expect(read.mock.calls[1]?.[1]).toBe(1);
});
