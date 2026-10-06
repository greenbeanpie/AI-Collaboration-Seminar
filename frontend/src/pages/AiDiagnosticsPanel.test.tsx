import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AiDiagnosticsPanel } from './AiDiagnosticsPanel';
function setup(role: 'user' | 'admin' | 'super_admin') {
  const client = new QueryClient(); client.setQueryData(['session'], { id: 'fixture-account', role });
  render(<QueryClientProvider client={client}><AiDiagnosticsPanel /></QueryClientProvider>);
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each(['user', 'admin'] as const)('%s cannot see or request AI diagnostics', role => {
  const mock = vi.fn(); vi.stubGlobal('fetch', mock); setup(role);
  expect(screen.queryByText(/AI 诊断日志/)).not.toBeInTheDocument();
  expect(mock).not.toHaveBeenCalled();
});
it('super-admin manually reads no-store fixed metadata without rendering extra private fields or calling a model', async () => {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('/api/v1/admin/ai-diagnostics'); expect(init?.method).toBe('GET'); expect(init?.cache).toBe('no-store');
    return new Response(JSON.stringify({ data: { items: [{ timestamp: '2026-10-01T11:00:00.000Z', requestId: 'e4cc34b8-b74c-4719-bef0-a716055aa5cb', operation: 'model_call', phase: 'fetch_received', status: 'failed', durationMs: 31, errorCode: 'PROVIDER_FAILED', errorReason: 'invalid_api_key: provider rejected the API key', httpStatus: 401, configVersion: 8, prompt: 'private-prompt', apiKey: 'private-key' }], retention: { retainedEntries: 1, retainedBytes: 300, maxEntries: 1000, maxBytes: 1_000_000 } } }));
  });
  vi.stubGlobal('fetch', mock); setup('super_admin'); expect(mock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('AI 诊断日志（仅超级管理员）'));
  fireEvent.click(screen.getByRole('button', { name: '查看/刷新日志' }));
  await screen.findByText(/已保留 1 条/);
  expect(screen.queryByText(/VERSION_CONFLICT|e4cc34b8-b74c-4719-bef0-a716055aa5cb/)).not.toBeInTheDocument();
  expect(screen.getByText(/HTTP 401/)).toBeInTheDocument();
  expect(screen.getByText(/invalid_api_key: provider rejected the API key/)).toBeInTheDocument();
  expect(screen.queryByText(/private-prompt|private-key/)).not.toBeInTheDocument();
  expect(mock).toHaveBeenCalledOnce();
});
it('lets super-admin clear retained logs in one action', async () => {
  let reads = 0;
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(JSON.stringify({ data: { deleted: 3 } }));
    reads++;
    return new Response(JSON.stringify({ data: { items: [], retention: { retainedEntries: reads === 1 ? 3 : 0, retainedBytes: 300, maxEntries: 1000, maxBytes: 1_000_000 } } }));
  });
  vi.stubGlobal('fetch', mock); setup('super_admin');
  fireEvent.click(screen.getByText('AI 诊断日志（仅超级管理员）'));
  fireEvent.click(screen.getByRole('button', { name: '查看/刷新日志' }));
  await screen.findByText(/已保留 3 条/);
  fireEvent.click(screen.getByRole('button', { name: '一键清空日志' }));
  await screen.findByText(/已保留 0 条/);
  expect(mock.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'DELETE', 'GET']);
  expect(screen.getByRole('button', { name: '一键清空日志' })).toBeDisabled();
});
it('read failure is explicit and does not pretend the log is empty or successfully loaded', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ requestId: 'fixture-log-error', error: { code: 'PERMISSION_DENIED', message: '需要超级管理员账户' } }), { status: 403 })));
  setup('super_admin'); fireEvent.click(screen.getByRole('button', { name: '查看/刷新日志' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('需要超级管理员账户');
  expect(screen.queryByText(/暂无诊断记录/)).not.toBeInTheDocument();
});

it('shows successful call metadata without rendering any supplied sensitive content', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { items: [{ timestamp: '2026-10-01T11:00:00.000Z', requestId: 'e4cc34b8-b74c-4719-bef0-a716055aa5cb', operation: 'model_call', phase: 'fetch_received', status: 'succeeded', durationMs: 48, errorCode: 'NONE', httpStatus: 200, finalHost: 'api.deepseek.com', finalPath: '/chat/completions', protocol: 'chat-completions', prompt: 'private-prompt', response: 'private-response', apiKey: 'private-key' }], retention: { retainedEntries: 1, retainedBytes: 300, maxEntries: 1000, maxBytes: 1_000_000 } } }))));
  setup('super_admin'); fireEvent.click(screen.getByText('AI 诊断日志（仅超级管理员）')); fireEvent.click(screen.getByRole('button', { name: '查看/刷新日志' }));
  expect(await screen.findByText(/模型调用 · 已收到供应商 HTTP 响应 · 成功/)).toBeInTheDocument();
  expect(screen.getByText(/api.deepseek.com\/chat\/completions/)).toBeInTheDocument();
  expect(screen.queryByText(/private-prompt|private-response|private-key/)).not.toBeInTheDocument();
});
