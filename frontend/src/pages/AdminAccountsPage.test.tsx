import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AdminAccountsPage } from './AdminAccountsPage';
import { AppShell } from '../components/AppShell';
import type { User } from '../api/types';

const user: User = { id: 'admin-1', displayName: '管理员', email: null, username: 'greenbp', isAdmin: true };
const response = (data: unknown) => new Response(JSON.stringify({ data, requestId: 'fixture' }), { headers: { 'content-type': 'application/json' } });
function setup(account = user) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['session'], account);
  render(<QueryClientProvider client={client}><MemoryRouter><AppShell user={account}><AdminAccountsPage /></AppShell></MemoryRouter></QueryClientProvider>);
  return client;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('system administrator can create one invitation; a fresh list never reveals the code', async () => {
  const mock = vi.fn(async (_path: string, options?: RequestInit) => {
    expect(options?.credentials).toBe('same-origin'); expect(new Headers(options?.headers).has('authorization')).toBe(false);
    if (options?.method === 'POST') { expect(JSON.parse(String(options.body))).toEqual({}); return response({ id: 'invite-1', code: 'ABCD1234EFGH5678', createdAt: '2026-09-30T00:00:00Z' }); }
    return response({ items: [{ id: 'invite-1', createdAt: '2026-09-30T00:00:00Z', usedAt: null, usedBy: null }], nextCursor: null });
  });
  vi.stubGlobal('fetch', mock); setup();
  await screen.findByText('invite-1');
  expect(screen.queryByText('ABCD1234EFGH5678')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '生成一个邀请码' }));
  await screen.findByLabelText('新注册邀请码');
  expect(screen.getByLabelText('新注册邀请码')).toHaveTextContent('ABCD1234EFGH5678');
  expect(screen.getByRole('button', { name: '生成一个邀请码' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '已保存，隐藏邀请码' }));
  expect(screen.queryByText('ABCD1234EFGH5678')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: '生成一个邀请码' })).toBeEnabled());
  expect(localStorage.length).toBe(0);
});

it('ordinary account has no system admin links or invitation API access even with a project owner role', async () => {
  const mock = vi.fn(); vi.stubGlobal('fetch', mock);
  setup({ ...user, displayName: '', username: 'project_owner', isAdmin: false });
  expect(screen.getByRole('alert')).toHaveTextContent('项目负责人不具备此权限');
  expect(screen.queryByRole('link', { name: '注册邀请码' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '系统 AI 设置' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '生成一个邀请码' })).not.toBeInTheDocument();
  expect(screen.getAllByText('project_owner').length).toBeGreaterThan(0);
  expect(mock).not.toHaveBeenCalled();
});

it('permission failure from the API is visible and does not display an invitation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: '需要系统管理员权限', retryable: false }, requestId: 'admin-trace' }), { status: 403, headers: { 'content-type': 'application/json' } })));
  setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('需要系统管理员权限');
  expect(screen.queryByLabelText('新注册邀请码')).not.toBeInTheDocument();
});
