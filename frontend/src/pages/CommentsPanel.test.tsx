import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { CommentsPanel } from './TasksMaterialsShared';

const comment = (index: number) => ({ commentId: `c${index}`, authorName: '成员', body: `评论内容 ${index}`, createdAt: '2026-10-02T00:00:00Z' });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup(count = 11) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['comments', 'p', 'material', 'm'], Array.from({ length: count }, (_, index) => comment(index)));
  const view = render(<QueryClientProvider client={client}><CommentsPanel projectId="p" targetType="material" targetId="m" /></QueryClientProvider>);
  return { client, view };
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
