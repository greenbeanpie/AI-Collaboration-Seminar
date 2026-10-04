import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamPage } from './TeamPage';

const state = vi.hoisted(() => ({
  role: 'member',
  permissions: undefined as Record<string, boolean> | undefined,
  canManagePermissions: false,
  me: 'me',
}));
vi.mock('../components/ProjectShell', () => ({
  useProject: () => ({ projectId: 'p', project: { myRole: state.role, permissions: state.permissions, canManagePermissions: state.canManagePermissions } }),
}));
vi.mock('../auth', () => ({
  useCapabilities: () => ({ data: { competitionTemplate: { teamSizeLimit: null } } }),
  useSession: () => ({ data: { id: state.me } }),
}));
vi.mock('./UsernameInvitations', () => ({ SentUsernameInvitations: () => <p>账号邀请</p> }));
afterEach(cleanup);

const all = { teamManage: true, taskManage: true, resourceManage: true, scoreInitiate: true, scoreCorrect: true };
const ordinary = { teamManage: false, taskManage: false, resourceManage: false, scoreInitiate: true, scoreCorrect: false };
const plainMember = { userId: 'u1', displayName: '普通成员甲', role: 'member', email: 'a@example.com', isAdmin: false, joinedAt: '2026-10-01', permissions: ordinary, permissionsRevision: 1, canManagePermissions: false };
const managerMember = { userId: 'u2', displayName: '协作管理员乙', role: 'member', email: 'b@example.com', isAdmin: false, joinedAt: '2026-10-01', permissions: all, permissionsRevision: 3, canManagePermissions: false };
const platformAdmin = { userId: 'u3', displayName: '平台管理员丙', role: 'member', email: 'c@example.com', isAdmin: true, joinedAt: '2026-10-01', permissions: all, permissionsRevision: 2, canManagePermissions: true };
const ownerMember = { userId: 'u4', displayName: '负责人丁', role: 'owner', email: 'd@example.com', isAdmin: false, joinedAt: '2026-10-01', permissions: all, permissionsRevision: 1, canManagePermissions: true };

function renderTeam(members: unknown[], options: { role?: string; permissions?: Record<string, boolean>; canManagePermissions?: boolean } = {}) {
  state.role = options.role ?? 'member';
  state.permissions = options.permissions;
  state.canManagePermissions = options.canManagePermissions ?? false;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['members', 'p'], members);
  client.setQueryData(['tasks', 'p'], []);
  client.setQueryData(['invitations', 'p'], { items: [] });
  client.setQueryData(['invitation-requests', 'p'], { items: [] });
  return render(<QueryClientProvider client={client}><TeamPage /></QueryClientProvider>);
}

it('retains member management without profile shortcuts for owner and member', () => {
  renderTeam([{ ...plainMember, displayName: '真实成员', email: null }], { role: 'owner' });
  expect(screen.getByText('真实成员')).toBeInTheDocument();
  expect(screen.queryByText('专业、技能与特长、偏好及每周可用时间统一在全局个人资料中维护。')).toBeNull();
  expect(screen.queryByRole('link', { name: '打开我的个人资料' })).toBeNull();
  expect(screen.queryByRole('link', { name: '打开任务工作区' })).toBeNull();
  expect(screen.getByRole('button', { name: '移除成员 真实成员' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '创建邀请码' })).toBeInTheDocument();
  cleanup();
  renderTeam([{ ...plainMember, displayName: '真实成员', email: null }], { role: 'member' });
  expect(screen.queryByRole('button', { name: '移除成员 真实成员' })).toBeNull();
  expect(screen.getByRole('button', { name: '退出项目' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '创建邀请码' })).toBeNull();
  expect(screen.queryByText('账号邀请')).toBeNull();
  expect(screen.getByRole('button', { name: '报请管理员批准' })).toBeInTheDocument();
});

it('owner sees the per-member permission entry for ordinary members', () => {
  renderTeam([plainMember, managerMember, ownerMember], { role: 'owner' });
  expect(screen.getByRole('button', { name: '调整 普通成员甲 的权限' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '调整 协作管理员乙 的权限' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '调整 负责人丁 的权限' })).toBeNull();
});

it('ordinary members see no permission entry and no invitation controls', () => {
  renderTeam([plainMember, ownerMember], { role: 'member', permissions: ordinary });
  expect(screen.queryByRole('button', { name: '调整 普通成员甲 的权限' })).toBeNull();
  expect(screen.queryByRole('button', { name: '创建邀请码' })).toBeNull();
  expect(screen.queryByText('账号邀请')).toBeNull();
  expect(screen.getByRole('button', { name: '报请管理员批准' })).toBeInTheDocument();
});

it('teamManage members manage invitations and removals but cannot edit permissions', () => {
  renderTeam([plainMember, ownerMember], { role: 'member', permissions: { ...ordinary, teamManage: true } });
  expect(screen.getByRole('button', { name: '创建邀请码' })).toBeInTheDocument();
  expect(screen.getByText('账号邀请')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '移除成员 普通成员甲' })).toBeInTheDocument();
  // teamManage 不等于权限管理：修改他人权限仍需 owner 或本项目内的平台管理员。
  expect(screen.queryByRole('button', { name: '调整 普通成员甲 的权限' })).toBeNull();
});

it('project-member platform admins can edit permissions while teamManage-only members cannot', () => {
  renderTeam([plainMember], { role: 'member', permissions: all, canManagePermissions: true });
  expect(screen.getByRole('button', { name: '调整 普通成员甲 的权限' })).toBeInTheDocument();
  cleanup();
  renderTeam([plainMember], { role: 'member', permissions: { ...ordinary, teamManage: true }, canManagePermissions: false });
  expect(screen.queryByRole('button', { name: '调整 普通成员甲 的权限' })).toBeNull();
});

it('owner and platform admins show a locked permission state instead of an editable entry', () => {
  renderTeam([platformAdmin, ownerMember], { role: 'owner' });
  expect(screen.getAllByText('权限锁定')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: '调整 平台管理员丙 的权限' })).toBeNull();
  expect(screen.queryByRole('button', { name: '移除成员 平台管理员丙' })).toBeNull();
});

it('summarises member permissions without listing five checkboxes', () => {
  renderTeam([plainMember, managerMember, platformAdmin, ownerMember], { role: 'owner' });
  expect(screen.getByText('普通成员 · 评分发起')).toBeInTheDocument();
  expect(screen.getByText('协作管理员 · 全部权限')).toBeInTheDocument();
  expect(screen.getByText('平台管理员 · 全部权限 · 权限由平台身份决定')).toBeInTheDocument();
  expect(screen.getByText('负责人 · 全部权限')).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).toBeNull();
});

it('keeps the mobile member card wrap-capable so new permission controls cannot overflow', () => {
  renderTeam([managerMember, ownerMember], { role: 'owner' });
  expect(screen.getByRole('button', { name: '调整 协作管理员乙 的权限' }).closest('.team-member-actions')).not.toBeNull();
  const css = readFileSync('src/pages/CompactSettings.css', 'utf8');
  expect(css).toMatch(/\.compact-team-grid \.team-member\{[^}]*flex-wrap:wrap/);
  expect(css).toMatch(/\.compact-team-grid \.team-member-actions\{[^}]*flex-wrap:wrap/);
  expect(css).toMatch(/@media\(max-width:600px\)\{[^}]*\.compact-team-grid \.team-member-actions\{width:100%/);
});
