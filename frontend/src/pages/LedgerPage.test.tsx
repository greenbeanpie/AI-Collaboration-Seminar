import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, listAllItems } from '../api/client';
import type { EventItem } from '../api/types';
import { LedgerPage } from './LedgerPage';

const state = vi.hoisted(() => ({ projectId: 'p', events: [] as EventItem[] }));
vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: state.projectId, project: { myRole: 'owner' } }) }));
vi.mock('../api/client', async importOriginal => ({ ...await importOriginal<typeof import('../api/client')>(), api: { get: vi.fn(), post: vi.fn() }, listAllItems: vi.fn() }));
const clients: QueryClient[] = [];
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  const view = render(<QueryClientProvider client={client}><LedgerPage /></QueryClientProvider>);
  return { ...view, client };
}
function eventPage(query?: Record<string, unknown>) {
  const start = Number(query?.cursor ?? 0);
  const limit = Number(query?.limit ?? 10);
  return { items: state.events.slice(start, start + limit), nextCursor: start + limit < state.events.length ? String(start + limit) : null };
}
beforeEach(() => {
  state.projectId = 'p';
  state.events = Array.from({ length: 22 }, (_, index) => ({ eventId: `event-${index}`, type: 'decision.recorded', actorType: 'user', actorId: 'u', entityType: 'decision', entityId: `d-${index}`, payload: { title: `事件 ${index + 1}` }, occurredAt: new Date(Date.UTC(2026, 9, 2, 12, 0, 22 - index)).toISOString() }));
  vi.mocked(api.get).mockImplementation(async (path, query) => (path.endsWith('/events') ? eventPage(query) : { items: [], nextCursor: null }) as never);
  vi.mocked(listAllItems).mockResolvedValue([]);
  vi.mocked(api.post).mockResolvedValue({} as never);
});
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.resetAllMocks(); });

it('loads 22 events as 10/10/2, replaces the list, and navigates back without omissions', async () => {
  const { container } = show();
  await screen.findByText('事件 1');
  expect(screen.getByText('本页 10 条')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  const seen = new Set<string>();
  for (const [page, count] of [[1, 10], [2, 10], [3, 2]]) {
    await screen.findByText(`第 ${page} 页`);
    await waitFor(() => expect(container.querySelectorAll('.ledger-line')).toHaveLength(count));
    container.querySelectorAll('.ledger-content p').forEach(node => seen.add(node.textContent!));
    if (page < 3) fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  }
  expect(seen.size).toBe(22);
  expect(screen.queryByText('事件 1')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '上一页' }));
  await screen.findByText('事件 11');
  expect(screen.getByText('第 2 页')).toBeInTheDocument();
  expect(vi.mocked(listAllItems).mock.calls.every(([path]) => path.endsWith('/members'))).toBe(true);
  expect(vi.mocked(api.get).mock.calls.filter(([path]) => path.endsWith('/events')).map(([, query]) => query)).toEqual([{ limit: 10, cursor: null }, { limit: 10, cursor: '10' }, { limit: 10, cursor: '20' }]);
});

it('changes page size and resets to the first page for 20 and 50', async () => {
  const { container } = show();
  await screen.findByText('事件 1');
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText('事件 11');
  fireEvent.change(screen.getByLabelText('每页条数'), { target: { value: '20' } });
  await screen.findByText('本页 20 条');
  expect(screen.getByText('第 1 页')).toBeInTheDocument();
  expect(container.querySelectorAll('.ledger-line')).toHaveLength(20);
  fireEvent.change(screen.getByLabelText('每页条数'), { target: { value: '50' } });
  await screen.findByText('本页 22 条');
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
});

it('shows an empty first page and disables both directions', async () => {
  state.events = [];
  show();
  await screen.findByText('暂无事件记录');
  expect(screen.getByText('本页 0 条')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
});

it('hides the prior page while loading, disables controls, and retries a failed page', async () => {
  show();
  await screen.findByText('事件 1');
  let rejectPage!: (error: Error) => void;
  vi.mocked(api.get).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPage = reject; }));
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText('正在读取事件记录');
  expect(screen.queryByText('事件 1')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  expect(screen.getByLabelText('每页条数')).toBeDisabled();
  await act(async () => rejectPage(new Error('读取失败')));
  await screen.findByText('读取失败');
  expect(screen.queryByText('暂无事件记录')).not.toBeInTheDocument();
  expect(screen.getByText('本页 — 条')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await screen.findByText('事件 11');
});

it('resets page and size when the project changes, without reusing the old cursor', async () => {
  const { client, rerender } = show();
  await screen.findByText('事件 1');
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText('事件 11');
  state.projectId = 'other';
  rerender(<QueryClientProvider client={client}><LedgerPage /></QueryClientProvider>);
  await screen.findByText('事件 1');
  expect(screen.getByText('第 1 页')).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledWith('/api/v1/projects/other/events', { limit: 10, cursor: null }, expect.any(AbortSignal));
});

it.each(['decision', 'contribution', 'resource'])('returns to a fresh first page after recording a %s', async kind => {
  show();
  await screen.findByText('事件 1');
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText('事件 11');
  vi.mocked(api.post).mockImplementationOnce(async () => { state.events.unshift({ ...state.events[0], eventId: 'new', payload: { title: '新增事件' } }); return {} as never; });
  if (kind === 'decision') { fireEvent.change(screen.getByLabelText('决策标题'), { target: { value: '新决策' } }); fireEvent.click(screen.getByRole('button', { name: '记录决策' })); }
  if (kind === 'contribution') { fireEvent.change(screen.getByLabelText('具体贡献和依据'), { target: { value: '新贡献' } }); fireEvent.click(screen.getByRole('button', { name: '添加贡献记录' })); }
  if (kind === 'resource') { fireEvent.change(screen.getByLabelText('资源名称'), { target: { value: '新资源' } }); fireEvent.change(screen.getByLabelText('来源网址'), { target: { value: 'https://example.com' } }); fireEvent.click(screen.getByRole('button', { name: '声明资源' })); }
  await screen.findByText('新增事件');
  expect(screen.getByText('第 1 页')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(screen.queryByText('事件 11')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText('事件 10');
});

it('keeps a successful save successful when refreshing the first page fails', async () => {
  show();
  await screen.findByText('事件 1');
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await screen.findByText('事件 11');
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.endsWith('/events')) throw new Error('历史刷新失败');
    return { items: [], nextCursor: null } as never;
  });
  fireEvent.change(screen.getByLabelText('决策标题'), { target: { value: '已保存的决策' } });
  fireEvent.click(screen.getByRole('button', { name: '记录决策' }));
  await screen.findByText('历史刷新失败');
  await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('决策标题')).toHaveValue('');
  expect(screen.getByText('第 1 页')).toBeInTheDocument();
  vi.mocked(api.get).mockImplementation(async (path, query) => (path.endsWith('/events') ? eventPage(query) : { items: [], nextCursor: null }) as never);
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await screen.findByText('事件 1');
});
