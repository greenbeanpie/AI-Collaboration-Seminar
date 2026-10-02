import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { NewProjectEntryPage } from './NewProjectEntryPage';
vi.mock('../auth', () => ({ useSession: () => ({ data: { id: 'owner' }, isLoading: false }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });
function show() {
  const router = createMemoryRouter([{ path: '/app/projects/new', element: <NewProjectEntryPage /> }, { path: '/app/projects/new/wizard', element: <p>原分步向导</p> }, { path: '/app/projects/new/template/:draftId', element: <p>模板私有草稿</p> }, { path: '/other', element: <p>其他页面</p> }], { initialEntries: ['/app/projects/new'] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}
it('offers the original wizard and only the blank template, without creating a project', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => { calls.push(String(url)); return Response.json({ requestId: 'entry', data: String(url).includes('/project-templates') ? { items: [{ templateId: 'blank', name: '空项目', description: '不预填项目内容' }] } : { items: [] } }); }));
  const router = show();
  expect(screen.getByRole('link', { name: '分步创建' })).toHaveAttribute('href', '/app/projects/new/wizard');
  fireEvent.click(screen.getByRole('button', { name: '选择模板' }));
  expect(await screen.findByRole('heading', { name: '空项目' })).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: '使用空项目模板' })).toHaveLength(1);
  expect(calls.every(path => !path.startsWith('/api/v1/projects/'))).toBe(true);
  fireEvent.click(screen.getByRole('link', { name: '分步创建' }));
  await screen.findByText('原分步向导'); expect(router.state.location.pathname).toBe('/app/projects/new/wizard');
});
it('opens one private template draft with a stable idempotency key when clicked twice', async () => {
  const writes: Array<{ url: string; body: unknown; key: string | null }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { writes.push({ url: String(url), body: JSON.parse(String(init.body)), key: new Headers(init.headers).get('Idempotency-Key') }); await new Promise(resolve => setTimeout(resolve, 10)); return Response.json({ requestId: 'create', data: { id: 'draft-only' } }); }
    return Response.json({ requestId: 'entry', data: String(url).includes('/project-templates') ? { items: [{ templateId: 'blank', name: '空项目', description: '' }] } : { items: [] } });
  }));
  const router = show(); fireEvent.click(screen.getByRole('button', { name: '选择模板' }));
  const choose = await screen.findByRole('button', { name: '使用空项目模板' }); fireEvent.click(choose); fireEvent.click(choose);
  await screen.findByText('模板私有草稿'); expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ url: '/api/v1/creation-drafts/from-template', body: { templateId: 'blank' } });
  expect(writes[0]?.key).toBeTruthy(); expect(router.state.location.pathname).toBe('/app/projects/new/template/draft-only');
});
it('continues each existing draft in its own creation mode', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ requestId: 'drafts', data: { items: [{ id: 'wizard-draft', status: 'active', payload: { name: '原向导草稿' } }, { id: 'template-draft', status: 'cancelled', payload: { name: '空模板草稿', workspace: { templateId: 'blank', materials: [], standards: null } } }] } })));
  show();
  expect(await screen.findByRole('link', { name: /原向导草稿/ })).toHaveAttribute('href', '/app/projects/new/wizard?draftId=wizard-draft');
  expect(screen.getByRole('link', { name: /空模板草稿/ })).toHaveAttribute('href', '/app/projects/new/template/template-draft');
  await waitFor(() => expect(screen.getByText(/已取消，可恢复/)).toBeInTheDocument());
});

it('does not navigate away from another page after a stale template-open response', async () => {
  let respond: ((response: Response) => void) | undefined;
  const gate = new Promise<Response>(resolve => { respond = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => init?.method === 'POST' ? gate : Response.json({ requestId: 'entry', data: String(url).includes('/project-templates') ? { items: [{ templateId: 'blank', name: '空项目', description: '' }] } : { items: [] } })));
  const router = show(); fireEvent.click(screen.getByRole('button', { name: '选择模板' })); fireEvent.click(await screen.findByRole('button', { name: '使用空项目模板' }));
  await act(async () => router.navigate('/other'));
  await act(async () => respond?.(Response.json({ requestId: 'late', data: { id: 'old-draft' } })));
  expect(router.state.location.pathname).toBe('/other'); expect(screen.getByText('其他页面')).toBeInTheDocument();
});
