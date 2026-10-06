import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TasksPage } from './TasksPage';
import { AiWorkspacePage } from './AiWorkspacePage';

vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'project-1', project: { myRole: 'owner' } }) }));
vi.mock('../auth', () => ({ useCapabilities: () => ({ data: { features: { aiEnabled: false } } }) }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

function cachedProject() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(['project-goal', 'project-1'], { title: '主目标', revision: 1, graphRevision: 1 });
  client.setQueryData(['collaboration-tasks', 'project-1'], { items: [] });
  client.setQueryData(['collaboration-settings', 'project-1'], { aiCollaborationEnabled: false, assignmentMode: 'manual', evaluationMode: 'manual' });
  client.setQueryData(['collaboration-proposals', 'project-1'], { items: [] });
  client.setQueryData(['member-me', 'project-1'], { userId: 'member-1' });
  client.setQueryData(['project-assistant-sources', 'project-1'], []);
  client.setQueryData(['members', 'project-1'], [{ userId: 'member-1', displayName: '真实成员甲', skills: [], hoursPerWeek: null, role: 'owner' }]);
  client.setQueryData(['requirementSets', 'project-1'], []);
  client.setQueryData(['materials', 'project-1'], []);
  client.setQueryData(['sources', 'project-1'], []);
  for (const key of ['materials', 'sources']) client.setQueryData([key, 'project-1', 'pages', { limit: 100 }, ''], { pages: [{ items: [], nextCursor: null }], pageParams: [null] });
  client.setQueryData(['agentSessions', 'project-1', 'pages', { status: 'all', limit: 100 }, ''], { pages: [{ items: [], nextCursor: null }], pageParams: [null] });
  client.setQueryData(['agentSessions', 'project-1'], []);
  client.setQueryData(['tasks', 'project-1', 'all'], []);
  client.setQueryData(['tasks', 'project-1'], [{ taskId: 'task-1', title: '真实协作任务', status: 'todo' }]);
  client.setQueryData(['tasks', 'project-1', 'pages', { limit: 100 }, ''], { pages: [{ items: [{ taskId: 'task-1', title: '真实协作任务', status: 'todo' }], nextCursor: null }], pageParams: [null] });
  return client;
}

describe('project pages share consistent list cache shapes', () => {
  it('task editing reads the member array already loaded by team/overview pages', () => {
    const client = cachedProject();
    render(<QueryClientProvider client={client}><MemoryRouter><TasksPage /></MemoryRouter></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    expect(screen.getByRole('option', { name: '真实成员甲' })).toBeInTheDocument();
  });

  it('the AI workspace reads its bounded page cache independently of the complete task graph', () => {
    const client = cachedProject();
    render(<QueryClientProvider client={client}><MemoryRouter><AiWorkspacePage /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole('option', { name: /真实协作任务/ })).toBeInTheDocument();
    expect(screen.getByText(/后端 AI/)).toBeInTheDocument();
  });
});
