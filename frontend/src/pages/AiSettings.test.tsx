import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AiSettings } from './AiSettings';

async function setup(admin = true, advanced = true) { const client = new QueryClient(); client.setQueryData(['session'], { id: 'account', username: 'member', email: null, displayName: 'member', isAdmin: admin, role: admin ? 'super_admin' : 'user' }); render(<QueryClientProvider client={client}><AiSettings /></QueryClientProvider>); if (admin) await waitFor(() => expect(screen.getByRole('button', { name: '保存配置' })).toBeEnabled()); if (advanced && admin) fireEvent.change(screen.getByLabelText('模型路由模式'), { target: { value: 'advanced' } }); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('defaults legacy audio strategy to Whisper and saves strategy independently without paid probes', async () => {
  const calls:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch', vi.fn(async (_url:string,init?:RequestInit) => {
    if(init?.method==='GET') return Response.json({data:{version:8,enabled:true,config:savedConfig}});
    expect(init?.method).toBe('PUT'); calls.push(JSON.parse(String(init?.body))); return Response.json({data:{version:9,enabled:true}});
  }));
  await setup(true,false);
  expect(screen.getByLabelText(/音频文件处理策略/)).toHaveValue('whisper-first');
  expect(screen.getByText(/全部检查评分至少 0.85/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/音频文件处理策略/), {target:{value:'media-only'}});
  fireEvent.click(screen.getByRole('button',{name:'保存配置'}));
  await screen.findByText('配置已保存，AI 保持启用。');
  expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({processingStrategies:{audioFiles:'media-only',rehearsal:'text'},audioProcessingStrategy:'gemini-only',expectedVersion:8,unified:{model:savedConfig.unified.model,apiKey:''}});
});
it.each(['deepseek-flash', 'deepseek-v4-pro'])('saved unified %s offers every supported DeepSeek effort without consulting advanced drafts', async modelId => {
  const deepseek = { provider: 'openai-compatible', providerPreset: 'deepseek', model: modelId, apiUrl: 'https://api.deepseek.com/chat/completions', keyConfigured: true, timeoutMs: 90000, maxInputChars: 48000, maxOutputTokens: 4096, supportsJson: true, supportsVision: false, pricePerMTokens: null };
  const legacy = { ...deepseek, provider: 'workers-ai', providerPreset: undefined, model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', apiUrl: '' };
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 3, enabled: false, config: { routingMode: 'unified', unified: deepseek, textEconomy: legacy, visionEconomy: legacy, review: legacy } } }));
    expect(init?.method).toBe('PUT');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ expectedVersion: 3, routingMode: 'unified', unified: { providerPreset: 'deepseek', model: modelId, reasoningEffort: 'none', maxOutputTokens: 4096 } });
    return new Response(JSON.stringify({ data: { version: 4, enabled: false } }));
  });
  vi.stubGlobal('fetch', mock); await setup(true, false);
  await screen.findByText('当前 AI 未启用。');
  const effort = screen.getByLabelText(/统一模型思考强度/);
  expect(within(effort).getAllByRole('option').map(o => (o as HTMLOptionElement).value)).toEqual(['', 'none', 'low', 'high', 'max']);
  for (const value of ['low', 'high', 'max', 'none']) { fireEvent.change(effort, { target: { value } }); expect(effort).toHaveValue(value); }
  fireEvent.change(screen.getByLabelText('模型路由模式'), { target: { value: 'advanced' } });
  expect(within(screen.getByLabelText(/文本与要求提取思考强度/)).getAllByRole('option')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('模型路由模式'), { target: { value: 'unified' } });
  expect(screen.getByLabelText(/统一模型思考强度/)).toHaveValue('none');
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  expect(mock).toHaveBeenCalledTimes(2);
});
it('system admin session saves blank configuration, tests connections, and cannot enable failed probes', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 0, enabled: false, config: {} } }));
    const body = JSON.parse(String(init?.body));
    expect(new Headers(init?.headers).has('authorization')).toBe(false); expect(init?.credentials).toBe('same-origin');
    if (init?.method === 'PUT') {
      expect(body.textEconomy.apiUrl).toBe(''); expect(body.textEconomy.apiKey).toBe(''); expect(body.enabled).toBeUndefined();
      return new Response(JSON.stringify({ data: { version: 2, enabled: false } }));
    }
    return new Response(JSON.stringify({ data: { passed: false, configVersion: 2, checks: [{ name: 'chinese_text', passed: false, detail: '请填写 API URL、key 和模型名称' }] } }));
  });
  vi.stubGlobal('fetch', fetchMock); await setup();
  const enable = screen.getByRole('button', { name: '全部测试通过后启用 AI' }); expect(enable).toBeDisabled();
  expect(screen.getByRole('button', { name: '保存配置' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  fireEvent.click(screen.getByRole('button', { name: /测试.*文本与要求提取.*连接与能力/ }));
  await waitFor(() => expect(screen.getByText(/请填写 API URL、key 和模型名称/)).toBeInTheDocument());
  expect(enable).toBeDisabled(); expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(screen.getByRole('button', { name: '保存配置' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it('ordinary account cannot save with a session alone; token fallback errors are explicit', async () => {
  const mock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), { status: 401 }));
  vi.stubGlobal('fetch', mock); await setup(false);
  const save = screen.getByRole('button', { name: '保存配置' }); expect(save).toBeDisabled();
  fireEvent.click(screen.getByText('运维管理员令牌模式（可选）'));
  fireEvent.change(screen.getByLabelText(/管理员令牌/), { target: { value: 'wrong-token' } });
  fireEvent.click(screen.getByRole('button', { name: /读取已保存配置/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('管理员令牌无效或已失效');
  expect(new Headers(mock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer wrong-token');
  expect(localStorage.length).toBe(0);
});

it('Go has independent manual protocol and bounded headers, never automatically probes', async () => {
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 0, enabled: false, config: {} } }));
    const body = JSON.parse(String(init?.body));
    expect(init?.method).toBe('PUT');
    expect(body.textEconomy).toMatchObject({ providerPreset: 'opencode-go', apiProtocol: 'messages', model: 'minimax-m3', apiUrl: 'https://opencode.ai/zen/go/v1/messages', apiKey: 'new-key', clearKey: true, goUsageAcknowledged: true, goHeaders: { userAgent: 'MyOffice/1.2', sessionPrefix: 'office' } });
    expect(body.textEconomy.supportsJson).toBe(false); expect(body.enabled).toBeUndefined();
    return new Response(JSON.stringify({ data: { version: 2, enabled: false } }));
  });
  vi.stubGlobal('fetch', mock); await setup();
  fireEvent.change(screen.getByLabelText(/文本与要求提取供应商/), { target: { value: 'opencode-go' } });
  expect(mock).toHaveBeenCalledOnce(); // Initial sanitized configuration load only.
  expect(screen.getByText(/本应用含项目写作、分工和验收/)).toBeInTheDocument();
  const save = screen.getByRole('button', { name: '保存配置' }); expect(save).toBeEnabled();
  fireEvent.click(screen.getByLabelText('我已确认套餐适用于本应用用途'));
  const protocol = screen.getByLabelText(/文本与要求提取 API 协议/); expect(protocol).toBeEnabled();
  fireEvent.change(protocol, { target: { value: 'messages' } });
  expect(save).toBeEnabled(); // Invalid options are reported on save; the button remains available.
  fireEvent.change(screen.getByLabelText('文本与要求提取模型名称'), { target: { value: 'minimax-m3' } });
  fireEvent.change(screen.getByLabelText(/文本与要求提取 Go User-Agent/), { target: { value: 'opencode/1.0' } });
  expect(save).toBeEnabled();
  fireEvent.change(screen.getByLabelText(/文本与要求提取 Go User-Agent/), { target: { value: 'MyOffice/1.2' } });
  fireEvent.change(screen.getByLabelText(/文本与要求提取 Go 会话前缀/), { target: { value: 'office' } });
  fireEvent.change(screen.getByLabelText(/文本与要求提取 API key/), { target: { value: 'new-key' } });
  expect(save).toBeEnabled(); fireEvent.click(save);
  await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  expect(mock).toHaveBeenCalledTimes(2); expect(localStorage.length).toBe(0);
  expect(screen.getByLabelText(/文本与要求提取 API key/)).toHaveValue('');
});

it('OpenAI options follow model capability and explicit protocol; invalid hidden effort is cleared on model switch', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { version: 0, enabled: false, config: {} } }))));
  await setup();
  fireEvent.change(screen.getByLabelText(/文本与要求提取供应商/), { target: { value: 'openai' } });
  fireEvent.change(screen.getByLabelText('文本与要求提取模型名称'), { target: { value: 'gpt-5.4' } });
  fireEvent.change(screen.getByLabelText(/文本与要求提取思考强度/), { target: { value: 'high' } });
  fireEvent.change(screen.getByLabelText(/文本与要求提取 temperature/), { target: { value: '0.5' } });
  expect(screen.getByRole('button', { name: '保存配置' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText(/文本与要求提取思考强度/), { target: { value: 'none' } });
  expect(screen.getByRole('button', { name: '保存配置' })).toBeEnabled();
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
    expect(body.review).toMatchObject(model); expect(body.enabled).toBeUndefined();
    return new Response(JSON.stringify({ data: { version: 6, enabled: false } }));
  });
  vi.stubGlobal('fetch', mock); await setup();
  await screen.findByText('当前 AI 已启用。');
  expect(screen.getByLabelText('文本与要求提取模型名称')).toHaveValue('private-model');
  expect(screen.getByLabelText(/文本与要求提取 temperature/)).toHaveValue(0.4);
  fireEvent.change(screen.getByLabelText(/文本与要求提取供应商/), { target: { value: 'deepseek' } });
  expect(screen.getByLabelText(/文本与要求提取 API key/)).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  expect(mock).toHaveBeenCalledTimes(2);
});

