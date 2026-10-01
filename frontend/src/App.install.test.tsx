import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';
import { resetForTest } from './pwa-install';

const state = vi.hoisted(() => ({ loggedIn: false }));
vi.mock('./auth', () => ({ useSession: () => ({ data: state.loggedIn ? { id: 'test-user', displayName: 'Test', role: 'user' } : null, isLoading: false }), useCapabilities: () => ({ data: {} }) }));
vi.mock('virtual:pwa-register/react', () => ({ useRegisterSW: () => ({ needRefresh: [false], updateServiceWorker: vi.fn() }) }));
vi.mock('./components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('./pages/DashboardPage', () => ({ DashboardPage: () => <h1>我的项目</h1> }));
vi.mock('./pages/LoginPage', () => ({ LoginPage: () => <h1>登录页</h1> }));
vi.mock('./pages/AccountSettingsPage', () => ({ AccountSettingsPage: () => <h1>账户设置</h1> }));
function Harness() {
  const navigate = useNavigate();
  return <><button onClick={() => { state.loggedIn = true; navigate('/app'); }}>进入我的项目</button><button onClick={() => navigate('/app/settings')}>打开其他页面</button><App /></>;
}
afterEach(() => { cleanup(); resetForTest(); sessionStorage.clear(); });

it('captures install eligibility before login but renders the prompt only on the first authenticated /app visit', async () => {
  const notifications = vi.fn();
  window.addEventListener('app-notification', notifications);
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={createMemoryRouter([{ path: '*', element: <Harness /> }], { initialEntries: ['/login'] })} /></QueryClientProvider>);
  await screen.findByText('登录页');
  const prompt = vi.fn(async () => {});
  const event = new Event('beforeinstallprompt', { cancelable: true });
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }) });
  act(() => { window.dispatchEvent(event); });
  expect(screen.queryByRole('button', { name: '安装到桌面' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '进入我的项目' }));
  await screen.findByRole('heading', { name: '我的项目' });
  expect(notifications).toHaveBeenCalledTimes(1);
  expect(notifications.mock.calls[0][0].detail).toMatchObject({ id: 'install', action: 'install' });
  expect(prompt).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '打开其他页面' }));
  await screen.findByRole('heading', { name: '账户设置' });
  expect(screen.queryByRole('button', { name: '安装到桌面' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '进入我的项目' }));
  await screen.findByRole('heading', { name: '我的项目' });
  expect(screen.queryByRole('button', { name: '安装到桌面' })).not.toBeInTheDocument();
  expect(notifications).toHaveBeenCalledTimes(1);
  window.removeEventListener('app-notification', notifications);
});
