import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MaterialsPage } from './MaterialsPage';

vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'project-1' }) }));
vi.mock('../auth', () => ({ useSession: () => ({ data: { id: 'account-1' } }) }));
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

function renderMaterial() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['materials', 'project-1'], [{ materialId: 'material-1', title: '正式材料', revision: 1, updatedAt: '2026-09-30T00:00:00Z' }]);
  client.setQueryData(['material', 'project-1', 'material-1'], { materialId: 'material-1', title: '正式材料', revision: 1, currentVersion: { revision: 1, createdAt: '2026-09-30T00:00:00Z', doc: { type: 'doc', content: [{ type: 'paragraph' }] } } });
  client.setQueryData(['materialVersions', 'project-1', 'material-1'], []);
  client.setQueryData(['comments', 'project-1', 'material', 'material-1'], []);
  render(<QueryClientProvider client={client}><MaterialsPage /></QueryClientProvider>);
}

it('opening a server material enables editing without generating an unsaved draft', async () => {
  renderMaterial();
  await waitFor(() => expect(screen.getByLabelText('材料正文编辑器')).toHaveAttribute('contenteditable', 'true'));
  expect(screen.getByText('内容与服务端版本一致')).toBeInTheDocument();
  expect(screen.queryByText('发现本机未同步草稿')).not.toBeInTheDocument();
  expect(localStorage.getItem('buwei:draft:account-1:project-1:material-1')).toBeNull();
});

it('persists the submitted copy again when another tab cleared the draft before a conflict', async () => {
  const key = 'buwei:draft:account-1:project-1:material-1';
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '本机正文' }] }] };
  localStorage.setItem(key, JSON.stringify({ savedAt: '2026-09-30T00:00:00Z', value: { doc, baseRevision: 1, needsReconnectConfirmation: false } }));
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
    const conflict = options?.method === 'PUT';
    return new Response(JSON.stringify(conflict
      ? { requestId: 'conflict', error: { code: 'VERSION_CONFLICT', message: '版本冲突', retryable: false } }
      : { requestId: 'server', data: String(_url).endsWith('/material-1')
        ? { materialId: 'material-1', title: '正式材料', revision: 2, currentVersion: { doc, revision: 2, createdAt: '2026-09-30T00:00:00Z' } }
        : { items: [], nextCursor: null } }), { status: conflict ? 409 : 200, headers: { 'Content-Type': 'application/json' } });
  }));
  renderMaterial();
  fireEvent.click(await screen.findByRole('button', { name: '恢复草稿' }));
  localStorage.removeItem(key);
  fireEvent.click(screen.getByRole('button', { name: '保存新版本' }));
  await screen.findByRole('heading', { name: '服务端版本已更新，需要先对照内容' });
  expect(JSON.parse(localStorage.getItem(key)!).value).toEqual({ doc, baseRevision: 1, needsReconnectConfirmation: false });
  expect(screen.getByRole('button', { name: '保存新版本' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '按 r2 重试保存' })).toBeDisabled();
  expect(screen.getByText(/^服务端当前版本 r2 ·/)).toBeInTheDocument();
});
