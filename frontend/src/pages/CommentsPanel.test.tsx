import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommentsPanel, type CommentTarget } from './TasksMaterialsShared';
import { readCommentDraft, writeCommentDraft } from './comment-draft';

const comment = (index: number) => ({ commentId: `c${index}`, authorName: '成员', body: `评论内容 ${index}`, createdAt: '2026-10-02T00:00:00Z' });
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
type Scope = { accountId?: string | null; projectId?: string; targetType?: CommentTarget; targetId?: string; presentation?: 'disclosure' | 'content' };
function setup(count = 11, scope: Scope = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['session'], scope.accountId === null ? null : { id: scope.accountId ?? 'a' });
  const content = (options: Scope = scope) => {
    const projectId = options.projectId ?? 'p', targetType = options.targetType ?? 'material', targetId = options.targetId ?? 'm';
    client.setQueryData(['comments', projectId, targetType, targetId], Array.from({ length: count }, (_, index) => comment(index)));
    return <QueryClientProvider client={client}><CommentsPanel projectId={projectId} targetType={targetType} targetId={targetId} presentation={options.presentation} /></QueryClientProvider>;
  };
  const view = render(content());
  return { client, view, content };
}
it('starts collapsed and shows five entries per page with bounded controls', () => {
  setup();
  const box = screen.getByLabelText('评论');
  expect(box).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('讨论'));
  expect(box).toHaveAttribute('open');
  const pagination = screen.getByRole('navigation', { name: '讨论分页' });
  expect(within(pagination).getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(screen.getAllByText(/^评论内容 /)).toHaveLength(5);
  fireEvent.click(within(pagination).getByRole('button', { name: '下一页' }));
  expect(screen.getByText('评论内容 5')).toBeVisible();
  fireEvent.click(within(pagination).getByRole('button', { name: '下一页' }));
  expect(screen.getAllByText(/^评论内容 /)).toHaveLength(1);
  expect(within(pagination).getByRole('button', { name: '下一页' })).toBeDisabled();
});
it('changing the material resets discussion expansion and pagination', () => {
  const { client, view } = setup();
  fireEvent.click(screen.getByText('讨论'));
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  client.setQueryData(['comments', 'p', 'material', 'n'], Array.from({ length: 6 }, (_, index) => comment(index)));
  view.rerender(<QueryClientProvider client={client}><CommentsPanel projectId="p" targetType="material" targetId="n" /></QueryClientProvider>);
  expect(screen.getByLabelText('评论')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('讨论'));
  expect(screen.getByText('1 / 2')).toBeVisible();
});
it('sending a comment opens the page containing the new entry', async () => {
  const comments = Array.from({ length: 5 }, (_, index) => comment(index));
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.method === 'POST') comments.push({ ...comment(5), body: '新评论' });
    return new Response(JSON.stringify({ requestId: 'test', data: options?.method === 'POST' ? comments[5] : { items: comments, nextCursor: null } }), { headers: { 'Content-Type': 'application/json' } });
  }));
  setup(5); fireEvent.click(screen.getByText('讨论'));
  fireEvent.change(screen.getByRole('textbox', { name: '发表评论' }), { target: { value: '新评论' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送' })); });
  await waitFor(() => expect(screen.getByText('2 / 2')).toBeVisible());
  expect(screen.getByText('新评论')).toBeVisible();
});

it('persists each edit immediately and restores it after reopening without changing disclosure behavior', () => {
  const { view } = setup(0);
  fireEvent.click(screen.getByText('讨论'));
  fireEvent.change(screen.getByRole('textbox', { name: '发表评论' }), { target: { value: '尚未发送的讨论' } });
  expect(readCommentDraft('a', 'p', 'material', 'm').draft?.body).toBe('尚未发送的讨论');
  view.unmount();
  setup(0);
  expect(screen.getByLabelText('评论')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('讨论'));
  expect(screen.getByRole('textbox', { name: '发表评论' })).toHaveValue('尚未发送的讨论');
  expect(screen.getByText(/已恢复本机评论草稿/)).toBeVisible();
});

it('keeps account and target recovery states separate while navigating', async () => {
  const { client, view, content } = setup(0, { presentation: 'content' });
  fireEvent.change(screen.getByRole('textbox', { name: '发表评论' }), { target: { value: '属于 a/p/material/m' } });
  for (const target of [{ projectId: 'q' }, { targetType: 'task' as const }, { targetId: 'n' }]) {
    view.rerender(content({ ...target, presentation: 'content' }));
    expect(screen.getByRole('textbox', { name: '发表评论' })).toHaveValue('');
  }
  view.rerender(content({ presentation: 'content' }));
  act(() => client.setQueryData(['session'], { id: 'b' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '发表评论' })).toHaveValue(''));
  act(() => client.setQueryData(['session'], { id: 'a' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '发表评论' })).toHaveValue('属于 a/p/material/m'));
});

