import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../../api/client';
import { usePagedItems } from './usePagedItems';
import { LoadMore } from './LoadMore';
vi.mock('../../api/client', async original => ({ ...await original<typeof import('../../api/client')>(), api: { get: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function List() {
  const query = usePagedItems<'ProjectListResponse'>({ queryKey: ['projects'], path: '/api/v1/projects', searchable: true });
  return <><ul>{query.data?.map(project => <li key={project.id}>{project.name}</li>)}</ul><LoadMore query={query} label="项目" /></>;
}
function setup() { render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><List /></QueryClientProvider>); }
it('fetches one bounded page and only advances after explicit user action', async () => {
  vi.mocked(api.get).mockResolvedValueOnce({ items: [{ id: 'p1', name: '第一页' }], nextCursor: 'page2' } as never).mockResolvedValueOnce({ items: [{ id: 'p2', name: '第二页' }], nextCursor: null } as never);
  setup(); await screen.findByText('第一页');
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.get).mock.calls[0][1]).toMatchObject({ limit: 50, cursor: null });
  fireEvent.click(screen.getByRole('button', { name: '加载更多项目' }));
  await screen.findByText('第二页');
  expect(screen.getByText('第一页')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '加载更多项目' })).not.toBeInTheDocument();
  expect(vi.mocked(api.get).mock.calls[1][1]).toMatchObject({ cursor: 'page2' });
});
it('searches on the server and starts a new cursor chain', async () => {
  vi.mocked(api.get).mockResolvedValue({ items: [], nextCursor: null } as never);
  setup(); await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '目标' } });
  await waitFor(() => expect(vi.mocked(api.get).mock.calls.at(-1)?.[1]).toMatchObject({ q: '目标', cursor: null }));
});
it('rejects a repeated cursor rather than appending the same page', async () => {
  vi.mocked(api.get).mockResolvedValueOnce({ items: [], nextCursor: 'repeat' } as never).mockResolvedValueOnce({ items: [], nextCursor: 'repeat' } as never);
  setup(); fireEvent.click(await screen.findByRole('button', { name: '加载更多项目' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  expect(api.get).toHaveBeenCalledTimes(2);
});
