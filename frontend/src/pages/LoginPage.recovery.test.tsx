import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LoginPage } from './LoginPage';
import type { Capability } from '../api/types';
import { clearOfflineAccount } from '../offline/store';
const capabilities = { features: { aiEnabled: false }, authentication: { passwordEnabled: true, invitationRequired: true, passwordMinLength: 12, turnstileRequired: false } } as Capability;
const user = { id: 'recovery-login', username: 'team_member', email: null, displayName: 'Team', isAdmin: false, role: 'user' };
const response = (data: unknown) => Response.json({ data });
afterEach(async () => { cleanup(); await clearOfflineAccount(user.id); localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); });
function mount(returnTo = '/app/join?code=original-code') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/login?returnTo=' + encodeURIComponent(returnTo)]}><Routes><Route path="/login" element={<LoginPage capabilities={capabilities} />} /><Route path="/app/join" element={<h1>原邀请预览</h1>} /><Route path="/app" element={<h1>普通工作区</h1>} /></Routes></MemoryRouter></QueryClientProvider>);
}
function register() {
  fireEvent.click(screen.getByRole('tab', { name: '注册' }));
  fireEvent.change(screen.getByLabelText('用户名', { exact: false }), { target: { value: 'team_member' } });
  fireEvent.change(screen.getByLabelText('密码', { exact: false }), { target: { value: 'very-long-memory-only-password' } });
  fireEvent.change(screen.getByLabelText('16 位注册邀请码', { exact: false }), { target: { value: 'ABCD1234EFGH5678' } });
  fireEvent.click(screen.getByRole('button', { name: '注册并登录' }));
}
it('restores the original invitation after mode switches and recovers a lost registration response through a matching live session', async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/capabilities')) return response(capabilities);
    if (url.endsWith('/register')) throw new TypeError('response lost');
    if (url.endsWith('/session')) return response({ user });
    throw new Error('unexpected');
  }); vi.stubGlobal('fetch', fetcher); mount();
  fireEvent.click(screen.getByRole('tab', { name: '注册' })); fireEvent.click(screen.getByRole('tab', { name: '登录' })); register();
  await screen.findByRole('heading', { name: '原邀请预览' });
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/register'))).toHaveLength(1);
  expect([...Array(sessionStorage.length)].map((_, index) => sessionStorage.getItem(sessionStorage.key(index)!)).join('')).not.toContain('very-long-memory-only-password');
});
it('keeps an unknown registration on its form, rejects another user session and prevents blind registration retry', async () => {
  const fetcher = vi.fn(async (url: string) => url.endsWith('/capabilities') ? response(capabilities) : url.endsWith('/session') ? response({ user: { ...user, username: 'someone_else' } }) : Promise.reject(new TypeError('response lost')));
  vi.stubGlobal('fetch', fetcher); mount(); register();
  await screen.findByText(/注册结果尚未确认/);
  expect(screen.getByLabelText('密码', { exact: false })).toHaveValue('very-long-memory-only-password');
  fireEvent.click(screen.getByRole('button', { name: '注册并登录' }));
  await screen.findByText('请先切换到登录，核对刚才的注册结果。');
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/register'))).toHaveLength(1);
});
