import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamPage } from './TeamPage';

const state = vi.hoisted(() => ({ role: 'member' }));
vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p', project: { myRole: state.role } }) }));
vi.mock('../auth', () => ({ useCapabilities: () => ({ data: { competitionTemplate: { teamSizeLimit: null } } }) }));
vi.mock('./UsernameInvitations', () => ({ SentUsernameInvitations: () => <p>账号邀请</p> }));
afterEach(cleanup);

it.each(['owner', 'member'])('retains member management without profile shortcuts for %s', (role) => {
  state.role = role;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['members', 'p'], [{ userId: 'u', displayName: '真实成员', role: 'member', email: null }]);
  client.setQueryData(['tasks', 'p'], []);
  client.setQueryData(['invitations', 'p'], { items: [] });
  client.setQueryData(['invitation-requests','p'],{items:[]});
  render(<QueryClientProvider client={client}><TeamPage /></QueryClientProvider>);
  expect(screen.getByText('真实成员')).toBeInTheDocument();
  expect(screen.queryByText('专业、技能与特长、偏好及每周可用时间统一在全局个人资料中维护。')).toBeNull();
  expect(screen.queryByRole('link', { name: '打开我的个人资料' })).toBeNull();
  expect(screen.queryByRole('link', { name: '打开任务工作区' })).toBeNull();
  if (role === 'owner') {
    expect(screen.getByRole('button', { name: '移除成员 真实成员' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建邀请码' })).toBeInTheDocument();
  } else {
    expect(screen.queryByRole('button', { name: '移除成员 真实成员' })).toBeNull();
    expect(screen.getByRole('button', { name: '退出项目' })).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'创建邀请码'})).toBeNull();
    expect(screen.queryByText('账号邀请')).toBeNull();
    expect(screen.getByRole('button',{name:'报请管理员批准'})).toBeInTheDocument();
  }
});
