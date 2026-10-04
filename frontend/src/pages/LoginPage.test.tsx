import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LoginPage } from './LoginPage';
import type { Capability } from '../api/types';

const capabilities: Capability = { apiVersion: 'v1', environment: 'local', features: { aiEnabled: false, webFetch: true, emailMode: 'echo' },
  limits: { recommendedCloudFileBytes: 10485760, recommendedCloudPdfPages: 30, uploadPartBytes: 8388608, maxFileBytes: 10485760, maxPdfPages: 30, pageImageMaxEdge: 2000, pageImageMaxBytes: 2097152, listDefaultPageSize: 20, listMaxPageSize: 100, concurrentAiTasksPerProject: 2, assignmentSuggestionMaxTasks: 20 },
  competitionTemplate: { teamSizeLimit: 5 }, authentication: { passwordEnabled: true, invitationRequired: true, passwordMinLength: 12, mode: 'password', turnstileRequired: false, emailReady: false } };
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data, requestId: 'test-request' }), { status, headers: { 'content-type': 'application/json' } });
function setup(fail = false) {
  const mock = vi.fn(async (path: string) => {
    if (path.endsWith('/capabilities')) return response(capabilities);
    if (path.endsWith('/auth/sessions') || path.endsWith('/auth/register')) {
      if (fail) return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: '账号或密码错误', retryable: false }, requestId: 'login-trace' }), { status: 401, headers: { 'content-type': 'application/json' } });
      return response({ user: { id: 'account-1', email: null, username: 'team_member', displayName: 'team_member', isAdmin: false } }, 201);
    }
    throw new Error(`Unexpected API ${path}`);
  });
  vi.stubGlobal('fetch', mock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter><Routes><Route path="/" element={<LoginPage capabilities={capabilities} />} /><Route path="/app" element={<h1>真实工作区</h1>} /></Routes></MemoryRouter></QueryClientProvider>);
  return { mock, client };
}
function fillRegistration(email?: string) {
  fireEvent.click(screen.getByRole('tab', { name: '注册' }));
  fireEvent.change(screen.getByLabelText('用户名', { exact: false }), { target: { value: 'team_member' } });
  fireEvent.change(screen.getByLabelText('密码', { exact: false }), { target: { value: 'a-long-test-password' } });
  fireEvent.change(screen.getByLabelText('16 位注册邀请码', { exact: false }), { target: { value: 'ABCD1234EFGH5678' } });
  if (email) fireEvent.change(screen.getByLabelText('邮箱地址（选填）'), { target: { value: email } });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('password login and invitation registration', () => {
  it('submits account/password and restores the real session on keyboard submission', async () => {
    const { mock, client } = setup();
    fireEvent.change(screen.getByLabelText('用户名或邮箱'), { target: { value: ' team_member ' } });
    const password = screen.getByLabelText('密码');
    expect(password).toHaveAttribute('type', 'password'); expect(password).toHaveAttribute('autocomplete', 'current-password');
    fireEvent.change(password, { target: { value: 'a-long-test-password' } });
    fireEvent.submit(password.closest('form')!);
    await screen.findByRole('heading', { name: '真实工作区' });
    const call = mock.mock.calls.find(([path]) => path.endsWith('/auth/sessions'));
    expect(JSON.parse(String((call as unknown as [string, RequestInit])[1].body))).toEqual({ account: 'team_member', password: 'a-long-test-password' });
    expect(client.getQueryData(['session'])).toMatchObject({ username: 'team_member', email: null, isAdmin: false });
    expect(mock.mock.calls.some(([path]) => path.endsWith('/auth/challenges'))).toBe(false);
  });
  it('registers with a single-use invitation and omits an empty email', async () => {
    const { mock } = setup(); fillRegistration();
    const password = screen.getByLabelText('密码', { exact: false });
    expect(password).toHaveAttribute('autocomplete', 'new-password');
    fireEvent.submit(password.closest('form')!);
    await screen.findByRole('heading', { name: '真实工作区' });
    const call = mock.mock.calls.find(([path]) => path.endsWith('/auth/register')) as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body))).toEqual({ username: 'team_member', password: 'a-long-test-password', invitationCode: 'ABCD1234EFGH5678' });
  });
  it('includes an optional email without sending an OTP or CAPTCHA request', async () => {
    const { mock } = setup(); fillRegistration('member@example.test');
    fireEvent.click(screen.getByRole('button', { name: '注册并登录' }));
    await screen.findByRole('heading', { name: '真实工作区' });
    const call = mock.mock.calls.find(([path]) => path.endsWith('/auth/register')) as unknown as [string, RequestInit];
    expect(JSON.parse(String(call[1].body)).email).toBe('member@example.test');
    expect(mock.mock.calls.some(([path]) => /challenges|turnstile/.test(path))).toBe(false);
  });
  it('shows real credential failure and keeps the guest demo behind an explicit link', async () => {
    setup(true);
    expect(screen.getByRole('link', { name: /游客演示/ })).toHaveAttribute('href', '/guest/index.html');
    fireEvent.change(screen.getByLabelText('用户名或邮箱'), { target: { value: 'team_member' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: '登录工作区' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('账号或密码错误');
    expect(screen.queryByRole('heading', { name: '真实工作区' })).not.toBeInTheDocument();
  });
  it('blocks invalid registration and clears secrets when changing tabs', async () => {
    const { mock } = setup(); fillRegistration();
    fireEvent.change(screen.getByLabelText('密码', { exact: false }), { target: { value: 'short' } });
    fireEvent.submit(screen.getByLabelText('密码', { exact: false }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('密码须为 12–128 位');
    expect(mock.mock.calls.some(([path]) => path.endsWith('/auth/register'))).toBe(false);
    fireEvent.click(screen.getByRole('tab', { name: '登录' }));
    expect(screen.getByLabelText('密码')).toHaveValue('');
    fireEvent.click(screen.getByRole('tab', { name: '注册' }));
    expect(screen.getByLabelText('16 位注册邀请码', { exact: false })).toHaveValue('');
  });
});
