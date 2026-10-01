import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';

vi.mock('./auth', () => ({ useSession: () => ({ data: { id: 'account-a', displayName: 'Member', role: 'user' } }), useCapabilities: () => ({ data: {} }) }));
vi.mock('./components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => children }));
vi.mock('./components/ProjectShell', () => ({ ProjectShell: () => <Outlet /> }));
vi.mock('./notifications/NotificationRuntime', () => ({ NotificationRuntime: () => null }));
vi.mock('./pages/MaterialsPage', () => ({ MaterialsPage: ({ initialAiOpen = false }: { initialAiOpen?: boolean }) => <p>{initialAiOpen ? 'Result workspace with AI open' : 'Result workspace with AI closed'}</p> }));
vi.mock('./pages/SourcesPage', () => ({ SourcesPage: () => <p>Existing source workspace</p> }));
vi.mock('./pages/TasksPage', () => ({ TasksPage: () => <p>Existing task workspace</p> }));
vi.mock('./pages/DataWorkspacePage', () => ({ DataWorkspacePage: () => <p>Combined data workspace</p> }));
vi.mock('./pages/WorkWorkspacePage', () => ({ WorkWorkspacePage: () => <p>Combined work workspace</p> }));
afterEach(cleanup);
function Location() { const location = useLocation(); return <output aria-label="Current URL">{location.pathname + location.search + location.hash}</output>; }
for (const [path, content] of [['ai', 'Result workspace with AI open'], ['materials', 'Result workspace with AI closed'], ['sources', 'Existing source workspace'], ['tasks', 'Existing task workspace'], ['data', 'Combined data workspace'], ['work', 'Combined work workspace']]) {
  it(`opens ${path} without dropping its saved deep-link query or hash`, async () => {
    const url = `/app/projects/project-a/${path}?task=existing#saved-position`;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><App /><Location /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText(content!)).toBeInTheDocument();
    expect(screen.getByLabelText('Current URL')).toHaveTextContent(url);
  });
}
