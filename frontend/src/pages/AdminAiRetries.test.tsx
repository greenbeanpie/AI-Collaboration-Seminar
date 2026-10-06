import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AdminAiRetries } from './AdminAiRetries';
const batch = { batchId: 'batch-1', status: 'completed', total: 4, pending: 0, queued: 3, skipped: 1, createdAt: '', updatedAt: '', skipReasons: [{ reason: '请求已恢复', count: 1 }] };
const status = { failedCount: 4, pendingRetryCount: 2, activeBatch: null, latestBatch: null };
const response = (data: unknown) => new Response(JSON.stringify({ data, requestId: 'fixture' }));
function setup(superAdmin = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); const onDenied = vi.fn();
  render(<QueryClientProvider client={client}><AdminAiRetries userId="admin-1" superAdmin={superAdmin} onDenied={onDenied} /></QueryClientProvider>);
  return { client, onDenied };
}
async function enabledButton() { const button = await screen.findByRole('button', { name: '将所有失败请求排队重试' }); await waitFor(() => expect(button).toBeEnabled()); return button; }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('queues once, shows counts and skipped reasons, and bypasses HTTP cache', async () => {
  let posts = 0; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (_path: string, options?: RequestInit) => {
    expect(options?.cache).toBe('no-store');
    if (options?.method !== 'POST') return response(status);
    posts++; expect(JSON.parse(String(options.body)).idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
    await gate; return response({ batch, replayed: false });
  }));
  setup(); const button = await enabledButton(); fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(posts).toBe(1)); expect(screen.getByRole('button', { name: '正在提交重试批次……' })).toBeDisabled();
  await act(async () => { release(); await gate; });
  await screen.findByText('已排队 3 / 4 · 待处理 0 · 已跳过 1'); expect(screen.getByText('请求已恢复：1')).toBeInTheDocument();
  expect(screen.getByText(/连续 3 次回退全部失败/)).toBeInTheDocument();
});
it('reuses the idempotency key after uncertain network failure', async () => {
  const keys: string[] = []; vi.stubGlobal('fetch', vi.fn(async (_path: string, options?: RequestInit) => {
    if (options?.method !== 'POST') return response(status);
    keys.push(JSON.parse(String(options.body)).idempotencyKey); if (keys.length === 1) throw new Error('connection lost');
    return response({ batch, replayed: true });
  }));
  setup(); const button = await enabledButton(); fireEvent.click(button); await screen.findByRole('alert');
  await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button); await screen.findByText('已读取原重试批次，未重复排队。');
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
});
it('ordinary admin reads status without a global retry button', async () => {
  const mock = vi.fn(async () => response(status)); vi.stubGlobal('fetch', mock); setup(false); await screen.findByText('当前失败请求：');
  expect(screen.queryByRole('button', { name: '将所有失败请求排队重试' })).not.toBeInTheDocument(); expect(mock).toHaveBeenCalledTimes(1);
});
it('super-admin clears only pending retry rows and refreshes the persisted batch state', async () => {
  let pendingRetryCount = 2;
  const mock = vi.fn(async (_path: string, options?: RequestInit) => {
    if (options?.method === 'DELETE') { pendingRetryCount = 0; return response({ deletedItems: 2, completedBatches: 1 }); }
    return response({ ...status, pendingRetryCount, latestBatch: pendingRetryCount ? { ...batch, status: 'running', pending: 2 } : { ...batch, total: 0, queued: 0, skipped: 0, pending: 0 } });
  });
  vi.stubGlobal('fetch', mock); setup();
  fireEvent.click(await screen.findByRole('button', { name: '清除待重试记录（2）' }));
  await screen.findByText('已清除 2 条待重试记录；失败任务、原始日志和正在处理的条目均已保留。');
  await waitFor(() => expect(screen.getByRole('button', { name: '清除待重试记录（0）' })).toBeDisabled());
  expect(screen.getByText('当前失败请求：')).toBeInTheDocument();
  expect(mock.mock.calls.map(([, options]) => options?.method ?? 'GET')).toEqual(['GET', 'DELETE', 'GET']);
});
it.each([0, 4])('disables submission when empty or batch active (failed=%s)', async failedCount => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ ...status, failedCount, activeBatch: failedCount ? { ...batch, status: 'running', pending: 4 } : null })));
  setup(); await screen.findByText('当前失败请求：'); expect(screen.getByRole('button', { name: '将所有失败请求排队重试' })).toBeDisabled();
});
it('removes controls and clears cache on permission loss', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_path: string, options?: RequestInit) => options?.method === 'POST' ? new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: '权限已移除', retryable: false }, requestId: 'denied' }), { status: 403 }) : response(status)));
  const { client, onDenied } = setup(); fireEvent.click(await enabledButton()); await waitFor(() => expect(onDenied).toHaveBeenCalledOnce());
  expect(screen.queryByText('失败 AI 请求重试')).not.toBeInTheDocument(); expect(client.getQueryData(['admin-ai-retries', 'admin-1', true])).toBeUndefined();
});
it('removes execution controls immediately when role is downgraded', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(status)));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); const onDenied = vi.fn();
  const view = (superAdmin: boolean) => <QueryClientProvider client={client}><AdminAiRetries key={String(superAdmin)} userId="admin-1" superAdmin={superAdmin} onDenied={onDenied} /></QueryClientProvider>;
  const { rerender } = render(view(true)); await enabledButton(); rerender(view(false));
  expect(screen.queryByRole('button', { name: '将所有失败请求排队重试' })).not.toBeInTheDocument();
});