it('unified mode preserves advanced drafts, sends one independent model and version, and does not probe automatically', async () => {
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 0, enabled: false, config: {} } }));
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ routingMode: 'unified', expectedVersion: 0, unified: { model: 'one-model', apiKey: 'test-only-key' }, textEconomy: { model: 'advanced-draft', apiKey: '' } });
    return new Response(JSON.stringify({ data: { version: 1, enabled: false } }));
  });
  vi.stubGlobal('fetch', mock); await setup(true, false);
  expect(screen.queryByLabelText('文本与要求提取模型名称')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('统一模型模型名称'), { target: { value: 'one-model' } });
  fireEvent.change(screen.getByLabelText(/统一模型 API key/), { target: { value: 'test-only-key' } });
  fireEvent.change(screen.getByLabelText('模型路由模式'), { target: { value: 'advanced' } });
  fireEvent.change(screen.getByLabelText('文本与要求提取模型名称'), { target: { value: 'advanced-draft' } });
  fireEvent.change(screen.getByLabelText('模型路由模式'), { target: { value: 'unified' } });
  expect(screen.getByLabelText('统一模型模型名称')).toHaveValue('one-model');
  expect(screen.getByLabelText(/统一模型 API key/)).toHaveValue('test-only-key');
  expect(mock).toHaveBeenCalledOnce(); // Initial sanitized configuration load only.
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  expect(screen.getByLabelText(/统一模型 API key/)).toHaveValue('');
  expect(localStorage.length).toBe(0);
});

