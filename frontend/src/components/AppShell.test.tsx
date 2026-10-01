import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
import { ThemeSelector } from './ThemeSelector';
const user = { id: 'fixture', username: 'alice', displayName: 'Alice', email: null, isAdmin: false, role: 'user' as const };
function setup() {
  const router = createMemoryRouter([{ path: '*', element: <AppShell user={user}><ThemeSelector variant="field"/><p>Workspace content</p></AppShell> }], { initialEntries: ['/app/profile'] });
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router}/></QueryClientProvider>);
  return router;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete document.documentElement.dataset.themePreference; });
it('places the app brand above left navigation and profile in an independent route', () => {
  setup();
  const nav = screen.getByRole('navigation', { name: '主导航' });
  expect(within(nav).getByRole('link', { name: '个人资料' })).toHaveAttribute('href', '/app/profile');
  expect(within(nav).getByRole('link', { name: '设置' })).toHaveAttribute('href', '/app/settings');
  expect(document.querySelector('.sidebar-brand .brand')).toHaveAttribute('href', '/app');
  expect(document.querySelector('.sidebar-brand')?.nextElementSibling).toHaveClass('sidebar-navigation');
  const topbar = screen.getByRole('banner', { name: '工作区顶栏' });
  expect(within(topbar).getByRole('link', { name: '支持工单' })).toBeInTheDocument();
  expect(within(topbar).getByRole('link', { name: '个人资料：Alice' })).toHaveAttribute('href', '/app/profile');
  expect(within(topbar).getByRole('button', { name: '退出登录' })).toBeInTheDocument();
});
it('keeps toolbar and settings theme controls synchronized through the existing theme events', () => {
  document.documentElement.dataset.themePreference = 'system';
  const dispatch = vi.spyOn(window, 'dispatchEvent'); setup();
  const controls = screen.getAllByRole('combobox', { name: '主题' }); expect(controls).toHaveLength(2);
  expect(controls[0]).toHaveValue('system'); expect(controls[1]).toHaveValue('system');
  fireEvent.change(controls[0], { target: { value: 'dark' } });
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'office-theme-select', detail: 'dark' }));
  act(() => { document.documentElement.dataset.themePreference = 'dark'; window.dispatchEvent(new Event('office-theme-change')); });
  expect(controls[0]).toHaveValue('dark'); expect(controls[1]).toHaveValue('dark');
  expect(controls[1].closest('label')).toHaveClass('field');
});
it('an unsaved-editor logout veto prevents account API writes', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); setup();
  const veto = (event: Event) => event.preventDefault(); window.addEventListener('settings-before-leave', veto);
  try { fireEvent.click(screen.getByRole('button', { name: '退出登录' })); expect(fetch).not.toHaveBeenCalled(); }
  finally { window.removeEventListener('settings-before-leave', veto); }
});
