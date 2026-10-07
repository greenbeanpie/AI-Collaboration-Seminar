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
it('labels partial media output and displays saved text without claiming complete processing', () => {
 const current={ ...job('succeeded'), result: { partial:true,complete:false,summary:'已经核对的前半段摘要',caveats:['后半段尚未处理'] } };
 render(<AiActivityStatus job={current} />);
 expect(screen.getByRole('region',{name:'部分 AI 结果'})).toBeInTheDocument();
 expect(screen.getByText(/不能视为全文处理成功/)).toBeInTheDocument(); expect(screen.getByText('已经核对的前半段摘要')).toBeInTheDocument();
});

const event = (id: number) => ({ id, code: 'calling_model', state: 'completed', at: `2026-10-07T02:03:${String(id).padStart(2, '0')}Z`, progress: null });
it('reads newest records first and appends older pages without duplication', async () => {
  read.mockResolvedValueOnce({ items: [event(5), event(4)], nextCursor: 4 }).mockResolvedValueOnce({ items: [event(4), event(3)], nextCursor: null });
  render(<AiActivityStatus job={job('succeeded')} />);
  await act(async () => { const details = screen.getByText('操作记录').closest('details')!; details.open = true; fireEvent(details, new Event('toggle')); });
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
  expect(read.mock.calls[0]?.[4]).toBe('desc');
  fireEvent.click(screen.getByText('加载更多记录'));
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
  expect(read.mock.calls[1]?.[1]).toBe(4);
  expect(read.mock.calls[1]?.[4]).toBe('desc');
  expect(screen.getAllByRole('listitem').map(row => row.querySelector('time')?.dateTime)).toEqual([event(5).at, event(4).at, event(3).at]);
});
it('catches up all new pages while older records remain unloaded and retains their cursor', async () => {
  read.mockResolvedValueOnce({ items: [event(5), event(4)], nextCursor: 4 })
    .mockResolvedValueOnce({ items: [event(6), event(7)], nextCursor: 7 })
    .mockResolvedValueOnce({ items: [event(7), event(8)], nextCursor: null })
    .mockResolvedValueOnce({ items: [event(3)], nextCursor: null });
  const known = job('running');
  const { rerender } = render(<AiActivityStatus job={known} />);
  await act(async () => { const details = screen.getByText('操作记录').closest('details')!; details.open = true; fireEvent(details, new Event('toggle')); });
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
  rerender(<AiActivityStatus job={{ ...known, activity: { ...known.activity!, updatedAt: '2026-10-07T02:03:08Z' } }} />);
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(5));
  expect(read.mock.calls[1]?.[1]).toBe(5);
  expect(read.mock.calls[1]?.[4]).toBeUndefined();
  expect(read.mock.calls[2]?.[1]).toBe(7);
  fireEvent.click(screen.getByText('加载更多记录'));
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(6));
  expect(read.mock.calls[3]?.[1]).toBe(4);
  expect(screen.getAllByRole('listitem').map(row => row.querySelector('time')?.dateTime)).toEqual([8, 7, 6, 5, 4, 3].map(id => event(id).at));
});
it('discards an old job history request after switching jobs, including resumed history', async () => {
  let release!: (value: unknown) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce({ items: [event(9), event(2)], nextCursor: null });
  const { rerender } = render(<AiActivityStatus job={job('failed')} />);
  await act(async () => { const details = screen.getByText('操作记录').closest('details')!; details.open = true; fireEvent(details, new Event('toggle')); });
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  rerender(<AiActivityStatus job={{ ...job('running'), jobId: 'resumed-job' }} />);
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
  await act(async () => release({ items: [event(1)], nextCursor: null }));
  expect(screen.getAllByRole('listitem').map(row => row.querySelector('time')?.dateTime)).toEqual([event(9).at, event(2).at]);
});

it('explains exhausted output repair and retains checkpoint resume', () => {
  const failed = { ...job('failed'), error: { code: 'AI_OUTPUT_INVALID', message: '引用校验未通过' } } as ActivityJob;
  failed.activity!.uncertain = false;
  render(<AiActivityStatus job={failed} onResume={vi.fn()} />);
  expect(screen.getByText('自动修正未完成', { selector: 'strong' })).toBeInTheDocument();
  expect(screen.getByText('自动修正未完成：引用校验未通过')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '从停止处继续' })).toBeEnabled();
});