it('text-only unified mode enables after both text probes, requires vision probe when declared, and invalidates reports on mode changes', async () => {
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 0, enabled: false, config: {} } }));
    const body = JSON.parse(String(init?.body));
    if (init?.method === 'PUT') return new Response(JSON.stringify({ data: { version: 1, enabled: false } }));
    expect(body.purpose).not.toBe('visionEconomy');
    return new Response(JSON.stringify({ data: { passed: true, configVersion: 1, checks: [] } }));
  });
  vi.stubGlobal('fetch', mock); await setup(true, false);
  expect(screen.getByRole('note')).toHaveTextContent('图片 / OCR 不可用');
  expect(screen.queryByRole('button', { name: /测试图片/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  const enable = screen.getByRole('button', { name: '全部测试通过后启用 AI' });
  fireEvent.click(screen.getByRole('button', { name: /测试文本/ }));
  await screen.findByText(/^测试通过 · 配置/); expect(enable).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /测试预审/ }));
  await waitFor(() => expect(enable).toBeEnabled());
  fireEvent.click(screen.getByLabelText(/声明模型支持图片输入/));
  expect(enable).toBeDisabled(); expect(screen.getByRole('button', { name: /测试图片/ })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('模型路由模式'), { target: { value: 'advanced' } });
  expect(screen.queryByText(/^测试通过 · 配置/)).not.toBeInTheDocument();
});

it('loads sanitized unified config and retains draft on optimistic version conflict', async () => {
  const model = { provider: 'openai-compatible', model: 'saved-unified', apiUrl: 'https://test.example/v1/chat/completions', keyConfigured: true, timeoutMs: 30000, maxInputChars: 42000, maxOutputTokens: 1500, supportsJson: false, supportsVision: false, pricePerMTokens: null };
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 7, enabled: false, config: { routingMode: 'unified', unified: model, textEconomy: model, visionEconomy: model, review: model } } }));
    const body = JSON.parse(String(init?.body)); expect(body.expectedVersion).toBe(7); expect(body.unified.apiKey).toBe('');
    return new Response(JSON.stringify({ error: { message: '配置版本已变化，请重新读取' } }), { status: 409 });
  });
  vi.stubGlobal('fetch', mock); await setup(true, false);
  await screen.findByText('当前 AI 未启用。');
  expect(screen.getByLabelText(/统一模型 API key/)).toHaveValue('');
  fireEvent.change(screen.getByLabelText('统一模型模型名称'), { target: { value: 'unsaved-change' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('统一模型模型名称')).toHaveValue('unsaved-change');
  expect(screen.getByRole('button', { name: '全部测试通过后启用 AI' })).toBeDisabled();
  expect(screen.queryByText(/^配置已保存/)).not.toBeInTheDocument();
});

const savedModel = { provider: 'openai-compatible', model: 'saved-model', apiUrl: 'https://test.example/v1/chat/completions', keyConfigured: true, timeoutMs: 30000, maxInputChars: 42000, maxOutputTokens: 1500, supportsJson: false, supportsVision: false, pricePerMTokens: null };
const savedConfig = { routingMode: 'unified', unified: savedModel, textEconomy: savedModel, visionEconomy: savedModel, review: savedModel };

it('saves the explicit off switch while retaining a value above the former maximum and makes no model call', async () => {
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return Response.json({ data: { version: 4, enabled: true, config: savedConfig } });
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toMatchObject({ unified: { enabledOutputLimit: false, maxOutputTokens: 65536 }, textEconomy: { enabledOutputLimit: true, maxOutputTokens: 1500 } });
    return Response.json({ data: { version: 5, enabled: false } });
  });
  vi.stubGlobal('fetch', mock); await setup(true, false);
  fireEvent.change(screen.getByLabelText(/统一模型最大输出 token/), { target: { value: '65536' } });
  fireEvent.click(screen.getByLabelText('启用统一模型输出 token 上限'));
  expect(screen.getByLabelText(/统一模型最大输出 token/)).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  expect(screen.getByTestId('saved-token-limits')).toHaveTextContent('统一模型 已关闭（保留 65536 token）');
  expect(mock).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByLabelText('启用统一模型输出 token 上限'));
  expect(screen.getByLabelText(/统一模型最大输出 token/)).toHaveValue(65536);
});

