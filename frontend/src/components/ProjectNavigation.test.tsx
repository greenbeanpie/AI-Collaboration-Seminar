import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import { AppShell } from './AppShell';
import { ProjectShell } from './ProjectShell';

const user = { id: 'fixture-user', username: 'alice', displayName: 'Alice', email: null, isAdmin: false, role: 'user' as const };
function setup(path = '/app/projects/fixture/settings') {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['project', 'fixture'], { id: 'fixture', name: 'Fixture project', description: 'Project content', status: 'active' });
  const router = createMemoryRouter([{ path: '/app', element: <AppShell user={user}><Outlet /></AppShell>, children: [
    { path: 'projects/:projectId', element: <ProjectShell />, children: [{ index: true, element: <p>Overview content</p> }, { path: '*', element: <p>Project route content</p> }] },
  ] }], { initialEntries: [path] });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}
afterEach(cleanup);
it('renders one project navigation between the project banner and its content, outside the account header', () => {
  setup();
  const navigation = screen.getByRole('navigation', { name: '项目功能' });
  expect(screen.getAllByRole('navigation', { name: '项目功能' })).toHaveLength(1);
  expect(navigation.previousElementSibling).toHaveClass('project-banner');
  expect(navigation.nextElementSibling).toHaveClass('content-wrap');
  expect(navigation.closest('header')).toBeNull();
  expect(within(screen.getByRole('banner', { name: '工作区顶栏' })).queryByRole('navigation', { name: '项目功能' })).not.toBeInTheDocument();
});
it('preserves all desktop links and mobile destinations, active state, Back and nested routes', async () => {
  const router = setup();
  const navigation = screen.getByRole('navigation', { name: '项目功能' });
  const links = within(navigation).getAllByRole('link');
  const select = within(navigation).getByRole('combobox', { name: '切换项目功能' });
  const paths = ['overview', 'sources', 'requirements', 'team', 'tasks', 'ai', 'materials', 'reviews', 'rehearsals', 'ledger', 'settings', 'export'];
  expect(links).toHaveLength(paths.length);
  expect(select).toHaveValue('settings');
  for (const [index, path] of paths.entries()) {
    const href = `/app/projects/fixture${path === 'overview' ? '' : '/' + path}`;
    expect(links[index]).toHaveAttribute('href', href);
    fireEvent.change(select, { target: { value: path } });
    expect(router.state.location.pathname).toBe(href);
    expect(select).toHaveValue(path);
    expect(links[index]).toHaveAttribute('aria-current', 'page');
  }
  await act(() => router.navigate(-1)); expect(select).toHaveValue('settings');
  await act(() => router.navigate('/app/projects/fixture/materials/document-id')); expect(select).toHaveValue('materials');
});
