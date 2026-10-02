import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
vi.mock('./auth', () => ({ useSession: () => ({ data: { id: 'account-a', displayName: 'Member', role: 'user' } }), useCapabilities: () => ({ data: {} }) }));
vi.mock('./components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => children }));
vi.mock('./components/ProjectShell', () => ({ ProjectShell: () => <Outlet /> }));
vi.mock('./pages/SettingsEditGuard', () => ({ SettingsEditGuard: ({ children }: { children: ReactNode }) => children }));
vi.mock('./notifications/NotificationRuntime', () => ({ NotificationRuntime: () => null }));
vi.mock('./pages/TasksPage', () => ({ TasksPage: () => <p>Unified task workspace</p> }));
vi.mock('./pages/DataWorkspacePage', () => ({ DataWorkspacePage: () => <p>Unified resource workspace</p> }));
vi.mock('./pages/AssessmentWorkspacePage', () => ({ AssessmentWorkspacePage: () => <p>Unified assessment workspace</p> }));
afterEach(cleanup);
function Location() { const location = useLocation(); return <output aria-label="Current URL">{location.pathname + location.search + location.hash}</output>; }
for (const [path, destination, content, extra] of [
  ['ai', 'data', 'Unified resource workspace', 'resourceType=material&ai=1'], ['materials', 'data', 'Unified resource workspace', 'resourceType=material'], ['sources', 'data', 'Unified resource workspace', 'mode=import&resourceType=source'], ['tasks', 'tasks', 'Unified task workspace', ''], ['work', 'tasks', 'Unified task workspace', ''], ['requirements', 'assessment', 'Unified assessment workspace', 'section=standards'], ['reviews', 'assessment', 'Unified assessment workspace', 'section=checks'], ['rehearsals', 'assessment', 'Unified assessment workspace', 'section=rehearsals'],
]) {
  it(`redirects ${path} into ${destination} while preserving record query and hash`, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/app/projects/project-a/${path}?task=existing#saved-position`]}><App /><Location /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText(content!)).toBeInTheDocument();
    expect(screen.getByLabelText('Current URL')).toHaveTextContent(`/app/projects/project-a/${destination}?task=existing${extra ? `&${extra}` : ''}#saved-position`);
  });
}
it('moves a cited source page and fragment into the resource detail without opening intake', async () => {
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/app/projects/project-a/sources?sourceVersionId=v1&page=3&fragmentId=f1#source-page-source-uuid-3']}><App /><Location /></MemoryRouter></QueryClientProvider>);
  await screen.findByText('Unified resource workspace');
  const url = screen.getByLabelText('Current URL').textContent;
  expect(url).toContain('/data?'); expect(url).toContain('sourceVersionId=v1'); expect(url).toContain('fragmentId=f1'); expect(url).toContain('resourceId=source-uuid'); expect(url).toContain('#source-page-source-uuid-3'); expect(url).not.toContain('mode=import');
});