it('preserves a saved disabled switch and its retained numeric value on load', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { version: 7, enabled: true, config: { ...savedConfig, unified: { ...savedModel, enabledOutputLimit: false, maxOutputTokens: 70000 } } } })));
  await setup(true, false);
  expect(screen.getByLabelText('启用统一模型输出 token 上限')).not.toBeChecked();
  expect(screen.getByLabelText(/统一模型最大输出 token/)).toHaveValue(70000);
  expect(screen.getByLabelText(/统一模型最大输出 token/)).toBeDisabled();
});

it('prominent unified output limit retains the saved value and inactive purpose limits until explicitly saved', async () => {
  const persisted = { ...savedConfig, unified: { ...savedModel, maxOutputTokens: 9876 }, textEconomy: { ...savedModel, maxOutputTokens: 2100 }, visionEconomy: { ...savedModel, maxOutputTokens: 3200 }, review: { ...savedModel, maxOutputTokens: 4300 } };
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 11, enabled: true, config: persisted } }));
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ expectedVersion: 11, unified: { maxOutputTokens: 12345, apiKey: '', keyConfigured: true }, textEconomy: { maxOutputTokens: 2100 }, visionEconomy: { maxOutputTokens: 3200 }, review: { maxOutputTokens: 4300 } });
    expect(body).not.toHaveProperty('enabled');
    return new Response(JSON.stringify({ data: { version: 12, enabled: false } }));
  });
  vi.stubGlobal('fetch', mock); await setup(true, false);
  const limits = screen.getByRole('group', { name: '全局输出 token 上限' });
  const input = within(limits).getByLabelText(/统一模型最大输出 token/);
  expect(input).toHaveValue(9876); expect(input).toHaveAttribute('min', '1'); expect(input).not.toHaveAttribute('max'); expect(input).toHaveAttribute('step', '1');
  expect(screen.getByLabelText('启用统一模型输出 token 上限')).toBeChecked();
  expect(screen.getByTestId('saved-token-limits')).toHaveTextContent('已保存 v11：统一模型 9876 token / 次');
  fireEvent.change(input, { target: { value: '12345' } });
  expect(screen.getByTestId('saved-token-limits')).toHaveTextContent('统一模型 9876 token / 次');
  expect(mock).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  expect(screen.getByTestId('saved-token-limits')).toHaveTextContent('已保存 v12：统一模型 12345 token / 次');
  expect(mock).toHaveBeenCalledTimes(2);
  expect(within(limits).getByText(/累计费用预算/)).toHaveTextContent('美元（USD）');
  expect(within(limits).getByText(/单位是每次请求/)).toHaveTextContent('思考 token');
});

it('advanced output limits remain independent across routing-mode changes without materializing an untouched unified slot', async () => {
  const persisted = { textEconomy: { ...savedModel, maxOutputTokens: 1024 }, visionEconomy: { ...savedModel, maxOutputTokens: 8192 }, review: { ...savedModel, maxOutputTokens: 16384 } };
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 8, enabled: false, config: persisted } }));
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ routingMode: 'advanced', expectedVersion: 8, textEconomy: { maxOutputTokens: 1024 }, visionEconomy: { maxOutputTokens: 8192 }, review: { maxOutputTokens: 32768 } });
    expect(body).not.toHaveProperty('unified');
    return new Response(JSON.stringify({ data: { version: 9, enabled: false } }));
  });
  vi.stubGlobal('fetch', mock); await setup(true, false);
  expect(screen.getByLabelText(/文本与要求提取最大输出 token/)).toHaveValue(1024);
  expect(screen.getByLabelText(/图片与 OCR最大输出 token/)).toHaveValue(8192);
  fireEvent.change(screen.getByLabelText(/预审与答辩最大输出 token/), { target: { value: '32768' } });
  fireEvent.change(screen.getByLabelText('模型路由模式'), { target: { value: 'unified' } });
  expect(screen.getByTestId('saved-token-limits')).toHaveTextContent('预审与答辩 16384 token / 次');
  fireEvent.change(screen.getByLabelText('模型路由模式'), { target: { value: 'advanced' } });
  expect(screen.getByLabelText(/预审与答辩最大输出 token/)).toHaveValue(32768);
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  expect(mock).toHaveBeenCalledTimes(2);
});

it.each(['0', '9007199254740992', '1.5'])('rejects invalid output token limit %s without saving or running a model probe', async value => {
  const mock = vi.fn(async () => new Response(JSON.stringify({ data: { version: 4, enabled: true, config: savedConfig } })));
  vi.stubGlobal('fetch', mock); await setup(true, false);
  fireEvent.change(screen.getByLabelText(/统一模型最大输出 token/), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('输出上限必须为可安全表示的正整数 token');
  expect(screen.getByTestId('saved-token-limits')).toHaveTextContent('统一模型 1500 token / 次');
  expect(mock).toHaveBeenCalledOnce();
});

it('unchanged save preserves enabled state without requiring or making a connection probe', async () => {
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 4, enabled: true, config: savedConfig } }));
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(String(init?.body))).toMatchObject({ expectedVersion: 4 });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty('enabled');
    return new Response(JSON.stringify({ data: { version: 5, enabled: true } }));
  });
  vi.stubGlobal('fetch', mock); await setup(true, false);
  await screen.findByText('当前 AI 已启用。');
  expect(screen.getByRole('button', { name: '全部测试通过后启用 AI' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 保持启用。');
  expect(mock).toHaveBeenCalledTimes(2);
});

it('edited enabled config saves independently and displays the safely disabled server result', async () => {
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 4, enabled: true, config: savedConfig } }));
    const body = JSON.parse(String(init?.body));
    expect(body.unified.model).toBe('edited-model');
    expect(body).not.toHaveProperty('enabled');
    return new Response(JSON.stringify({ data: { version: 5, enabled: false } }));
  });
  vi.stubGlobal('fetch', mock); await setup(true, false);
  await screen.findByText('当前 AI 已启用。');
  fireEvent.change(screen.getByLabelText('统一模型模型名称'), { target: { value: 'edited-model' } });
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  expect(screen.getByText(/已保存配置 v5 · AI 未启用/)).toBeInTheDocument();
  expect(mock).toHaveBeenCalledTimes(2);
});

