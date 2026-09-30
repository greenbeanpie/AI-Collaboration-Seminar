import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { SupportTicketDetailPage, SupportTicketsPage } from './SupportTicketsPage';
const ticket = { id: 'ticket1', ownerId: 'user1', ownerName: '提交人', title: '测试问题', body: '<img src=x onerror=alert(1)>', status: 'pending', revision: 1, createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' };
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data, requestId: 'fixture' }), { status, headers: { 'content-type': 'application/json' } });
const fail = () => new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '工单不存在', retryable: false }, requestId: 'fixture' }), { status: 404, headers: { 'content-type': 'application/json' } });
function setup(path = '/app/support', role = 'user') {
 const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
 client.setQueryData(['session'], { id: 'user1', role, isAdmin: role !== 'user' });
 render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><Routes><Route path="/app/support" element={<SupportTicketsPage />} /><Route path="/app/support/:ticketId" element={<SupportTicketDetailPage />} /></Routes></MemoryRouter></QueryClientProvider>);
 return client;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('empty list, privacy warning, filtering and pagination have clear states', async () => {
 const mock = vi.fn(async (url: string) => response(url.includes('cursor=next') ? { items: [], nextCursor: null } : { items: [ticket], nextCursor: 'next' }));
 vi.stubGlobal('fetch', mock); setup();
 expect(screen.getByText(/请勿填写密码/)).toBeInTheDocument();
 await screen.findByRole('link', { name: '测试问题' });
 fireEvent.click(screen.getByRole('button', { name: '下一页' }));
 await screen.findByText('暂无符合条件的工单。');
 fireEvent.change(screen.getByLabelText('筛选状态'), { target: { value: 'resolved' } });
 await waitFor(() => expect(mock.mock.calls.some(([url]) => url.includes('status=resolved') && !url.includes('cursor='))).toBe(true));
});
it('create sends only title/body and opens detail; repeated clicks cannot duplicate pending submission', async () => {
 let resolve!: (value: Response) => void;
 const mock = vi.fn(async (url: string, options?: RequestInit) => {
  if (options?.method === 'POST') return new Promise<Response>(r => { resolve = r; });
  if (url.includes('/ticket1/messages')) return response({ items: [], nextCursor: null });
  if (url.endsWith('/ticket1')) return response({ ticket });
  return response({ items: [], nextCursor: null });
 });
 vi.stubGlobal('fetch', mock); setup();
 fireEvent.change(screen.getByLabelText('问题标题'), { target: { value: '测试问题' } });
 fireEvent.change(screen.getByLabelText('问题描述'), { target: { value: '描述' } });
 const submit = screen.getByRole('button', { name: '提交工单' }); fireEvent.click(submit); fireEvent.click(submit);
 await waitFor(() => expect(mock.mock.calls.filter(([,o]) => o?.method === 'POST')).toHaveLength(1));
 expect(JSON.parse(String(mock.mock.calls.find(([,o]) => o?.method === 'POST')![1]!.body))).toEqual({ title: '测试问题', body: '描述' });
 resolve(response({ ticket }, 201)); await screen.findByRole('heading', { name: '测试问题' });
});
it('plain text is escaped and ordinary users cannot change status; errors preserve reply draft', async () => {
 vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => options?.method === 'POST' ? fail() : response(url.includes('/messages') ? { items: [], nextCursor: null } : { ticket })));
 setup('/app/support/ticket1');
 await screen.findByText('<img src=x onerror=alert(1)>'); expect(document.querySelector('img')).toBeNull();
 expect(screen.queryByLabelText('工单状态')).not.toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('回复内容'), { target: { value: '保留草稿' } });
 fireEvent.click(screen.getByRole('button', { name: '发送回复' }));
 await screen.findByRole('alert'); expect(screen.getByLabelText('回复内容')).toHaveValue('保留草稿');
});
it('404 detail hides history, reply and status forms', async () => {
 const mock = vi.fn(async () => fail()); vi.stubGlobal('fetch', mock); setup('/app/support/ticket1', 'admin');
 expect(await screen.findByRole('alert')).toHaveTextContent('工单不存在');
 expect(screen.queryByLabelText('回复内容')).not.toBeInTheDocument(); expect(screen.queryByLabelText('工单状态')).not.toBeInTheDocument();
 expect(mock).toHaveBeenCalledTimes(1);
});
it('admin can update status with revision; closed tickets display reopening guidance', async () => {
 let current = { ...ticket };
 const mock = vi.fn(async (url: string, options?: RequestInit) => {
  if (options?.method === 'PATCH') { const body = JSON.parse(String(options.body)); expect(body).toEqual({ status: 'closed', revision: 1 }); current = { ...current, status: body.status, revision: 2 }; return response({ ticket: current }); }
  return response(url.includes('/messages') ? { items: [], nextCursor: null } : { ticket: current });
 });
 vi.stubGlobal('fetch', mock); setup('/app/support/ticket1', 'admin');
 fireEvent.change(await screen.findByLabelText('工单状态'), { target: { value: 'closed' } });
 fireEvent.click(screen.getByRole('button', { name: '保存状态' }));
 await screen.findByText('此工单已关闭。管理员重新打开后可继续回复。');
 expect(screen.queryByLabelText('回复内容')).not.toBeInTheDocument();
});
it('history pagination loads more records without replacing the first page', async () => {
 vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  if (!url.includes('/messages')) return response({ ticket });
  const next = url.includes('cursor=next');
  return response({ items: [{ id: next ? 'm2' : 'm1', authorId: 'user1', authorName: '提交人', kind: 'reply', body: next ? '第二条' : '第一条', status: null, createdAt: ticket.createdAt }], nextCursor: next ? null : 'next' });
 }));
 setup('/app/support/ticket1'); await screen.findByText('第一条');
 fireEvent.click(screen.getByRole('button', { name: '加载更多记录' })); await screen.findByText('第二条');
 expect(screen.getByText('第一条')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: '加载更多记录' })).not.toBeInTheDocument();
});
