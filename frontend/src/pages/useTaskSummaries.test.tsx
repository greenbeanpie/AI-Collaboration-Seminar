import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { collaborationApi, type CollaborationTask } from '../api/collaboration';
import { taskSummaryPreview, useTaskSummaries } from './useTaskSummaries';

const task = (id: string, detail = '说明'.repeat(40)): CollaborationTask => ({ taskId: id, title: id, detail, criteria: '验收标准', summaryStatus: 'missing' } as CollaborationTask);
function setup(tasks: CollaborationTask[], enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['collaboration-tasks', 'p'], { items: tasks });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(({ rows, active }) => useTaskSummaries('p', rows, active), { wrapper, initialProps: { rows: tasks, active: enabled } });
  return { ...view, client };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('task card summaries', () => {
  it('uses detail then criteria and caps Unicode characters including ellipsis', () => {
    expect(taskSummaryPreview(task('short', '完成真实记录'))).toBe('完成真实记录');
    expect(taskSummaryPreview(task('criteria', ''))).toBe('验收标准');
    expect(Array.from(taskSummaryPreview(task('unicode', '🧭'.repeat(80))))).toHaveLength(60);
    expect(taskSummaryPreview({ ...task('summary'), summary: 'AI 核对后的摘要' })).toBe('AI 核对后的摘要');
  });
  it('makes zero requests for short text or unavailable AI', () => {
    const summary = vi.spyOn(collaborationApi, 'summary');
    const view = setup([task('short', '短说明')]); view.unmount();
    setup([task('disabled')], false);
    expect(summary).not.toHaveBeenCalled();
  });
  it('limits pending requests to two, deduplicates and starts another when ready', async () => {
    let finish!: (value: { summary: string; summaryStatus: 'ready' }) => void;
    const summary = vi.spyOn(collaborationApi, 'summary').mockImplementation((_project, id) => id === 'a' ? new Promise(resolve => { finish = resolve; }) : new Promise(() => {}));
    const rows = [task('a'), task('b'), task('c')];
    const view = setup(rows);
    await waitFor(() => expect(summary).toHaveBeenCalledTimes(2));
    view.rerender({ rows: [...rows], active: true });
    expect(summary).toHaveBeenCalledTimes(2);
    await act(async () => finish({ summary: '已总结', summaryStatus: 'ready' }));
    await waitFor(() => expect(summary).toHaveBeenCalledTimes(3));
  });
  it('retains failure until explicit retry and prevents stale response overwrite', async () => {
    const summary = vi.spyOn(collaborationApi, 'summary').mockRejectedValueOnce(new Error('预算不足')).mockResolvedValue({ summary: '重试成功', summaryStatus: 'ready' });
    const row = task('a'); const view = setup([row]);
    await waitFor(() => expect(view.result.current.errors.a).toBe('预算不足'));
    view.rerender({ rows: [row], active: true }); expect(summary).toHaveBeenCalledTimes(1);
    act(() => view.result.current.retry(row));
    await waitFor(() => expect(summary).toHaveBeenCalledTimes(2));
    expect(summary).toHaveBeenLastCalledWith('p', 'a', true);
    await waitFor(() => expect(view.result.current.errors.a).toBeUndefined());
    view.unmount();
    let finish!: (value: { summary: string; summaryStatus: 'ready' }) => void;
    summary.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const stale = setup([row]);
    const changed = { ...row, detail: '新的说明'.repeat(30), summaryStatus: 'queued' as const };
    stale.client.setQueryData(['collaboration-tasks', 'p'], { items: [changed] });
    stale.rerender({ rows: [changed], active: true });
    await act(async () => finish({ summary: '旧内容摘要', summaryStatus: 'ready' }));
    expect(stale.client.getQueryData<{ items: CollaborationTask[] }>(['collaboration-tasks', 'p'])?.items[0]?.summary).toBeUndefined();
  });
});