it('disable sends only the saved version and false, preserving invalid provider drafts and unsaved keys', async () => {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 7, enabled: true, config: savedConfig } }));
    expect(url).toBe('/api/v1/admin/ai-config/disable');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ expectedVersion: 7, enabled: false });
    return new Response(JSON.stringify({ data: { version: 8, enabled: false } }));
  });
  vi.stubGlobal('fetch', mock); await setup(true, false);
  await screen.findByText('当前 AI 已启用。');
  fireEvent.change(screen.getByLabelText(/统一模型供应商/), { target: { value: 'opencode-go' } });
  fireEvent.change(screen.getByLabelText(/统一模型 API key/), { target: { value: 'unsaved-key' } });
  expect(screen.getByRole('button', { name: '停用 AI' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '停用 AI' }));
  await screen.findByText('AI 已停用。未保存的表单修改已保留，请点击保存配置后再测试。');
  expect(screen.getByLabelText(/统一模型供应商/)).toHaveValue('opencode-go');
  expect(screen.getByLabelText(/统一模型 API key/)).toHaveValue('unsaved-key');
  expect(screen.getByLabelText('我已确认套餐适用于本应用用途')).not.toBeChecked();
  expect(screen.getByRole('button', { name: '保存配置' })).toBeEnabled();
  expect(screen.getByRole('button', { name: /测试文本/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: '全部测试通过后启用 AI' })).toBeDisabled();
  expect(mock).toHaveBeenCalledTimes(2);
  expect(localStorage.length).toBe(0);
});

it('disable CAS failure leaves enabled status, version and the unsaved form intact without success', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 7, enabled: true, config: savedConfig } }));
    return new Response(JSON.stringify({ requestId: 'fixture-conflict', error: { code: 'VERSION_CONFLICT', message: '配置已被其他管理员更新' } }), { status: 409 });
  }));
  await setup(true, false);
  await screen.findByText('当前 AI 已启用。');
  fireEvent.change(screen.getByLabelText('统一模型模型名称'), { target: { value: 'draft-model' } });
  fireEvent.click(screen.getByRole('button', { name: '停用 AI' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('配置已被其他管理员更新');
  expect(screen.getByLabelText('统一模型模型名称')).toHaveValue('draft-model');
  expect(screen.getByText(/已保存配置 v7 · AI 已启用/)).toBeInTheDocument();
  expect(screen.queryByText(/^AI 已停用/)).not.toBeInTheDocument();
});

it('save validation is explicit and leaves the button and form available without a fake success', async () => {
  const mock = vi.fn(async () => new Response(JSON.stringify({ data: { version: 0, enabled: false, config: {} } }))); vi.stubGlobal('fetch', mock); await setup(true, false);
  fireEvent.change(screen.getByLabelText(/统一模型供应商/), { target: { value: 'opencode-go' } });
  fireEvent.change(screen.getByLabelText(/统一模型 API key/), { target: { value: 'unsaved-key' } });
  const save = screen.getByRole('button', { name: '保存配置' });
  expect(save).toBeEnabled();
  fireEvent.click(save);
  expect(await screen.findByRole('alert')).toHaveTextContent('配置未保存');
  expect(save).toBeEnabled();
  expect(screen.getByLabelText(/统一模型 API key/)).toHaveValue('unsaved-key');
  expect(screen.queryByText(/^配置已保存/)).not.toBeInTheDocument();
  expect(mock).toHaveBeenCalledOnce(); // Initial sanitized configuration load only.
  expect(localStorage.length).toBe(0);
});

it('opens with the saved version automatically and uses each new version for consecutive saves', async () => {
  let version = 7;
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.cache).toBe('no-store');
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version, enabled: false, config: savedConfig } }));
    const body = JSON.parse(String(init?.body));
    expect(body.expectedVersion).toBe(version);
    expect(body).not.toHaveProperty('enabled');
    return new Response(JSON.stringify({ data: { version: ++version, enabled: false } }));
  });
  vi.stubGlobal('fetch', mock); await setup(true, false);
  expect(screen.getByLabelText('统一模型模型名称')).toHaveValue('saved-model');
  for (const name of ['first-change', 'second-change']) {
    fireEvent.change(screen.getByLabelText('统一模型模型名称'), { target: { value: name } });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  }
  expect(version).toBe(9);
  expect(mock).toHaveBeenCalledTimes(3);
});

