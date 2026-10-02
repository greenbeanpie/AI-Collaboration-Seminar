import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ProjectOverviewPage } from './ProjectOverviewPage';

vi.mock('../components/ProjectShell', () => ({ useProject: () => ({
  projectId: 'overview-project',
  project: { deadlineDate: '2026-10-30', deadlinePrecision: 'day' },
}) }));
afterEach(cleanup);

function showOverview(sources: unknown[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const key of ['tasks', 'members', 'materials', 'requirementSets']) client.setQueryData([key, 'overview-project'], []);
  client.setQueryData(['sources', 'overview-project'], sources);
  client.setQueryData(['project-goal', 'overview-project'], { title: '真实主目标', detail: '' });
  const view = render(<QueryClientProvider client={client}><MemoryRouter><ProjectOverviewPage /></MemoryRouter></QueryClientProvider>);
  return { ...view, client };
}

describe('project overview pending actions', () => {
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
