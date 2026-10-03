import { act, cleanup, fireEvent, render, screen, within,waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
import { ThemeSelector } from './ThemeSelector';
const user = { id: 'fixture', username: 'alice', displayName: 'Alice', email: null, isAdmin: false, role: 'user' as const };
function setup(path = '/app/profile') {
  const router = createMemoryRouter([{ path: '*', element: <AppShell user={user}><ThemeSelector variant="field"/><p>Workspace content</p></AppShell> }], { initialEntries: [path] });
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router}/></QueryClientProvider>);
  return router;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete document.documentElement.dataset.themePreference; });
it('places the app brand above left navigation and profile in an independent route', () => {
  setup();
  const nav = screen.getByRole('navigation', { name: '主导航' });
  expect(within(nav).getByRole('link', { name: '个人资料' })).toHaveAttribute('href', '/app/profile');
  expect(within(nav).getByRole('link', { name: '设置' })).toHaveAttribute('href', '/app/settings');
  expect(within(nav).getByRole('link', { name: '帮助文档' })).toHaveAttribute('href', '/app/help');
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

it('keeps project navigation out of the global account header', () => {
  setup('/app/projects/fixture/settings');
  const topbar = screen.getByRole('banner', { name: '工作区顶栏' });
  expect(within(topbar).queryByRole('navigation', { name: '项目功能' })).not.toBeInTheDocument();
  expect(within(topbar).getByRole('button', { name: '主题与账户操作' })).toBeInTheDocument();
});
it('does not render project controls on the new-project form', () => {
  setup('/app/projects/new');
  expect(screen.queryByRole('navigation', { name: '项目功能' })).not.toBeInTheDocument();
});
it('keeps compact account actions reachable and closes on Escape, outside press and navigation', async () => {
  const router = setup('/app/projects/fixture');
  const toggle = screen.getByRole('button', { name: '主题与账户操作' });
  const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(panel).toHaveAttribute('data-open', 'true');
  expect(within(panel).getByRole('combobox', { name: '主题' })).toBeInTheDocument();
  expect(within(panel).getByRole('button', { name: '退出登录' })).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(toggle).toHaveFocus();
  fireEvent.click(toggle);
  fireEvent.pointerDown(screen.getByText('Workspace content'));
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggle);
  await act(() => router.navigate('/app/projects/fixture/tasks'));
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

it('logs out unsubscribed devices without sending an invalid empty UUID header',async()=>{
 vi.stubGlobal('navigator',{serviceWorker:{getRegistration:vi.fn(async()=>undefined)}});
 const fetch=vi.fn(async(_path:RequestInfo|URL,_options?:RequestInit)=>{void _path;void _options;return new Response(JSON.stringify({data:{cleared:true},requestId:'fixture-request'}),{status:200,headers:{'Content-Type':'application/json'}});});vi.stubGlobal('fetch',fetch);localStorage.removeItem('app-push-device:fixture');
 const router=setup();fireEvent.click(screen.getByRole('button',{name:'退出登录'}));await waitFor(()=>expect(router.state.location.pathname).toBe('/login'));
 expect(fetch).toHaveBeenCalledOnce();const options=fetch.mock.calls[0]?.[1] as RequestInit;const headers=new Headers(options.headers);expect(headers.has('X-Push-Subscription-Id')).toBe(false);expect(headers.get('X-Notification-Account')).toBe('fixture');
});
it('does not send an empty subscription header and locks repeated logout clicks',async()=>{
 const calls:RequestInit[]=[];vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{calls.push(init);return Response.json({data:{revoked:true},requestId:'test'});}));setup();
 const logout=screen.getByRole('button',{name:'退出登录'});await act(async()=>{fireEvent.click(logout);fireEvent.click(logout);});
 expect(calls).toHaveLength(1);expect(new Headers(calls[0].headers).has('X-Push-Subscription-Id')).toBe(false);expect(new Headers(calls[0].headers).get('X-Notification-Account')).toBe(user.id);

});