it('probe does not advance the version and enable uses the saved and tested version', async () => {
  let version = 7;
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version, enabled: false, config: savedConfig } }));
    const body = JSON.parse(String(init?.body));
    if (init?.method === 'POST') return new Response(JSON.stringify({ data: { passed: true, configVersion: version, checks: [] } }));
    expect(body.expectedVersion).toBe(version);
    if (version === 7) expect(body).not.toHaveProperty('enabled');
    else expect(body.enabled).toBe(true);
    return new Response(JSON.stringify({ data: { version: ++version, enabled: Boolean(body.enabled) } }));
  });
  vi.stubGlobal('fetch', mock); await setup(true, false);
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  fireEvent.click(screen.getByRole('button', { name: /测试文本/ }));
  await screen.findByText('测试通过 · 配置 v8');
  fireEvent.click(screen.getByRole('button', { name: /测试预审/ }));
  await waitFor(() => expect(screen.getByRole('button', { name: '全部测试通过后启用 AI' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '全部测试通过后启用 AI' }));
  await screen.findByText('AI 已启用，可继续真实业务测试。');
  expect(version).toBe(9);
  expect(mock).toHaveBeenCalledTimes(5);
});

it('disabling with a draft advances expectedVersion and a later save retains the draft', async () => {
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 7, enabled: true, config: savedConfig } }));
    const body = JSON.parse(String(init?.body));
    if (init?.method === 'POST') { expect(body).toEqual({ expectedVersion: 7, enabled: false }); return new Response(JSON.stringify({ data: { version: 8, enabled: false } })); }
    expect(body.expectedVersion).toBe(8);
    expect(body.unified.model).toBe('retained-draft');
    expect(body.unified.apiKey).toBe('retained-key');
    return new Response(JSON.stringify({ data: { version: 9, enabled: false } }));
  });
  vi.stubGlobal('fetch', mock); await setup(true, false);
  fireEvent.change(screen.getByLabelText('统一模型模型名称'), { target: { value: 'retained-draft' } });
  fireEvent.change(screen.getByLabelText(/统一模型 API key/), { target: { value: 'retained-key' } });
  fireEvent.click(screen.getByRole('button', { name: '停用 AI' }));
  await screen.findByText('AI 已停用。未保存的表单修改已保留，请点击保存配置后再测试。');
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  expect(mock).toHaveBeenCalledTimes(3);
  expect(screen.getByLabelText(/统一模型 API key/)).toHaveValue('');
});

it('failed initial load blocks blind version-zero writes and can retry explicitly', async () => {
  let attempts = 0;
  const mock = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(init?.method).toBe('GET');
    if (++attempts === 1) throw new Error('offline');
    return new Response(JSON.stringify({ data: { version: 7, enabled: false, config: savedConfig } }));
  });
  vi.stubGlobal('fetch', mock);
  const client = new QueryClient(); client.setQueryData(['session'], { id: 'account', role: 'super_admin' });
  render(<QueryClientProvider client={client}><AiSettings /></QueryClientProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('无法连接服务');
  expect(screen.getByRole('button', { name: '保存配置' })).toBeDisabled();
  expect(screen.getByLabelText('统一模型模型名称')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '读取已保存配置' }));
  await screen.findByText('当前 AI 未启用。');
  expect(screen.getByRole('button', { name: '保存配置' })).toBeEnabled();
  expect(screen.getByText(/已保存配置 v7/)).toBeInTheDocument();
  expect(mock).toHaveBeenCalledTimes(2);
});

it('a late initial response cannot overwrite an edited draft; explicit reload names its discard', async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const client = new QueryClient(); client.setQueryData(['session'], { id: 'account', role: 'super_admin' });
  render(<QueryClientProvider client={client}><AiSettings /></QueryClientProvider>);
  expect(screen.getByRole('button', { name: '保存配置' })).toBeDisabled();
  // Defensive race: an external change event arrives despite the loading fieldset.
  fireEvent.change(screen.getByLabelText('统一模型模型名称'), { target: { value: 'late-response-draft' } });
  resolve(new Response(JSON.stringify({ data: { version: 7, enabled: false, config: savedConfig } })));
  await screen.findByText('已读取配置版本，编辑中的表单已保留，尚未保存。');
  expect(screen.getByLabelText('统一模型模型名称')).toHaveValue('late-response-draft');
  expect(screen.getByRole('button', { name: '丢弃修改并读取已保存配置' })).toBeEnabled();
  expect(screen.getByText(/已保存配置 v7/)).toBeInTheDocument();
});

it('untouched legacy advanced config does not invent a unified draft or force a config change on save', async () => {
  const legacy = { textEconomy: savedModel, visionEconomy: savedModel, review: savedModel };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 7, enabled: true, config: legacy } }));
    const body = JSON.parse(String(init?.body));
    expect(body.routingMode).toBe('advanced');
    expect(body).not.toHaveProperty('unified');
    expect(body).not.toHaveProperty('enabled');
    return new Response(JSON.stringify({ data: { version: 8, enabled: true } }));
  }));
  await setup(true, false);
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 保持启用。');
});

