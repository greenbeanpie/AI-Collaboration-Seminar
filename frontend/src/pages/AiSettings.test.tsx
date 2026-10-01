import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AiSettings } from './AiSettings';

function setup(admin = true) { const client = new QueryClient(); client.setQueryData(['session'], { id: 'account', username: 'member', email: null, displayName: 'member', isAdmin: admin, role: admin ? 'super_admin' : 'user' }); render(<QueryClientProvider client={client}><AiSettings /></QueryClientProvider>); }
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

it('Go has independent manual protocol and bounded headers, never automatically probes', async () => {
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    expect(init?.method).toBe('PUT');
    expect(body.textEconomy).toMatchObject({ providerPreset: 'opencode-go', apiProtocol: 'messages', model: 'minimax-m3', apiUrl: 'https://opencode.ai/zen/go/v1/messages', apiKey: 'new-key', clearKey: true, goUsageAcknowledged: true, goHeaders: { userAgent: 'MyOffice/1.2', sessionPrefix: 'office' } });
    expect(body.textEconomy.supportsJson).toBe(false); expect(body.enabled).toBe(false);
    return new Response(JSON.stringify({ data: { version: 2 } }));
  });
  vi.stubGlobal('fetch', mock); setup();
  fireEvent.change(screen.getByLabelText(/文本与要求提取供应商/), { target: { value: 'opencode-go' } });
  expect(mock).not.toHaveBeenCalled();
  expect(screen.getByText(/本应用含项目写作、分工和验收/)).toBeInTheDocument();
  const save = screen.getByRole('button', { name: '保存配置并停用 AI' }); expect(save).toBeDisabled();
  fireEvent.click(screen.getByLabelText('我已确认套餐适用于本应用用途'));
  const protocol = screen.getByLabelText(/文本与要求提取 API 协议/); expect(protocol).toBeEnabled();
  fireEvent.change(protocol, { target: { value: 'messages' } });
  expect(save).toBeDisabled(); // A known Chat model cannot silently use another protocol.
  fireEvent.change(screen.getByLabelText('文本与要求提取模型名称'), { target: { value: 'minimax-m3' } });
  fireEvent.change(screen.getByLabelText(/文本与要求提取 Go User-Agent/), { target: { value: 'opencode/1.0' } });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/文本与要求提取 Go User-Agent/), { target: { value: 'MyOffice/1.2' } });
  fireEvent.change(screen.getByLabelText(/文本与要求提取 Go 会话前缀/), { target: { value: 'office' } });
  fireEvent.change(screen.getByLabelText(/文本与要求提取 API key/), { target: { value: 'new-key' } });
  expect(save).toBeEnabled(); fireEvent.click(save);
  await screen.findByText('配置已保存，AI 暂停启用。请逐项测试。');
  expect(mock).toHaveBeenCalledOnce(); expect(localStorage.length).toBe(0);
  expect(screen.getByLabelText(/文本与要求提取 API key/)).toHaveValue('');
});

it('OpenAI options follow model capability and explicit protocol; invalid hidden effort is cleared on model switch', () => {
  setup();
  fireEvent.change(screen.getByLabelText(/文本与要求提取供应商/), { target: { value: 'openai' } });
  fireEvent.change(screen.getByLabelText('文本与要求提取模型名称'), { target: { value: 'gpt-5.4' } });
  fireEvent.change(screen.getByLabelText(/文本与要求提取思考强度/), { target: { value: 'high' } });
  fireEvent.change(screen.getByLabelText(/文本与要求提取 temperature/), { target: { value: '0.5' } });
  expect(screen.getByRole('button', { name: '保存配置并停用 AI' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/文本与要求提取思考强度/), { target: { value: 'none' } });
  expect(screen.getByRole('button', { name: '保存配置并停用 AI' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText(/文本与要求提取 API 协议/), { target: { value: 'chat-completions' } });
  expect(screen.getByLabelText(/文本与要求提取 API URL/)).toHaveValue('https://api.openai.com/v1/chat/completions');
  fireEvent.change(screen.getByLabelText('文本与要求提取模型名称'), { target: { value: 'gpt-4.1-mini' } });
  expect(screen.getByLabelText(/文本与要求提取思考强度/)).toHaveValue('');
});

it('old saved custom config is preserved; changing providers clears key reuse and does not enable AI', async () => {
  const model = { provider: 'old-vendor', model: 'private-model', apiUrl: 'https://private.example/v1/chat/completions', keyConfigured: true, timeoutMs: 30000, maxInputChars: 42000, maxOutputTokens: 1500, temperature: 0.4, supportsJson: false, supportsVision: false, pricePerMTokens: null };
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 5, enabled: true, config: { textEconomy: model, visionEconomy: model, review: model } } }));
    const body = JSON.parse(String(init?.body));
    expect(body.textEconomy).toMatchObject({ providerPreset: 'deepseek', apiKey: '', clearKey: true });
    expect(body.review).toMatchObject(model); expect(body.enabled).toBe(false);
    return new Response(JSON.stringify({ data: { version: 6 } }));
  });
  vi.stubGlobal('fetch', mock); setup();
  fireEvent.click(screen.getByRole('button', { name: '读取已保存配置' }));
  await screen.findByText('当前 AI 已启用。');
  expect(screen.getByLabelText('文本与要求提取模型名称')).toHaveValue('private-model');
  expect(screen.getByLabelText(/文本与要求提取 temperature/)).toHaveValue(0.4);
  fireEvent.change(screen.getByLabelText(/文本与要求提取供应商/), { target: { value: 'deepseek' } });
  expect(screen.getByLabelText(/文本与要求提取 API key/)).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: '保存配置并停用 AI' }));
  await screen.findByText('配置已保存，AI 暂停启用。请逐项测试。');
  expect(mock).toHaveBeenCalledTimes(2);
});
