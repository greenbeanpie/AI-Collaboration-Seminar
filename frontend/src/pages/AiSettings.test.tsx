import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AiSettings } from './AiSettings';

afterEach(() => vi.unstubAllGlobals());
it('空参数留待用户填写，保存后保留测试按钮，失败不能启用', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (init?.method === 'PUT') {
      expect(body.textEconomy.apiUrl).toBe('');
      expect(body.textEconomy.apiKey).toBe('');
      expect(body.enabled).toBe(false);
      return new Response(JSON.stringify({ data: { version: 2 } }));
    }
    return new Response(JSON.stringify({ data: { passed: false, configVersion: 2, checks: [{ name: 'chinese_text', passed: false, detail: '请填写 API URL、key 和模型名称' }] } }));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<QueryClientProvider client={new QueryClient()}><AiSettings /></QueryClientProvider>);
  const enable = screen.getByRole('button', { name: '全部测试通过后启用 AI' });
  expect(enable).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/管理员令牌/), { target: { value: 'test-admin' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置并停用 AI' }));
  await screen.findByText('配置已保存，AI 暂停启用。请逐项测试。');
  fireEvent.click(screen.getByRole('button', { name: /测试.*文本与要求提取.*连接与能力/ }));
  await waitFor(() => expect(screen.getByText(/请填写 API URL、key 和模型名称/)).toBeInTheDocument());
  expect(enable).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
