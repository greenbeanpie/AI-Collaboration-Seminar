import { cancelPageDialog } from '../dialogs/dialog-service';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MaterialsPage } from './MaterialsPage';

vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'project-1' }) }));
vi.mock('../auth', () => ({ useSession: () => ({ data: { id: 'account-1' } }) }));
afterEach(async () => { await act(async()=>{cancelPageDialog();}); cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

function renderMaterial(props: Parameters<typeof MaterialsPage>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['materials', 'project-1'], [{ materialId: 'material-1', title: '正式材料', revision: 1, updatedAt: '2026-09-30T00:00:00Z' }]);
  client.setQueryData(['material', 'project-1', 'material-1'], { materialId: 'material-1', title: '正式材料', revision: 1, currentVersion: { revision: 1, createdAt: '2026-09-30T00:00:00Z', doc: { type: 'doc', content: [{ type: 'paragraph' }] } } });
  client.setQueryData(['materialVersions', 'project-1', 'material-1'], []);
  client.setQueryData(['comments', 'project-1', 'material', 'material-1'], []);
  render(<QueryClientProvider client={client}><MaterialsPage {...props} /></QueryClientProvider>);
  return client;
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
it('canceling discard keeps the local draft and approval removes only that local draft',async()=>{
 const key='buwei:draft:account-1:project-1:material-1';const draft={savedAt:'2026-09-30T00:00:00Z',value:{doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'保留草稿'}]}]},baseRevision:1,needsReconnectConfirmation:false}};
 localStorage.setItem(key,JSON.stringify(draft));renderMaterial();fireEvent.click(await screen.findByRole('button',{name:'放弃草稿'}));
 let dialog=await screen.findByRole('dialog');expect(dialog).toHaveTextContent('此操作不会修改服务端版本');fireEvent.click(within(dialog).getByRole('button',{name:'取消'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(JSON.parse(localStorage.getItem(key)!)).toEqual(draft);
 fireEvent.click(screen.getByRole('button',{name:'放弃草稿'}));dialog=await screen.findByRole('dialog');fireEvent.click(within(dialog).getByRole('button',{name:'确定'}));await waitFor(()=>expect(localStorage.getItem(key)).toBeNull());expect(screen.getByText('内容与服务端版本一致')).toBeInTheDocument();
});
it('link input is an in-page prompt; cancellation retains the document and default value',async()=>{
 renderMaterial();await waitFor(()=>expect(screen.getByLabelText('材料正文编辑器')).toHaveAttribute('contenteditable','true'));fireEvent.click(screen.getByRole('button',{name:'设置链接'}));
 const dialog=await screen.findByRole('dialog');expect(within(dialog).getByRole('textbox')).toHaveValue('https://');fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'https://example.test'}});fireEvent.click(within(dialog).getByRole('button',{name:'取消'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(screen.getByText('内容与服务端版本一致')).toBeInTheDocument();
});
it('discarding after a background version refresh restores the latest server document',async()=>{
 const key='buwei:draft:account-1:project-1:material-1';localStorage.setItem(key,JSON.stringify({savedAt:'2026-09-30T00:00:00Z',value:{doc:{type:'doc',content:[{type:'paragraph'}]},baseRevision:1,needsReconnectConfirmation:false}}));
 const client=renderMaterial();fireEvent.click(await screen.findByRole('button',{name:'放弃草稿'}));const dialog=await screen.findByRole('dialog');
 act(()=>{client.setQueryData(['material','project-1','material-1'],{materialId:'material-1',title:'正式材料',revision:2,currentVersion:{revision:2,createdAt:'2026-10-01T00:00:00Z',doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'最新服务端内容'}]}]}}});});
 await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:'确定'}));});expect(localStorage.getItem(key)).toBeNull();expect(screen.getByLabelText('材料正文编辑器')).toHaveTextContent('最新服务端内容');
});
it('a link decision does not modify a different document received while the prompt was open',async()=>{
 const client=renderMaterial();await waitFor(()=>expect(screen.getByLabelText('材料正文编辑器')).toHaveAttribute('contenteditable','true'));fireEvent.click(screen.getByRole('button',{name:'设置链接'}));const dialog=await screen.findByRole('dialog');
 act(()=>{client.setQueryData(['material','project-1','material-1'],{materialId:'material-1',title:'正式材料',revision:2,currentVersion:{revision:2,createdAt:'2026-10-01T00:00:00Z',doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'已更新正文'}]}]}}});});
 await waitFor(()=>expect(screen.getByLabelText('材料正文编辑器')).toHaveTextContent('已更新正文'));
 fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'https://example.test'}});await act(async()=>{fireEvent.click(within(dialog).getByRole('button',{name:'确定'}));});expect(await screen.findByText('材料内容已变化，请重新选择文字后设置链接。')).toBeInTheDocument();expect(screen.getByLabelText('材料正文编辑器').querySelector('a')).toBeNull();
});

it('version history is collapsed by default, paginates five at a time, and resets for a different material', async () => {
  const client = renderMaterial();
  act(() => client.setQueryData(['materialVersions', 'project-1', 'material-1'], Array.from({ length: 11 }, (_, index) => ({ versionId: `v${index}`, revision: 11 - index, origin: 'manual', createdAt: '2026-10-02T00:00:00Z' }))));
  const summary = screen.getByText('版本历史');
  expect(summary.closest('details')).not.toHaveAttribute('open');
  fireEvent.click(summary);
  await waitFor(() => expect(screen.getAllByText(/^版本 r/)).toHaveLength(5));
  const pager = screen.getByRole('navigation', { name: '版本历史分页' });
  expect(within(pager).getByRole('button', { name: '上一页' })).toBeDisabled();
  fireEvent.click(within(pager).getByRole('button', { name: '下一页' }));
  expect(within(pager).getByText('2 / 3')).toBeVisible();
  fireEvent.click(within(pager).getByRole('button', { name: '下一页' }));
  expect(screen.getAllByText(/^版本 r/)).toHaveLength(1);
  expect(within(pager).getByRole('button', { name: '下一页' })).toBeDisabled();
  act(() => {
    client.setQueryData(['materials', 'project-1'], [{ materialId: 'material-1', title: '正式材料', revision: 1, updatedAt: '2026-09-30T00:00:00Z' }, { materialId: 'material-2', title: '另一材料', revision: 1, updatedAt: '2026-09-30T00:00:00Z' }]);
    client.setQueryData(['materialVersions', 'project-1', 'material-2'], []);
  });
  fireEvent.click(await screen.findByRole('button', { name: /另一材料/ }));
  await waitFor(() => expect(screen.getByText('版本历史').closest('details')).not.toHaveAttribute('open'));
});
it('a requested historical version opens history on the page containing that version', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ requestId: 'test', data: { revision: 1, createdAt: '2026-10-02T00:00:00Z', doc: { type: 'doc', content: [{ type: 'paragraph' }] } } }), { headers: { 'Content-Type': 'application/json' } })));
  const client = renderMaterial({ materialId: 'material-1', versionId: 'v6' });
  act(() => client.setQueryData(['materialVersions', 'project-1', 'material-1'], Array.from({ length: 11 }, (_, index) => ({ versionId: `v${index}`, revision: 11 - index, origin: 'manual', createdAt: '2026-10-02T00:00:00Z' }))));
  expect(screen.getByText('版本历史').closest('details')).toHaveAttribute('open');
  const pager = await screen.findByRole('navigation', { name: '版本历史分页' });
  expect(within(pager).getByText('2 / 3')).toBeVisible();
  expect(screen.getByText('版本 r5')).toBeVisible();
});
