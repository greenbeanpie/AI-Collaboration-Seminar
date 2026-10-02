import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { AppShell } from './AppShell';
import { ProjectShell } from './ProjectShell';
import { SettingsEditGuard } from '../pages/SettingsEditGuard';
import { useSettingsDirty } from '../pages/settings-dirty';
import { cancelPageDialog } from '../dialogs/dialog-service';

const user = { id: 'fixture-user', username: 'alice', displayName: 'Alice', email: null, isAdmin: false, role: 'user' as const };
function Editor() {
  const [draft, setDraft] = useState('');
  useSettingsDirty(Boolean(draft));
  return <input aria-label="Fixture draft" value={draft} onChange={event => setDraft(event.target.value)} />;
}
function setup(path = '/app/projects/fixture/settings', owner = true) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['session'], user);
  client.setQueryData(['project', 'fixture'], { id: 'fixture', name: 'Fixture project', description: 'Project content', status: 'active', myRole: owner ? 'owner' : 'member' });
  const router = createMemoryRouter([{ path: '/app', element: <AppShell user={user}><Outlet /></AppShell>, children: [
    { path: 'projects/:projectId', element: <SettingsEditGuard><ProjectShell /></SettingsEditGuard>, children: [{ index: true, element: <p>Overview content</p> }, { path: 'materials', element: <Editor /> }, { path: '*', element: <p>Project route content</p> }] },
  ] }], { initialEntries: [path] });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}
afterEach(async () => { await act(async () => { cancelPageDialog(); }); cleanup(); });
it('keeps exactly five main destinations in the content area, outside global account controls', () => {
  setup();
  const navigation = screen.getByRole('navigation', { name: '项目功能' });
  expect(screen.getAllByRole('navigation', { name: '项目功能' })).toHaveLength(1);
  expect(navigation.previousElementSibling).toHaveClass('project-banner');
  expect(navigation.nextElementSibling).toHaveClass('content-wrap');
  expect(navigation.closest('header')).toBeNull();
  expect(within(screen.getByRole('banner', { name: '工作区顶栏' })).queryByRole('navigation', { name: '项目功能' })).not.toBeInTheDocument();
  expect(within(navigation).getAllByRole('link').map(link => link.textContent)).toEqual(['概览', '任务', '资料', '评分', '团队']);
  expect(within(navigation).queryByRole('link', { name: /AI/ })).toBeNull();
  expect(within(navigation).getAllByRole('option')).toHaveLength(5);
});
it('mobile switching and browser Back retain group state without changing existing deep links', async () => {
  const router = setup();
  const select = screen.getByRole('combobox', { name: '切换项目功能' });
  const groups = [['overview', ''], ['work', '/tasks'], ['data', '/data'], ['team', '/team'], ['assessment', '/assessment']];
  for (const [id, suffix] of groups) {
    fireEvent.change(select, { target: { value: id } });
    expect(router.state.location.pathname).toBe(`/app/projects/fixture${suffix}`);
    expect(select).toHaveValue(id);
  }
  await act(() => router.navigate(-1)); expect(select).toHaveValue('team');
  await act(() => router.navigate(1)); expect(select).toHaveValue('assessment');
  const routes = [['sources', 'data', '项目资料'], ['materials/document-id', 'data', '项目资料'], ['ai', 'data', '项目资料'], ['requirements', 'assessment', '标准与评分'], ['tasks', 'work', '任务工作区'], ['team', 'team', '团队成员'], ['settings', 'team', '团队设置'], ['export', 'team', '导出'], ['reviews', 'assessment', '标准与评分'], ['rehearsals', 'assessment', '标准与评分'], ['ledger', 'overview', '活动历史']];
  for (const [path, group, section] of routes) {
    await act(() => router.navigate(`/app/projects/fixture/${path}?saved=1#evidence`));
    expect(select).toHaveValue(group);
    const navigation = screen.getAllByRole('navigation').find(nav => nav.getAttribute('aria-label')?.endsWith('分区'))!;
    expect(within(navigation).getByRole('link', { name: section })).toHaveAttribute('aria-current', 'page');
    expect(router.state.location.search + router.state.location.hash).toBe('?saved=1#evidence');
  }
});
it('keeps draft cancellation effective for both main navigation and section links', async () => {
  const router = setup('/app/projects/fixture/materials');
  fireEvent.change(screen.getByLabelText('Fixture draft'), { target: { value: 'Keep this draft' } });
  const select = screen.getByRole('combobox', { name: '切换项目功能' });
  fireEvent.change(select, { target: { value: 'work' } });
  let dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(select).toHaveValue('data'); expect(screen.getByLabelText('Fixture draft')).toHaveValue('Keep this draft');
  fireEvent.click(within(screen.getByRole('navigation', { name: '资料分区' })).getByRole('link', { name: '项目资料' }));
  dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(router.state.location.pathname).toBe('/app/projects/fixture/materials');
  expect(screen.getByLabelText('Fixture draft')).toHaveValue('Keep this draft');
});
it('hides owner-only team setting entry while retaining permitted member/export destinations', () => {
  setup('/app/projects/fixture/team', false);
  const sections = screen.getByRole('navigation', { name: '团队分区' });
  expect(within(sections).queryByRole('link', { name: '团队设置' })).toBeNull();
  expect(within(sections).getByRole('link', { name: '团队成员' })).toBeInTheDocument();
  expect(within(sections).getByRole('link', { name: '导出' })).toBeInTheDocument();
});
