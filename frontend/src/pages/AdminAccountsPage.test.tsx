import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AdminAccountsPage } from './AdminAccountsPage';
import { AppShell } from '../components/AppShell';
import type { User } from '../api/types';

const user: User = { id: 'admin-1', displayName: '管理员', email: null, username: 'greenbp', isAdmin: true, role: 'super_admin' };
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
    if (_path === '/api/v1/admin/accounts') return response({ items: [], nextCursor: null });
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
  expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent('需要系统管理员权限');
  expect(screen.queryByLabelText('新注册邀请码')).not.toBeInTheDocument();
});


it('ordinary admin can edit users but has no role controls or system settings links', async () => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => response(path === '/api/v1/admin/accounts' ? { items: [
    { id: 'u1', username: 'member', email: null, displayName: '成员', role: 'user' },
    { id: 'a1', username: 'other_admin', email: null, displayName: '管理员', role: 'admin' },
  ], nextCursor: null } : { items: [], nextCursor: null })));
  setup({ ...user, role: 'admin' });
  expect(await screen.findByLabelText('member 显示名称')).toBeEnabled();
  expect(screen.queryByLabelText('other_admin 显示名称')).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '系统 AI 设置' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'AI 模型设置' })).not.toBeInTheDocument();
});

it('super admin can submit a role change and sees the persisted role', async () => {
  let role = 'user';
  const target = () => ({ id: 'u1', username: 'member', email: null, displayName: '成员', role });
  const mock = vi.fn(async (path: string, options?: RequestInit) => {
    if (options?.method === 'PATCH') { role = JSON.parse(String(options.body)).role; return response({ user: target() }); }
    if (path === '/api/v1/admin/accounts') return response({ items: [target()], nextCursor: null });
    if (path === '/api/v1/auth/session') return response({ user });
    return response({ items: [], nextCursor: null });
  });
  vi.stubGlobal('fetch', mock); setup();
  fireEvent.change(await screen.findByLabelText('member 账户等级'), { target: { value: 'admin' } });
  fireEvent.click(screen.getByRole('button', { name: '保存等级' }));
  await screen.findByText('member · 普通管理员');
  expect(mock.mock.calls.some(([path, options]) => path === '/api/v1/admin/accounts/u1/role' && options?.method === 'PATCH')).toBe(true);
});
