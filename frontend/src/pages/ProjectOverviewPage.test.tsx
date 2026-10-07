import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ProjectOverviewPage } from './ProjectOverviewPage';
import type { Task } from '../api/types';

vi.mock('../api/client', async importOriginal => ({ ...await importOriginal<typeof import('../api/client')>(), listAllItems: vi.fn(() => new Promise(() => {})) }));
vi.mock('../components/ProjectAiChat', () => ({ ProjectAiChat: () => <div>询问 AI</div> }));
vi.mock('../components/ProjectShell', () => ({ useProject: () => ({
  projectId: 'overview-project',
  project: { deadlineDate: '2026-10-30', deadlinePrecision: 'day' },
}) }));
afterEach(cleanup);

function showOverview(sources: unknown[], options: { tasks?: Task[]; loading?: boolean; error?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const key of ['members', 'materials', 'requirementSets']) client.setQueryData([key, 'overview-project'], []);
  if (!options.loading) client.setQueryData(['tasks', 'overview-project'], options.tasks ?? []);
  if (options.error) client.getQueryCache().find({ queryKey: ['tasks', 'overview-project'] })!.setState({ status: 'error', error: new Error('任务读取失败') });
  client.setQueryData(['sources', 'overview-project'], sources);
  client.setQueryData(['project-goal', 'overview-project'], { title: '真实主目标', detail: '' });
  const view = render(<QueryClientProvider client={client}><MemoryRouter><ProjectOverviewPage /></MemoryRouter></QueryClientProvider>);
  return { ...view, client };
}

describe('project overview pending actions', () => {
  it('adds completion progress to the referenced 0/20 task metric', () => {
    const { container } = showOverview([], { tasks: Array.from({ length: 20 }, (_, index) => ({ taskId: `task-${index}`, title: `任务${index}`, status: 'todo' }) as Task) });
    expect(screen.getByText('0/20')).toBeInTheDocument();
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '任务完成率' })).toHaveAttribute('aria-valuenow', '0');
    expect(container.querySelector('.task-completion-card')).toHaveAttribute('data-completion-tone', 'red');
  });
  it('counts server-done tasks while submitted and blocked tasks remain incomplete', () => {
    showOverview([], { tasks: [
      { taskId: 'done', title: '已完成', status: 'done', lifecycleState: 'accepted' },
      { taskId: 'submitted', title: '待验收', status: 'doing', lifecycleState: 'submitted' },
      { taskId: 'blocked', title: '受阻', status: 'blocked' },
    ] as Task[] });
    expect(screen.getByText('1/3')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: '任务完成率' })).toHaveAttribute('aria-valuenow', '33');
  });
  it.each([{ loading: true }, { error: true }])('does not show progress for unavailable task data: %j', options => {
    const { container } = showOverview([], options);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(container.querySelector('.task-completion-card')).not.toHaveAttribute('data-completion-tone');
  });
  it('retains overview content without removed cards or their dedicated queries', () => {
    const { client } = showOverview([]);
    expect(screen.getByText('项目主目标')).toBeInTheDocument();
    expect(screen.getByText('任务完成')).toBeInTheDocument();
    expect(screen.getByText('待处理事项')).toBeInTheDocument();
    for (const title of ['最近活动', '协作模块', '项目空间']) expect(screen.queryByText(title)).toBeNull();
    for (const key of ['events', 'resource-library', 'standards']) expect(client.getQueryCache().find({ queryKey: [key] })).toBeUndefined();
  });
  it('shows the import action without claiming there is nothing to do', () => {
    const { container } = showOverview([]);
    expect(screen.getByText('导入通知或项目资料')).toBeInTheDocument();
    expect(screen.queryByText('暂无待处理事项')).not.toBeInTheDocument();
    expect(container.querySelector('.card-list')?.textContent).not.toBe('0');
    expect([...container.querySelector('.card-list')!.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent === '0')).toBe(false);
  });
  it('shows an empty checklist once all loaded data has no pending action', () => {
    showOverview([{ sourceId: 'source-1' }]);
    expect(screen.getByText('暂无待处理事项')).toBeInTheDocument();
    expect(screen.queryByText('导入通知或项目资料')).not.toBeInTheDocument();
  });
});