it('explains the required Messages cap and rejects an off switch without saving or probing', async () => {
  const unified = { ...savedModel, providerPreset: 'anthropic', apiProtocol: 'messages', model: 'claude-sonnet-4-6', apiUrl: 'https://api.anthropic.com/v1/messages', enabledOutputLimit: true };
  const mock = vi.fn(async () => Response.json({ data: { version: 8, enabled: true, config: { ...savedConfig, unified } } }));
  vi.stubGlobal('fetch', mock); await setup(true, false);
  fireEvent.click(screen.getByLabelText('启用统一模型输出 token 上限'));
  expect(screen.getByText(/Messages 协议必填 max_tokens，必须启用输出上限/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Messages 协议必填 max_tokens');
  expect(mock).toHaveBeenCalledOnce();
});

it('editing an OpenCode preset URL converts to custom and preserves explicit key, model and inferred protocol', async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'GET') return new Response(JSON.stringify({ data: { version: 0, enabled: false, config: {} } }));
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ data: { version: 1, enabled: false } }));
  }));
  await setup();
  fireEvent.change(screen.getByLabelText(/文本与要求提取供应商/), { target: { value: 'opencode-zen' } });
  fireEvent.change(screen.getByLabelText(/文本与要求提取 API key/), { target: { value: 'explicit-draft-key' } });
  fireEvent.change(screen.getByLabelText(/文本与要求提取 API URL/), { target: { value: 'https://proxy.example/v1/chat/completions' } });
  expect(screen.getByLabelText(/文本与要求提取供应商/)).toHaveValue('custom');
  expect(screen.getByLabelText(/文本与要求提取 API key/)).toHaveValue('explicit-draft-key');
  fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
  await screen.findByText('配置已保存，AI 未启用。连接测试失败不影响保存；启用前请逐项测试。');
  expect(requests[0]).toMatchObject({ textEconomy: { providerPreset: 'custom', apiKey: 'explicit-draft-key', apiUrl: 'https://proxy.example/v1/chat/completions', apiProtocol: 'chat-completions' } });
});

 it('preserves independent media config in unified mode and probes only free metadata',async()=>{
  const media={...savedModel,providerPreset:'gemini',model:'gemini-2.5-flash',apiUrl:'https://generativelanguage.googleapis.com',keyConfigured:true,mediaInputPricePerMTokens:{audio:1,video:2,text:.5}};
  const calls:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{if(init?.method==='GET')return Response.json({data:{version:8,enabled:true,config:{...savedConfig,mediaUnderstanding:media}}});if(url.endsWith('/media-probe'))return Response.json({data:{passed:true,detail:'元数据通过'}});calls.push(JSON.parse(String(init?.body)));return Response.json({data:{version:9,enabled:true}});}));
  await setup(true,false);
  expect(screen.getByLabelText('音视频 Gemini 模型')).toHaveValue('gemini-2.5-flash');
  fireEvent.click(screen.getByRole('button',{name:'测试音视频模型元数据（不生成）'}));await screen.findByText('元数据通过');
  fireEvent.change(screen.getByLabelText('统一模型模型名称'),{target:{value:'deepseek-v4-pro'}});
  expect(screen.getByLabelText('音视频 Gemini 模型')).toHaveValue('gemini-2.5-flash');
  fireEvent.click(screen.getByRole('button',{name:'保存配置'}));await screen.findByText('配置已保存，AI 保持启用。');
  expect(calls[0]).toMatchObject({mediaUnderstanding:{model:'gemini-2.5-flash',apiKey:'',mediaInputPricePerMTokens:{audio:1,video:2,text:.5}},clearMediaUnderstanding:false});
 });

