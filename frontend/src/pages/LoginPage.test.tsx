import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LoginPage } from './LoginPage';
import type { Capability } from '../api/types';

vi.mock('../components/TurnstileChallenge', () => ({ TurnstileChallenge: ({ onToken }: { onToken: (value: string) => void }) => <button type="button" onClick={() => onToken('fixture-turnstile-token')}>完成安全验证 fixture</button> }));

const capabilities: Capability = {
  apiVersion: 'v1', environment: 'local',
  features: { aiEnabled: false, webFetch: true, emailMode: 'echo' },
  limits: { maxFileBytes: 10485760, maxPdfPages: 30, pageImageMaxEdge: 2000, pageImageMaxBytes: 2097152,
    listDefaultPageSize: 20, listMaxPageSize: 100, concurrentAiTasksPerProject: 2, assignmentSuggestionMaxTasks: 20 },
  competitionTemplate: { teamSizeLimit: 5 },
};
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data, requestId: 'test-request' }), {
  status, headers: { 'content-type': 'application/json' },
});
function setup(overrides: Partial<Capability> = {}, fail = false) {
  const caps = { ...capabilities, ...overrides };
  const mock = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.endsWith('/capabilities')) return response(caps);
    if (path.endsWith('/auth/challenges')) {
      if (fail) return new Response(JSON.stringify({ error: { code: 'EMAIL_UNAVAILABLE', message: '邮件服务未配置', retryable: true }, requestId: 'email-trace' }), {
        status: 503, headers: { 'content-type': 'application/json' },
      });
      return response({ challengeId: 'challenge-1', expiresAt: '2026-10-01', resendAfterSeconds: 60, devCode: '123456' }, 201);
    }
    if (path.endsWith('/auth/sessions') && options?.method === 'POST') return response({ user: { id: 'account-1', email: 'one@example.test', displayName: 'one' } }, 201);
    throw new Error(`Unexpected API ${path}`);
  });
  vi.stubGlobal('fetch', mock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Routes>
    <Route path="/" element={<LoginPage capabilities={caps} />} />
    <Route path="/app" element={<h1>真实工作区</h1>} />
  </Routes></MemoryRouter></QueryClientProvider>);
  return mock;
}
function submitEmail() {
  fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: 'one@example.test' } });
  fireEvent.submit(screen.getByLabelText('邮箱地址').closest('form')!);
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('real login and guest separation', () => {
  it('submits the verification form rather than re-sending a challenge on keyboard submit', async () => {
    const mock = setup();
    submitEmail();
    await screen.findByText('本地验证码已生成。');
    fireEvent.change(screen.getByPlaceholderText('000000'), { target: { value: '123456' } });
    fireEvent.submit(screen.getByLabelText('邮箱地址').closest('form')!);
    await screen.findByRole('heading', { name: '真实工作区' });
    expect(mock.mock.calls.filter(([path]) => path.endsWith('/auth/challenges'))).toHaveLength(1);
    const login = mock.mock.calls.find(([path]) => path.endsWith('/auth/sessions'));
    expect(JSON.parse(String(login?.[1]?.body))).toEqual({ email: 'one@example.test', challengeId: 'challenge-1', code: '123456' });
  });
  it('keeps the demo behind an explicit guest link and resets a challenge when the email changes', async () => {
    setup();
    expect(screen.getByRole('link', { name: /游客演示/ })).toHaveAttribute('href', '/guest/index.html');
    submitEmail();
    await screen.findByText('本地验证码已生成。');
    fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: 'two@example.test' } });
    await waitFor(() => expect(screen.queryByPlaceholderText('000000')).not.toBeInTheDocument());
    expect(screen.queryByText('123456')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '获取验证码' })).toBeEnabled();
  });
  it('does not display a returned devCode in a production environment', async () => {
    setup({ environment: 'production', features: { aiEnabled: false, webFetch: true, emailMode: 'resend' } });
    submitEmail();
    await screen.findByText('验证码已发送，请检查邮箱。');
    expect(screen.queryByText('123456')).not.toBeInTheDocument();
    expect(screen.queryByText('本地验证码回显')).not.toBeInTheDocument();
  });
  it('shows real mail failures without a fake verification success', async () => {
    setup({}, true);
    submitEmail();
    expect(await screen.findByRole('alert')).toHaveTextContent('邮件服务未配置');
    expect(screen.queryByPlaceholderText('000000')).not.toBeInTheDocument();
    expect(screen.queryByText('本地验证码已生成。')).not.toBeInTheDocument();
  });
});


it('安全验证未完成时不发邮件，完成后携带token且不回显生产验证码', async () => {
  const mock = setup({ environment: 'production', features: { aiEnabled: false, webFetch: true, emailMode: 'resend' }, authentication: { turnstileRequired: true, turnstileSiteKey: 'fixture-site', emailReady: true } });
  submitEmail();
  await waitFor(() => expect(screen.getByText('请先完成安全验证')).toBeInTheDocument());
  expect(mock.mock.calls.filter(([path]) => path.endsWith('/auth/challenges'))).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '完成安全验证 fixture' }));
  submitEmail();
  await screen.findByText('验证码已发送，请检查邮箱。');
  const call = mock.mock.calls.find(([path]) => path.endsWith('/auth/challenges'));
  expect(JSON.parse(String(call?.[1]?.body)).turnstileToken).toBe('fixture-turnstile-token');
  expect(screen.queryByText('123456')).not.toBeInTheDocument();
});


it('邀请制保留邮箱验证，不加载 CAPTCHA，不回显生产 OTP', async () => {
  const mock = setup({ environment: 'production', features: { aiEnabled: false, webFetch: true, emailMode: 'resend' }, authentication: { inviteOnly: true, turnstileRequired: false, turnstileSiteKey: null, emailReady: true } });
  expect(screen.getByText(/当前仅受邀邮箱可登录/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '完成安全验证 fixture' })).not.toBeInTheDocument();
  submitEmail();
  await screen.findByText('验证码已发送，请检查邮箱。');
  expect(mock.mock.calls.filter(([path]) => path.endsWith('/auth/challenges'))).toHaveLength(1);
  expect(screen.queryByText('123456')).not.toBeInTheDocument();
});
