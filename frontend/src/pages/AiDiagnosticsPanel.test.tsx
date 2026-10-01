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
    return new Response(JSON.stringify({ data: { items: [{ timestamp: '2026-10-01T11:00:00.000Z', requestId: 'e4cc34b8-b74c-4719-bef0-a716055aa5cb', operation: 'config_save', phase: 'request_finished', status: 'failed', durationMs: 31, errorCode: 'VERSION_CONFLICT', httpStatus: 409, configVersion: 8, prompt: 'private-prompt', apiKey: 'private-key' }], retention: { retainedEntries: 1, retainedBytes: 300, maxEntries: 1000, maxBytes: 1_000_000 } } }));
  });
  vi.stubGlobal('fetch', mock); setup('super_admin'); expect(mock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('AI 诊断日志（仅超级管理员）'));
  fireEvent.click(screen.getByRole('button', { name: '刷新诊断日志' }));
  await screen.findByText(/错误码：VERSION_CONFLICT/);
  expect(screen.getByText(/HTTP 409/)).toBeInTheDocument();
  expect(screen.queryByText(/private-prompt|private-key/)).not.toBeInTheDocument();
  expect(mock).toHaveBeenCalledOnce();
});
it('read failure is explicit and does not pretend the log is empty or successfully loaded', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ requestId: 'fixture-log-error', error: { code: 'PERMISSION_DENIED', message: '需要超级管理员账户' } }), { status: 403 })));
  setup('super_admin'); fireEvent.click(screen.getByRole('button', { name: '刷新诊断日志' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('需要超级管理员账户');
  expect(screen.queryByText(/暂无诊断记录/)).not.toBeInTheDocument();
});
