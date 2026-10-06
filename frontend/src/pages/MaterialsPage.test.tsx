import { cancelPageDialog } from '../dialogs/dialog-service';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MaterialsPage } from './MaterialsPage';

vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'project-1' }) }));
vi.mock('../auth', () => ({ useSession: () => ({ data: { id: 'account-1' } }) }));
vi.mock('./FilePreview', () => ({ FilePreview: ({ fileId, name }: { fileId: string; name: string }) => <section aria-label={`预览 ${name}`} data-file-id={fileId}>原文件预览 {name}</section> }));
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

function seedHistory(client: QueryClient, count = 11) {
  const versions = Array.from({ length: count }, (_, index) => ({ versionId: `v${index}`, revision: count - index, origin: 'manual', createdAt: '2026-10-02T00:00:00Z', doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `快照正文 ${index}` }] }] }, attachments: [] }));
  for (const version of versions) client.setQueryData(['materialVersion', 'project-1', 'material-1', version.versionId], version);
  client.setQueryData(['materialVersions', 'project-1', 'material-1'], versions);
  return versions;
}

it('previews task attachments before the editable existing body and pins history to its attachment snapshot', async () => {
  const client = renderMaterial();
  const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '已有任务成果说明' }] }] };
  act(() => {
    client.setQueryData(['material', 'project-1', 'material-1'], { materialId: 'material-1', title: '任务成果', kind: 'task-file', canEdit: true, revision: 2, currentVersion: { versionId: 'current', revision: 2, createdAt: '2026-10-01', doc: body, attachments: [{ fileId: 'current-file', name: '新版.pdf' }] } });
    const historical = { versionId: 'history', revision: 1, origin: 'manual', createdAt: '2026-10-01', doc: body, attachments: [{ fileId: 'old-file', name: '旧版.pdf' }] };
    client.setQueryData(['materialVersions', 'project-1', 'material-1'], [historical]);
    client.setQueryData(['materialVersion', 'project-1', 'material-1', 'history'], historical);
  });
  const preview = await screen.findByLabelText('预览 新版.pdf');
  const editor = screen.getByLabelText('材料正文编辑器');
  await waitFor(() => expect(editor).toHaveTextContent('已有任务成果说明'));
  expect(editor).toHaveAttribute('contenteditable', 'true');
  expect(preview.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText('内容与服务端版本一致')).toBeInTheDocument();
  expect(localStorage.getItem('buwei:draft:account-1:project-1:material-1')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '版本历史' }));
  const dialog = screen.getByRole('dialog', { name: '材料版本历史' });
  expect(await within(dialog).findByLabelText('预览 旧版.pdf')).toHaveAttribute('data-file-id', 'old-file');
  expect(within(dialog).queryByLabelText('预览 新版.pdf')).toBeNull();
});

it('preserves task-file draft recovery alongside its original preview', async () => {
  const key = 'buwei:draft:account-1:project-1:material-1';
  const draftDoc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '任务文件未同步说明' }] }] };
  localStorage.setItem(key, JSON.stringify({ savedAt: '2026-10-01', value: { doc: draftDoc, baseRevision: 1, needsReconnectConfirmation: false } }));
  const client = renderMaterial();
  act(() => client.setQueryData(['material', 'project-1', 'material-1'], { materialId: 'material-1', title: '任务成果', kind: 'task-file', canEdit: true, revision: 1, currentVersion: { versionId: 'current', revision: 1, createdAt: '2026-10-01', doc: { type: 'doc', content: [] }, attachments: [{ fileId: 'current-file', name: '成果.pdf' }] } }));
  fireEvent.click(await screen.findByRole('button', { name: '恢复草稿' }));
  await waitFor(() => expect(screen.getByLabelText('材料正文编辑器')).toHaveTextContent('任务文件未同步说明'));
  expect(screen.getByLabelText('预览 成果.pdf')).toHaveAttribute('data-file-id', 'current-file');
  expect(screen.getByRole('button', { name: '保存新版本' })).toBeEnabled();
  expect(JSON.parse(localStorage.getItem(key)!).value.doc).toEqual(draftDoc);
});