it('separates fixed Whisper, realtime Gateway, TTS and strategies without copying media credentials', async () => {
  const writes:Record<string,unknown>[]=[];
  const realtime={provider:'google-ai-studio',model:'gemini-3.5-transcribe-live',gatewayId:'voice-gateway',languageCodes:['zh-CN'],keyConfigured:true,gatewayTokenConfigured:true};
  vi.stubGlobal('fetch',vi.fn(async (_url:string,init?:RequestInit)=>init?.method==='GET'?Response.json({data:{version:8,enabled:true,config:{...savedConfig,realtimeAudioTranscription:realtime}}}):(writes.push(JSON.parse(String(init?.body))),Response.json({data:{version:9,enabled:true}}))));
  await setup(true,false);
  for(const title of ['音视频理解模型','音频文件初步转录模型','实时语音转录模型','答辩语音朗读','音频与答辩处理策略'])expect(screen.getByRole('heading',{name:title})).toBeInTheDocument();
  expect(screen.getByLabelText('文件转录模型')).toHaveValue('@cf/openai/whisper-large-v3-turbo');
  expect(screen.getByLabelText('文件转录模型')).toHaveAttribute('readonly');
  const fileCard=screen.getByRole('heading',{name:'音频文件初步转录模型'}).closest('section')!;
  expect(within(fileCard).getAllByRole('textbox')).toHaveLength(1);
  expect(fileCard.textContent).toBe('音频文件初步转录模型文件转录模型');
  expect(within(fileCard).queryByText(/binding|供应商|API URL|密钥|转录通过/i)).not.toBeInTheDocument();
  expect(screen.getByLabelText(/实时语音 Google API key/)).toHaveValue('');expect(screen.getByLabelText(/^实时语音 Gateway token/)).toHaveValue('');
  expect(screen.queryByLabelText('答辩朗读模型')).not.toBeInTheDocument();
  expect(screen.getByLabelText(/^朗读语言/)).toHaveValue('zh-CN');
  fireEvent.change(screen.getByLabelText(/^朗读语速/),{target:{value:'1.5'}});
  fireEvent.change(screen.getByLabelText(/^朗读音量/),{target:{value:'0.7'}});
  fireEvent.change(screen.getByLabelText('模拟答辩处理策略'),{target:{value:'voice-with-text-fallback'}});
  fireEvent.click(screen.getByRole('button',{name:'保存配置'}));
  await screen.findByText('配置已保存，AI 保持启用。');
  expect(writes).toHaveLength(1);expect(writes[0]).toMatchObject({processingStrategies:{audioFiles:'whisper-first',rehearsal:'voice-with-text-fallback'},rehearsalSpeech:{provider:'system-local',lang:'zh-CN',rate:1.5,volume:.7},realtimeAudioTranscription:{gatewayId:'voice-gateway',apiKey:'',gatewayToken:''}});
  expect(writes[0].realtimeAudioTranscription).not.toHaveProperty('keyConfigured');expect(writes[0].realtimeAudioTranscription).not.toHaveProperty('gatewayTokenConfigured');expect(writes[0]).not.toHaveProperty('enabled');
});
it('saves incomplete realtime drafts, explicitly clears individual credentials and removes the entire slot',async()=>{
  const writes:Record<string,unknown>[]=[];let version=8;
  vi.stubGlobal('fetch',vi.fn(async (_url:string,init?:RequestInit)=>init?.method==='GET'?Response.json({data:{version,enabled:true,config:{...savedConfig,realtimeAudioTranscription:{provider:'google-ai-studio',model:'gemini-3.5-transcribe-live',gatewayId:'voice-gateway',keyConfigured:true,gatewayTokenConfigured:true}}}}):(writes.push(JSON.parse(String(init?.body))),Response.json({data:{version:++version,enabled:true}}))));
  await setup(true,false);
  fireEvent.click(screen.getByLabelText('清除实时语音 Google 密钥'));fireEvent.click(screen.getByLabelText('清除实时语音 Gateway token'));
  fireEvent.change(screen.getByLabelText('模拟答辩处理策略'),{target:{value:'voice-with-text-fallback'}});expect(screen.getByText(/实时语音配置尚不完整，答辩将回退文字/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/实时语音 Gateway ID/),{target:{value:''}});
  fireEvent.click(screen.getByRole('button',{name:'保存配置'}));await screen.findByText('配置已保存，AI 保持启用。');
  expect(writes[0]).toMatchObject({realtimeAudioTranscription:{clearKey:true,clearGatewayToken:true,gatewayId:''},clearRealtimeAudioTranscription:false});
  fireEvent.click(screen.getByLabelText('配置实时语音转录'));fireEvent.click(screen.getByRole('button',{name:'保存配置'}));
  await waitFor(()=>expect(writes).toHaveLength(2));expect(writes[1]).toMatchObject({clearRealtimeAudioTranscription:true});expect(writes[1]).not.toHaveProperty('realtimeAudioTranscription');
});
it('clears loaded realtime credentials and disables audio controls when administrator session is downgraded',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:{version:8,enabled:true,config:{...savedConfig,realtimeAudioTranscription:{provider:'google-ai-studio',model:'gemini-3.5-transcribe-live',gatewayId:'voice-gateway',keyConfigured:true,gatewayTokenConfigured:true}}}})));
  const client=new QueryClient();client.setQueryData(['session'],{id:'account',role:'super_admin'});
  render(<QueryClientProvider client={client}><AiSettings/></QueryClientProvider>);
  await waitFor(()=>expect(screen.getByRole('button',{name:'保存配置'})).toBeEnabled());
  fireEvent.change(screen.getByLabelText(/^实时语音 Google API key/),{target:{value:'in-memory-only'}});
  const {act}=await import('@testing-library/react');await act(async()=>{client.setQueryData(['session'],{id:'account',role:'user'});});
  await waitFor(()=>expect(screen.queryByLabelText(/^实时语音 Google API key/)).not.toBeInTheDocument());expect(screen.getByRole('button',{name:'保存配置'})).toBeDisabled();
});

it('normalizes legacy cloud TTS to local defaults and sends only local speech fields',async()=>{
  const writes:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async (_url:string,init?:RequestInit)=>init?.method==='GET'?Response.json({data:{version:8,enabled:true,config:{...savedConfig,rehearsalSpeech:{model:'gemini-3.8-flash-tts',voice:'Kore'}}}}):(writes.push(JSON.parse(String(init?.body))),Response.json({data:{version:9,enabled:true}}))));
  await setup(true,false);
  expect(screen.getByLabelText(/^朗读语言/)).toHaveValue('zh-CN');expect(screen.getByLabelText(/^朗读语速/)).toHaveValue(1);expect(screen.getByLabelText(/^朗读音量/)).toHaveValue(1);
  expect(screen.getByLabelText(/^朗读语速/)).toHaveAttribute('min','0.5');expect(screen.getByLabelText(/^朗读语速/)).toHaveAttribute('max','2');expect(screen.getByLabelText(/^朗读音量/)).toHaveAttribute('max','1');
  fireEvent.change(screen.getByLabelText(/^朗读语言/),{target:{value:'en-US'}});fireEvent.click(screen.getByRole('button',{name:'保存配置'}));
  await screen.findByText('配置已保存，AI 保持启用。');
  expect(writes[0].rehearsalSpeech).toEqual({provider:'system-local',lang:'en-US',rate:1,volume:1});expect(writes[0]).not.toHaveProperty('fileTranscriptionRuntime');expect(writes[0]).not.toHaveProperty('enabled');
});
