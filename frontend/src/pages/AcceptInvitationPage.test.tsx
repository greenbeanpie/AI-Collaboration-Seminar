import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AcceptInvitationPage } from './AcceptInvitationPage';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

const invitation = (id: string, status = 'pending') => ({
  id, projectName: `邀请项目 ${id}`, inviterName: '测试负责人', status, expiresAt: '2026-12-31T00:00:00Z',
});
const response = (data: unknown) => Response.json({ requestId: 'invitation-test', data });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/app/join']}><Routes>
    <Route path="/app/join" element={<AcceptInvitationPage />} />
    <Route path="/app/projects/:id" element={<h1>已进入项目</h1>} />
    <Route path="/app" element={<h1>项目列表</h1>} />
  </Routes></MemoryRouter></QueryClientProvider>);
  return { invalidate };
}

it('combines code acceptance and received invitations, with a loading and empty state', async () => {
  let resolveInbox!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { resolveInbox = resolve; })));
  setup();
  expect(screen.getByRole('heading', { level: 1, name: '项目邀请' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '通过邀请码接受邀请' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '收到的项目邀请' })).toBeInTheDocument();
  expect(screen.getByText('正在读取项目邀请')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '接受邀请并加入' })).toBeDisabled();
  expect(screen.getByRole('link', { name: '返回项目列表' })).toHaveAttribute('href', '/app');
  resolveInbox(response({ items: [], nextOffset: null }));
  expect(await screen.findByText('暂无项目邀请。')).toBeInTheDocument();
  expect(screen.queryByText('正在读取项目邀请')).not.toBeInTheDocument();
});

it('preserves invite-code deep links, submits a trimmed code and enters the accepted project', async () => {
  window.history.replaceState({}, '', '/app/join?code=shared-invitation-code');
  const posts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); return response({ projectId: 'joined-project' }); }
    return response({ items: [], nextOffset: null });
  }));
  const { invalidate } = setup();
  expect(screen.getByLabelText('邀请代码')).toHaveValue('shared-invitation-code');
  fireEvent.change(screen.getByLabelText('邀请代码'), { target: { value: '  updated-invitation-code  ' } });
  fireEvent.click(screen.getByRole('button', { name: '接受邀请并加入' }));
  expect(await screen.findByRole('heading', { name: '已进入项目' })).toBeInTheDocument();
  expect(posts).toEqual([{ code: 'updated-invitation-code' }]);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['projects'] });
});

it.each(['accept', 'decline'] as const)('keeps the received-invitation %s action and refreshes project and notification state', async action => {
  let status = 'pending';
  let finish!: () => void;
  const posts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      await new Promise<void>(resolve => { finish = resolve; });
      status = action === 'accept' ? 'accepted' : 'declined';
      return response({ id: 'one', status });
    }
    return response({ items: [invitation('one', status)], nextOffset: null });
  }));
  const { invalidate } = setup();
  const card = (await screen.findByText('邀请项目 one')).closest('article')!;
  fireEvent.click(within(card).getByRole('button', { name: action === 'accept' ? '接受邀请' : '拒绝邀请' }));
  await waitFor(() => expect(within(card).getByRole('button', { name: '接受邀请' })).toBeDisabled());
  expect(within(card).getByRole('button', { name: '拒绝邀请' })).toBeDisabled();
  finish();
  await screen.findByText(new RegExp(action === 'accept' ? '已接受' : '已拒绝'));
  expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  expect(posts).toEqual([{ action }]);
  for (const key of ['username-invitations', 'projects', 'notifications']) expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
});

it('retains inbox pagination and inactive invitation statuses', async () => {
  const offsets: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const offset = new URL(url, 'http://localhost').searchParams.get('offset')!;
    offsets.push(offset);
    return response(offset === '20'
      ? { items: [invitation('last', 'expired')], nextOffset: null }
      : { items: [invitation('old', 'revoked')], nextOffset: 20 });
  }));
  setup();
  expect(await screen.findByText(/已撤销/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '接受邀请' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '下一页邀请' }));
  expect(await screen.findByText(/已过期/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '下一页邀请' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '上一页邀请' }));
  expect(await screen.findByText('邀请项目 old')).toBeInTheDocument();
  expect(offsets).toEqual(['0', '20']);
});

it('allows retrying an inbox error without losing the invitation-code form', async () => {
  let fail = true;
  vi.stubGlobal('fetch', vi.fn(async () => fail
    ? Response.json({ requestId: 'retry-test', error: { code: 'UNAVAILABLE', message: '邀请暂不可用', retryable: true } }, { status: 503 })
    : response({ items: [], nextOffset: null })));
  setup();
  fireEvent.change(screen.getByLabelText('邀请代码'), { target: { value: 'retained-invitation-code' } });
  await screen.findByRole('alert');
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('暂无项目邀请。')).toBeInTheDocument();
  expect(screen.getByLabelText('邀请代码')).toHaveValue('retained-invitation-code');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('keeps a failed received invitation actionable and supports cancelling back to the dashboard', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ requestId: 'action-test', error: { code: 'INVALID_STATE', message: '项目人数已满', retryable: false } }, { status: 409 })
    : response({ items: [invitation('one')], nextOffset: null })));
  setup();
  fireEvent.click(await screen.findByRole('button', { name: '接受邀请' }));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '接受邀请' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '拒绝邀请' })).toBeEnabled();
  fireEvent.click(screen.getByRole('link', { name: '取消' }));
  expect(await screen.findByRole('heading', { name: '项目列表' })).toBeInTheDocument();
});
