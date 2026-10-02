import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { TasksPage } from './TasksPage';
vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p', project: { myRole: 'owner' } }) }));
vi.mock('./CollaborationWorkspace', () => ({ CollaborationWorkspace: () => { const [params] = useSearchParams(); return <p>统一子任务工作区 {params.get('task')}</p>; } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const goal = { projectId: 'p', title: '完整项目大目标', detail: '独立保存的目标说明', revision: 2, graphRevision: 4 };
function show(url = '/tasks') {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['project-goal', 'p'], goal);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><TasksPage /></MemoryRouter></QueryClientProvider>);
  return client;
}
it('shows one independent goal and forwards existing task IDs to the single lifecycle workspace', () => {
  show('/tasks?task=legacy-task');
  expect(screen.getByRole('heading', { name: '完整项目大目标' })).toBeInTheDocument();
  expect(screen.getByText('统一子任务工作区 legacy-task')).toBeInTheDocument();
  expect(screen.queryByText('协作任务闭环')).toBeNull();
});
it('saves a manual main goal with its own expected revision', async () => {
  const fetch = vi.fn<(path: unknown, options?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ data: { ...goal, title: '更明确的大目标', revision: 3 }, requestId: 'goal' }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch); show();
  fireEvent.click(screen.getByRole('button', { name: '编辑主目标' }));
  fireEvent.change(screen.getByLabelText('主目标'), { target: { value: '更明确的大目标' } });
  fireEvent.click(screen.getByRole('button', { name: '保存主目标' }));
  await screen.findByRole('heading', { name: '更明确的大目标' });
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ expectedRevision: 2, title: '更明确的大目标', detail: goal.detail });
});
it('does not replace an edited goal draft on background refetch', async () => {
  const client = show();
  fireEvent.click(screen.getByRole('button', { name: '编辑主目标' }));
  fireEvent.change(screen.getByLabelText('主目标'), { target: { value: '保留本地编辑' } });
  act(() => client.setQueryData(['project-goal', 'p'], { ...goal, title: '其他成员修改', revision: 3 }));
  await waitFor(() => expect(screen.getByLabelText('主目标')).toHaveValue('保留本地编辑'));
});
