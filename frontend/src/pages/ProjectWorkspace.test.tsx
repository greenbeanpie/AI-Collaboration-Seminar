import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { DataWorkspacePage } from './DataWorkspacePage';
import { TeamWorkspacePage } from './TeamWorkspacePage';
import { WorkWorkspacePage } from './WorkWorkspacePage';

const state = vi.hoisted(() => ({ role: 'owner' }));
vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'project-a', project: { myRole: state.role } }) }));
vi.mock('./TeamPage', () => ({ TeamPage: () => <h2>真实团队成员列表</h2> }));
vi.mock('./TasksPage', () => ({ TasksPage: () => <h2>现有任务与内嵌 AI 看板</h2> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); state.role = 'owner'; });
function dataClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['sources', 'project-a'], [{ sourceId: 'source-a', title: '项目通知原文', currentVersionId: 'source-version' }]);
  client.setQueryData(['materials', 'project-a'], [{ materialId: 'material-a', title: '参赛方案草稿', currentVersionId: 'material-version' }]);
  return client;
}
it('shows both real source and result sections together without loading either editor', () => {
  render(<QueryClientProvider client={dataClient()}><MemoryRouter><DataWorkspacePage /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByRole('heading', { name: '导入资料' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '成果材料' })).toBeInTheDocument();
  expect(screen.getByText('项目通知原文')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '项目通知原文' })).toHaveAttribute('href', '/app/projects/project-a/sources?sourceVersionId=source-version#source-source-a');
  expect(screen.getByText('参赛方案草稿')).toBeInTheDocument();
  expect(screen.getByText('共 1 份导入资料')).toBeInTheDocument();
  expect(screen.getByText('共 1 份成果材料')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '导入或管理资料' })).toHaveAttribute('href', '/app/projects/project-a/sources');
  expect(screen.getByRole('link', { name: '打开成果编辑器' })).toHaveAttribute('href', '/app/projects/project-a/materials');
  expect(screen.getByRole('link', { name: 'AI 协助成果' })).toHaveAttribute('href', '/app/projects/project-a/ai');
  expect(screen.queryByRole('textbox')).toBeNull();
});
it('a failed source list does not hide saved result materials or claim an empty source list', async () => {
  const client = dataClient(); client.removeQueries({ queryKey: ['sources', 'project-a'] });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  render(<QueryClientProvider client={client}><MemoryRouter><DataWorkspacePage /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getByText('参赛方案草稿')).toBeInTheDocument();
  expect(screen.queryByText('还没有导入资料')).toBeNull();
  expect(screen.queryByText(/共 0 份导入资料/)).toBeNull();
});
it('team members and export remain together, while settings controls require ownership', () => {
  const view = render(<MemoryRouter><TeamWorkspacePage /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: '团队设置' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '导出' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '真实团队成员列表' })).toBeInTheDocument();
  state.role = 'member'; view.rerender(<MemoryRouter><TeamWorkspacePage /></MemoryRouter>);
  expect(screen.queryByRole('link', { name: '打开团队设置' })).toBeNull();
  expect(screen.getByRole('link', { name: '打开项目导出' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '真实团队成员列表' })).toBeInTheDocument();
});
it('combines saved requirement/rubric summaries with the existing task board', () => {
  const client = dataClient();
  client.setQueryData(['requirementSets', 'project-a'], [{ status: 'confirmed' }, { status: 'draft' }]);
  client.setQueryData(['rubrics', 'project-a'], [{ status: 'draft' }]);
  render(<QueryClientProvider client={client}><MemoryRouter><WorkWorkspacePage /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByText('共 2 个要求集，1 个已确认。')).toBeInTheDocument();
  expect(screen.getByText('共 1 个评分版本，0 个已确认。')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '现有任务与内嵌 AI 看板' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '查看评分标准' })).toHaveAttribute('href', '/app/projects/project-a/requirements#rubric-versions');
});
