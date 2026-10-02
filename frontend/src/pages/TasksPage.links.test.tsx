import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { TasksPage } from './TasksPage';
vi.mock('./CollaborationWorkspace', () => ({ CollaborationWorkspace: () => { const [params] = useSearchParams(); return <p>统一子任务工作区 {params.get('task')}</p>; } }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('omits the redundant task heading and retains legacy task selection without requesting or editing the main goal', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/tasks?task=legacy-task']}><TasksPage /></MemoryRouter></QueryClientProvider>);
  expect(screen.queryByRole('heading', { name: '任务工作区' })).toBeNull();
  expect(screen.getByText('统一子任务工作区 legacy-task')).toBeInTheDocument();
  expect(screen.queryByText('项目主目标')).toBeNull();
  expect(screen.queryByRole('button', { name: '编辑主目标' })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(client.getQueryCache().find({ queryKey: ['project-goal'] })).toBeUndefined();
});
