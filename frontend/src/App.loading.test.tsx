import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';

vi.mock('./auth', () => ({ useSession: () => ({ data: { id: 'fixture', displayName: '成员', role: 'user' }, isLoading: false }), useCapabilities: () => ({ data: {} }) }));
vi.mock('./components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <><nav aria-label="全局导航">我的项目</nav><main>{children}</main></> }));
vi.mock('./notifications/NotificationRuntime', () => ({ NotificationRuntime: () => null }));
vi.mock('./pages/AccountSettingsPage', () => ({ AccountSettingsPage: () => { throw new Promise(() => {}); } }));
vi.mock('./pages/TasksPage', () => ({ TasksPage: () => { throw new Promise(() => {}); } }));
vi.mock('./pages/DashboardPage', () => ({ DashboardPage: () => { throw new Promise(() => {}); } }));
afterEach(cleanup);
function setup(path: string) {
 const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
 client.setQueryData(['project', 'p'], { projectId: 'p', name: '项目标题', description: '已有项目说明', status: 'active', myRole: 'owner' });
 render(<QueryClientProvider client={client}><RouterProvider router={createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] })}/></QueryClientProvider>);
}
it('keeps global navigation while a route chunk suspends and confines its loader to content', async () => {
 setup('/app');
 await screen.findByText('正在打开工作区');
 expect(screen.getByRole('navigation', { name: '全局导航' })).toBeVisible();
 expect(document.querySelector('.center-screen')).toBeNull();
});
it('keeps settings navigation while only the missing settings form loads', async () => {
 setup('/app/settings/security');
 await screen.findByText('正在打开设置内容');
 expect(screen.getByRole('heading', { name: '设置' })).toBeVisible();
 expect(screen.getByRole('link', { name: '账户信息' })).toBeVisible();
 expect(screen.getByRole('navigation', { name: '全局导航' })).toBeVisible();
 expect(document.querySelector('.center-screen')).toBeNull();
});

it('keeps the loaded project banner and navigation while only the missing task content loads', async () => {
 setup('/app/projects/p/tasks');
 await screen.findByText('正在打开项目内容');
 expect(screen.getByRole('heading', { name: '项目标题' })).toBeVisible();
 expect(screen.getByRole('navigation', { name: '项目功能' })).toBeVisible();
 expect(document.querySelector('.center-screen')).toBeNull();
});
