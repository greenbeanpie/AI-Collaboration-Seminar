import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountSettingsPage } from './AccountSettingsPage';
const user = { id: 'fixture-id', username: 'fixture', email: null, displayName: '旧昵称', isAdmin: false };
const response = (data: unknown) => new Response(JSON.stringify({ data, requestId: 'fixture' }), { headers: { 'content-type': 'application/json' } });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['session'], user);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/app/settings']}><Routes><Route path="/app/settings" element={<AccountSettingsPage />} /><Route path="/login" element={<p>登录夹具</p>} /></Routes></MemoryRouter></QueryClientProvider>);
  return client;
}
function passwords() {
  fireEvent.change(screen.getByLabelText('原密码'), { target: { value: 'fixture-old-password' } });
  fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'fixture-new-password' } });
  fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'fixture-new-password' } });
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('updates the shared session display name and sends only displayName with CSRF header', async () => {
  const mock = vi.fn(async (_path: string, options: RequestInit) => { expect(new Headers(options.headers).get('X-Account-Settings')).toBe('1'); expect(JSON.parse(String(options.body))).toEqual({ displayName: '新昵称' }); return response({ user: { ...user, displayName: '新昵称' } }); });
  vi.stubGlobal('fetch', mock); const client = setup();
  fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '新昵称' } }); fireEvent.click(screen.getByText('保存昵称'));
  expect(await screen.findByRole('status')).toHaveTextContent('昵称已保存'); expect(client.getQueryData(['session'])).toMatchObject({ displayName: '新昵称' });
});
it('cancel never submits and clears password fields', () => {
  const mock = vi.fn(); vi.stubGlobal('fetch', mock); setup(); passwords(); fireEvent.click(screen.getByRole('button', { name: '修改密码' })); fireEvent.click(screen.getByText('取消'));
  expect(mock).not.toHaveBeenCalled(); expect(screen.getByLabelText('原密码')).toHaveValue(''); expect(screen.getByLabelText('新密码')).toHaveValue('');
});
it('wrong current password keeps the page and clears sensitive inputs', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'VALIDATION_FAILED', message: '原密码不正确', retryable: false }, requestId: 'fixture' }), { status: 400, headers: { 'content-type': 'application/json' } })));
  setup(); passwords(); fireEvent.click(screen.getByRole('button', { name: '修改密码' })); fireEvent.click(screen.getByText('确认修改并退出'));
  expect(await screen.findByRole('alert')).toHaveTextContent('原密码不正确'); expect(screen.getByLabelText('原密码')).toHaveValue(''); expect(screen.getByRole('heading', { name: '账户设置' })).toBeInTheDocument();
});
it('locks duplicate confirmation requests and clears session on success', async () => {
  let complete!: (value: Response) => void;
  const mock = vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })); vi.stubGlobal('fetch', mock); const client = setup(); passwords();
  fireEvent.click(screen.getByRole('button', { name: '修改密码' })); const button = screen.getByText('确认修改并退出'); fireEvent.click(button); fireEvent.click(button);
  expect(mock).toHaveBeenCalledTimes(1); expect(button).toBeDisabled(); complete(response({ revoked: true }));
  await waitFor(() => expect(screen.getByText('登录夹具')).toBeInTheDocument()); expect(client.getQueryData(['session'])).toBeUndefined();
});
