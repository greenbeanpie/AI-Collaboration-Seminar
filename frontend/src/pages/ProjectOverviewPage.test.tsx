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
  for (const key of ['tasks', 'members', 'materials', 'requirementSets', 'events']) client.setQueryData([key, 'overview-project'], []);
  client.setQueryData(['sources', 'overview-project'], sources);
  return render(<QueryClientProvider client={client}><MemoryRouter><ProjectOverviewPage /></MemoryRouter></QueryClientProvider>);
}

describe('project overview pending actions', () => {
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