it('opens history from the top toolbar and pages one immutable snapshot at a time', async () => {
  const client = renderMaterial(); act(() => seedHistory(client));
  await screen.findByLabelText('材料正文编辑器');
  const button = screen.getByRole('button', { name: '版本历史' });
  expect(button.closest('.tm-editor-actions')).not.toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(button);
  const dialog = screen.getByRole('dialog', { name: '材料版本历史' });
  await waitFor(() => expect(within(dialog).getByLabelText('选择材料版本')).toHaveValue('v0'));
  expect(within(dialog).getByText('快照正文 0')).toBeVisible();
  expect(dialog.querySelectorAll('.tm-document-preview')).toHaveLength(1);
  const pager = within(dialog).getByRole('navigation', { name: '版本历史分页' });
  expect(within(pager).getByRole('button', { name: '上一页' })).toBeDisabled();
  fireEvent.click(within(pager).getByRole('button', { name: '下一页' }));
  expect(within(dialog).getByText('第 2 / 11 页')).toBeVisible();
  expect(within(dialog).getByText('快照正文 1')).toBeVisible();
  expect(within(dialog).queryByText('快照正文 0')).toBeNull();
  fireEvent.change(within(dialog).getByLabelText('选择材料版本'), { target: { value: 'v10' } });
  expect(within(pager).getByRole('button', { name: '下一页' })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(button);
  expect(screen.getByLabelText('选择材料版本')).toHaveValue('v10');
  expect(screen.getByLabelText('材料正文编辑器')).not.toHaveTextContent('快照正文');
});

it('a requested historical version automatically opens the snapshot dialog on its own page', async () => {
  const client = renderMaterial({ materialId: 'material-1', versionId: 'v6' });
  act(() => seedHistory(client));
  const dialog = await screen.findByRole('dialog', { name: '材料版本历史' });
  expect(within(dialog).getByLabelText('选择材料版本')).toHaveValue('v6');
  expect(within(dialog).getByText('第 7 / 11 页')).toBeVisible();
  expect(within(dialog).getByText('快照正文 6')).toBeVisible();
});

it('keeps the selected snapshot pinned when a newer version arrives', async () => {
  const client = renderMaterial(); let versions: ReturnType<typeof seedHistory> = [];
  act(() => { versions = seedHistory(client, 2); });
  fireEvent.click(await screen.findByRole('button', { name: '版本历史' }));
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  act(() => client.setQueryData(['materialVersions', 'project-1', 'material-1'], [{ ...versions[0], versionId: 'new-version', revision: 3 }, ...versions]));
  await waitFor(() => expect(screen.getByText('第 3 / 3 页')).toBeVisible());
  expect(screen.getByLabelText('选择材料版本')).toHaveValue('v1');
});

it('handles empty and single-version history with bounded pagination', async () => {
  const client = renderMaterial();
  fireEvent.click(await screen.findByRole('button', { name: '版本历史' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('保存正文后会生成新的不可变版本。');
  expect(screen.queryByRole('navigation', { name: '版本历史分页' })).toBeNull();
  act(() => seedHistory(client, 1));
  await waitFor(() => expect(screen.getByLabelText('选择材料版本')).toHaveValue('v0'));
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
});

it('opens discussion from the top, paginates five comments, and preserves unsent text when closed', async () => {
  const client = renderMaterial();
  act(() => client.setQueryData(['comments', 'project-1', 'material', 'material-1'], Array.from({ length: 11 }, (_, i) => ({ commentId: `c${i}`, authorName: '成员', body: `讨论条目 ${i}`, createdAt: '2026-10-02T00:00:00Z' }))));
  const button = await screen.findByRole('button', { name: '讨论' });
  expect(button.closest('.tm-editor-actions')).not.toBeNull(); fireEvent.click(button);
  const dialog = screen.getByRole('dialog', { name: '材料讨论' });
  expect(dialog.querySelector('details')).toBeNull();
  expect(within(dialog).getAllByText(/^讨论条目/)).toHaveLength(5);
  fireEvent.change(within(dialog).getByLabelText('发表评论'), { target: { value: '尚未发送的讨论' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '下一页' }));
  expect(within(dialog).getByText('讨论条目 5')).toBeVisible();
  fireEvent.click(within(dialog).getByRole('button', { name: '下一页' }));
  expect(within(dialog).getAllByText(/^讨论条目/)).toHaveLength(1);
  expect(within(dialog).getByRole('button', { name: '下一页' })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole('button', { name: '关闭' })); fireEvent.click(button);
  expect(screen.getByLabelText('发表评论')).toHaveValue('尚未发送的讨论');
  expect(screen.getByText('3 / 3')).toBeVisible();
});

it('closes the material overlay and resets its context when changing material', async () => {
  const client = renderMaterial();
  act(() => {
    seedHistory(client, 2);
    client.setQueryData(['materials', 'project-1'], [{ materialId: 'material-1', title: '正式材料', revision: 1, updatedAt: '2026-09-30T00:00:00Z' }, { materialId: 'material-2', title: '另一材料', revision: 1, updatedAt: '2026-09-30T00:00:00Z' }]);
    client.setQueryData(['material', 'project-1', 'material-2'], { materialId: 'material-2', title: '另一材料', revision: 1, currentVersion: null });
    client.setQueryData(['materialVersions', 'project-1', 'material-2'], []);
    client.setQueryData(['comments', 'project-1', 'material', 'material-2'], []);
  });
  fireEvent.click(await screen.findByRole('button', { name: '版本历史' }));
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  fireEvent.click(screen.getByRole('button', { name: /另一材料/ }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '版本历史' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('保存正文后会生成新的不可变版本。');
});

it('keeps the shared heading, AI assistance and export dropdown inside the editor card', async () => {
  const print = vi.spyOn(window, 'print').mockImplementation(() => {});
  renderMaterial({ embedded: true, header: <header><h2>工作区资料标题</h2></header> });
  await screen.findByLabelText('材料正文编辑器');
  const card = screen.getByRole('heading', { name: '工作区资料标题' }).closest('.tm-editor-card')! as HTMLElement;
  expect(within(card).getByRole('button', { name: '打开 AI 协助' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: '正式材料' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Markdown' })).toBeNull();
  fireEvent.click(within(card).getByRole('button', { name: /^导出文件/ }));
  expect(screen.getByRole('button', { name: 'Markdown' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '打印 / PDF' }));
  await waitFor(() => expect(print).toHaveBeenCalledOnce());
  expect(within(card).getByRole('button', { name: '保存新版本' })).toBeInTheDocument();
  print.mockRestore();
});
