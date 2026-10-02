import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamWorkspacePage } from './TeamWorkspacePage';
import { WorkWorkspacePage } from './WorkWorkspacePage';
const state = vi.hoisted(() => ({ role: 'owner' }));
vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'project-a', project: { myRole: state.role } }) }));
vi.mock('./TeamPage', () => ({ TeamPage: () => <h2>真实团队成员列表</h2> }));
vi.mock('./TasksPage', () => ({ TasksPage: () => <h2>统一主目标与依赖子任务</h2> }));
afterEach(() => { cleanup(); state.role = 'owner'; });
it.each(['owner', 'member'])('keeps team membership without redundant shortcut cards for %s', (role) => {
  state.role = role;
  render(<MemoryRouter><TeamWorkspacePage /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: '真实团队成员列表' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '团队设置' })).toBeNull();
  expect(screen.queryByRole('heading', { name: '导出' })).toBeNull();
  expect(screen.queryByRole('link', { name: '打开团队设置' })).toBeNull();
  expect(screen.queryByRole('link', { name: '打开项目导出' })).toBeNull();
});
it('the old work entry reuses the unified tasks workspace without another requirements summary', () => {
  render(<MemoryRouter><WorkWorkspacePage /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: '统一主目标与依赖子任务' })).toBeInTheDocument();
  expect(screen.queryByText('项目要求')).toBeNull();
  expect(screen.queryByText('评分标准')).toBeNull();
});
