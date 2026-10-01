import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import App from '../App';
const state = vi.hoisted(() => ({ role: 'user', isAdmin: false }));
vi.mock('../auth', () => ({ useSession: () => ({ data: { id: 'fixture', ...state }, isLoading: false }), useCapabilities: () => ({ data: {} }) }));
vi.mock('../components/AppShell', () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('./AccountSettingsPage', () => ({ AccountSettingsPage: ({ section }: { section: string }) => <p>Account section {section}</p> }));
vi.mock('./AiSettings', () => ({ AiSettings: () => <p>Privileged AI content</p> }));
vi.mock('./AdminAccountsPage', () => ({ AdminAccountsPage: () => <p>Privileged accounts content</p> }));
function setup(path: string) { const router = createMemoryRouter([{ path: '*', element: <App /> }], { initialEntries: [path] }); render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>); return router; }
afterEach(() => { cleanup(); state.role = 'user'; state.isAdmin = false; });
it('direct settings URLs do not render privileged pages for ordinary users', async () => {
 setup('/app/settings/accounts'); await screen.findByRole('alert'); expect(screen.queryByText('Privileged accounts content')).toBeNull(); cleanup();
 setup('/app/settings/ai'); await screen.findByRole('alert'); expect(screen.queryByText('Privileged AI content')).toBeNull();
});
it('admin cannot access super-admin AI configuration, including legacy URL', async () => {
 state.role = 'admin'; state.isAdmin = true; const router = setup('/app/admin/ai'); await screen.findByRole('alert'); expect(router.state.location.pathname).toBe('/app/settings/ai'); expect(screen.queryByText('Privileged AI content')).toBeNull();
});
it('legacy account URL redirects to authorized management tab', async () => {
 state.role = 'admin'; state.isAdmin = true; const router = setup('/app/admin/accounts'); await screen.findByText('Privileged accounts content'); expect(router.state.location.pathname).toBe('/app/settings/accounts');
});
it('default settings URL resolves profile while security deep link is independent', async () => {
 const router = setup('/app/settings'); await screen.findByText('Account section profile'); expect(router.state.location.pathname).toBe('/app/settings/profile'); cleanup(); setup('/app/settings/security'); await screen.findByText('Account section security');
});
