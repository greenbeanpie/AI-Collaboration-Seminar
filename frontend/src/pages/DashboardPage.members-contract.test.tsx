import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from './DashboardPage';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('loads actionable totals on a cold cache with the complete graph membership read model', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    let data: unknown;
    if (path === '/api/v1/projects') data = { items: [{ id: 'p', name: '真实成员格式', status: 'active', myRole: 'owner', deadlineDate: null, deadlinePrecision: 'unknown' }], nextCursor: null };
    else if (path.endsWith('/members')) data = { items: [{ userId: 'member' }] };
    else if (path.endsWith('/tasks/graph')) data = { memberIds: ['member'], items: [{ taskId: 't', title: '已分配待推进', status: 'doing', lifecycleState: 'in_progress', assigneeId: 'member', dependsOnTaskIds: [], unfinishedDependencyIds: [], revision: 1, dueDate: null, duePrecision: 'unknown' }], nextCursor: null };
    else throw new Error(`Unexpected request ${path}`);
    return new Response(JSON.stringify({ data, requestId: 'contract-fixture' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(<QueryClientProvider client={client}><MemoryRouter><DashboardPage /></MemoryRouter></QueryClientProvider>);
  const attention = await screen.findByRole('complementary', { name: '待响应事项' });
  expect(await within(attention).findByText('1 项可完成', { selector: 'small' })).toBeInTheDocument();
  expect(within(attention).getByRole('link', { name: /已分配待推进/ })).toHaveAttribute('href', '/app/projects/p/tasks?task=t');
  expect(within(attention).queryByText('任务暂不可用，请重试。')).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  client.clear();
});
