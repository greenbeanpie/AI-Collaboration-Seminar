import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AiSettings } from './AiSettings';

function setup(admin = true) { const client = new QueryClient(); client.setQueryData(['session'], { id: 'account', username: 'member', email: null, displayName: 'member', isAdmin: admin }); render(<QueryClientProvider client={client}><AiSettings /></QueryClientProvider>); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('system admin session saves blank configuration, tests connections, and cannot enable failed probes', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(new Headers(init?.headers).has('authorization')).toBe(false); expect(init?.credentials).toBe('same-origin');
    if (init?.method === 'PUT') {
      expect(body.textEconomy.apiUrl).toBe(''); expect(body.textEconomy.apiKey).toBe(''); expect(body.enabled).toBe(false);
      return new Response(JSON.stringify({ data: { version: 2 } }));
    }
    return new Response(JSON.stringify({ data: { passed: false, configVersion: 2, checks: [{ name: 'chinese_text', passed: false, detail: '请填写 API URL、key 和模型名称' }] } }));
  });
  vi.stubGlobal('fetch', fetchMock); setup();
  const enable = screen.getByRole('button', { name: '全部测试通过后启用 AI' }); expect(enable).toBeDisabled();
  expect(screen.getByRole('button', { name: '保存配置并停用 AI' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '保存配置并停用 AI' }));
  await screen.findByText('配置已保存，AI 暂停启用。请逐项测试。');
  fireEvent.click(screen.getByRole('button', { name: /测试.*文本与要求提取.*连接与能力/ }));
  await waitFor(() => expect(screen.getByText(/请填写 API URL、key 和模型名称/)).toBeInTheDocument());
  expect(enable).toBeDisabled(); expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('ordinary account cannot save with a session alone; token fallback errors are explicit', async () => {
  const mock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 }));
  vi.stubGlobal('fetch', mock); setup(false);
  const save = screen.getByRole('button', { name: '保存配置并停用 AI' }); expect(save).toBeDisabled();
  fireEvent.click(screen.getByText('运维管理员令牌模式（可选）'));
  fireEvent.change(screen.getByLabelText(/管理员令牌/), { target: { value: 'wrong-token' } });
  fireEvent.click(save);
  expect(await screen.findByRole('alert')).toHaveTextContent('管理员令牌无效或已失效');
  expect(new Headers(mock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer wrong-token');
  expect(localStorage.length).toBe(0);
});