it('waits for a known session before allowing edits or using local storage', async () => {
  const setItem = vi.spyOn(localStorage, 'setItem');
  const { client } = setup(0, { accountId: null, presentation: 'content' });
  expect(screen.getByRole('textbox', { name: '发表评论' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  expect(setItem).not.toHaveBeenCalled();
  act(() => client.setQueryData(['session'], { id: 'a' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '发表评论' })).toBeEnabled());
});

it('shows storage failure and guards closing when text is only in memory', () => {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Quota', 'QuotaExceededError'); });
  setup(0, { presentation: 'content' });
  fireEvent.change(screen.getByRole('textbox', { name: '发表评论' }), { target: { value: '仅存于内存' } });
  expect(screen.getByRole('alert')).toHaveTextContent('浏览器无法保存本机评论草稿');
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});

it('keeps the local comment when the server or offline queue rejects sending', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ requestId: 'failed', error: { code: 'SERVICE_UNAVAILABLE', message: '离线队列写入失败', retryable: true } }, { status: 503 })));
  setup(0, { presentation: 'content' });
  fireEvent.change(screen.getByRole('textbox', { name: '发表评论' }), { target: { value: '失败后保留' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText('离线队列写入失败');
  expect(screen.getByRole('textbox', { name: '发表评论' })).toHaveValue('失败后保留');
  expect(readCommentDraft('a', 'p', 'material', 'm').draft?.body).toBe('失败后保留');
});

it.each([false, true])('clears only after sending succeeds and prevents editing while pending (offlinePending: %s)', async offlinePending => {
  let complete!: (value: Response) => void;
  const created = { ...comment(1), body: '等待确认', offlinePending };
  vi.stubGlobal('fetch', vi.fn((_url: unknown, options?: RequestInit) => options?.method === 'POST' ? new Promise<Response>(resolve => { complete = resolve; }) : Promise.resolve(Response.json({ data: { items: [created], nextCursor: null } }))));
  setup(0, { presentation: 'content' });
  fireEvent.change(screen.getByRole('textbox', { name: '发表评论' }), { target: { value: '等待确认' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(complete).toBeDefined());
  expect(screen.getByRole('textbox', { name: '发表评论' })).toBeDisabled();
  expect(readCommentDraft('a', 'p', 'material', 'm').draft?.body).toBe('等待确认');
  await act(async () => complete(Response.json({ data: created })));
  expect(readCommentDraft('a', 'p', 'material', 'm').draft).toBeNull();
  expect(screen.getByRole('textbox', { name: '发表评论' })).toHaveValue('');
});

it('preserves another tab’s newer comment when sending the prior text succeeds', async () => {
  let complete!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn((_url: unknown, options?: RequestInit) => options?.method === 'POST' ? new Promise<Response>(resolve => { complete = resolve; }) : Promise.resolve(Response.json({ data: { items: [comment(1)], nextCursor: null } }))));
  setup(0, { presentation: 'content' });
  fireEvent.change(screen.getByRole('textbox', { name: '发表评论' }), { target: { value: '当前标签发送' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(complete).toBeDefined());
  writeCommentDraft('a', 'p', 'material', 'm', '另一个标签的新评论');
  await act(async () => complete(Response.json({ data: comment(1) })));
  expect(readCommentDraft('a', 'p', 'material', 'm').draft?.body).toBe('另一个标签的新评论');
});

it('reports removal failure after a comment was accepted', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => Response.json({ data: options?.method === 'POST' ? comment(1) : { items: [comment(1)], nextCursor: null } })));
  setup(0, { presentation: 'content' });
  fireEvent.change(screen.getByRole('textbox', { name: '发表评论' }), { target: { value: '已发送但草稿未清理' } });
  vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await screen.findByText(/旧本机草稿未能清理/);
  expect(readCommentDraft('a', 'p', 'material', 'm').draft?.body).toBe('已发送但草稿未清理');
});
