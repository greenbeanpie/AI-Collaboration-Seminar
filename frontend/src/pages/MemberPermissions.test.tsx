import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { MemberPermissionsDialog } from './MemberPermissions';

const patch = vi.hoisted(() => vi.fn());
vi.mock('../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, api: { ...actual.api, patch } };
});
afterEach(() => { cleanup(); patch.mockReset(); });

const member = {
  userId: '11111111-1111-4111-8111-111111111111', displayName: 'Xiawu', role: 'member' as const, email: 'x@example.com', isAdmin: false,
  joinedAt: '2026-10-01', permissions: { teamManage: false, taskManage: false, resourceManage: false, scoreInitiate: true, scoreCorrect: false }, permissionsRevision: 4, canManagePermissions: false,
};
const box = (name: string) => screen.getByRole('checkbox', { name: new RegExp(name) }) as HTMLInputElement;

function renderDialog(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MemberPermissionsDialog projectId="p" member={member} onClose={onClose} /></QueryClientProvider>);
  return { onClose };
}

it('applies the 协作管理员 preset to all five permissions', () => {
  renderDialog();
  fireEvent.change(screen.getByRole('combobox', { name: '权限模板' }), { target: { value: 'manager' } });
  for (const name of ['管理团队成员', '管理所有任务', '管理所有资料', '发起评分与答辩', '修正历史评分']) expect(box(name).checked).toBe(true);
});

it('restores ordinary member defaults and switches to 自定义 after a manual change', () => {
  renderDialog();
  fireEvent.change(screen.getByRole('combobox', { name: '权限模板' }), { target: { value: 'manager' } });
  fireEvent.change(screen.getByRole('combobox', { name: '权限模板' }), { target: { value: 'ordinary' } });
  expect(box('管理团队成员').checked).toBe(false);
  expect(box('管理所有任务').checked).toBe(false);
  expect(box('管理所有资料').checked).toBe(false);
  expect(box('发起评分与答辩').checked).toBe(true);
  expect(box('修正历史评分').checked).toBe(false);
  fireEvent.click(box('管理所有任务'));
  expect(box('管理所有任务').checked).toBe(true);
  expect((screen.getByRole('combobox', { name: '权限模板' }) as HTMLSelectElement).value).toBe('custom');
});

it('sends the exact permission set with the expected revision', async () => {
  patch.mockResolvedValue({});
  const { onClose } = renderDialog();
  fireEvent.change(screen.getByRole('combobox', { name: '权限模板' }), { target: { value: 'manager' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  expect(patch.mock.calls[0]![0]).toBe('/api/v1/projects/p/members/11111111-1111-4111-8111-111111111111/permissions');
  expect(patch.mock.calls[0]![1]).toEqual({ expectedRevision: 4, permissions: { teamManage: true, taskManage: true, resourceManage: true, scoreInitiate: true, scoreCorrect: true } });
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it('shows an explicit conflict notice on 409 instead of silently overwriting', async () => {
  patch.mockRejectedValue(new ApiError(409, { requestId: 'r', error: { code: 'VERSION_CONFLICT', message: '内容已被他人更新，请获取最新版本后重试', retryable: false } }));
  const { onClose } = renderDialog();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('权限已发生变化，请刷新后重新确认。');
  expect(onClose).not.toHaveBeenCalled();
});
