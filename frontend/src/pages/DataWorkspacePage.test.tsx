import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DataWorkspacePage } from './DataWorkspacePage';
import type { ResourceEntry } from '../api/simplification';
vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p', project: { myRole: 'owner' } }) }));
vi.mock('../auth', () => ({ useCapabilities: () => ({ data: { limits: { listMaxPageSize: 100 } } }) }));
vi.mock('./MaterialsPage', () => ({ MaterialsPage: ({ materialId, versionId, embedded, header }: { header?: ReactNode; materialId?: string; versionId?: string; embedded?: boolean }) => <div className="card">{header}<p>文档 {materialId} · 固定版本 {versionId || '当前'} · {embedded ? '详情编辑' : '完整页'}</p></div> }));
vi.mock('./SourcesPage', () => ({ SourcesPage: ({ selectedSourceId, intakeOnly, header }: { header?: ReactNode; selectedSourceId?: string; intakeOnly?: boolean }) => <div className="card">{header}<p>{intakeOnly ? '单一导入表单' : `原文详情 ${selectedSourceId}`}</p></div> }));
vi.mock('./FilePreview', () => ({ FilePreview: ({ fileId, name, availability }: { fileId: string; name: string; availability?: string }) => <section aria-label={`预览 ${name}`} data-file-id={fileId} data-availability={availability}>原文件预览</section> }));
afterEach(cleanup);
const entry = (id: string, type: 'source' | 'material', purpose: ResourceEntry['purpose'], title: string): ResourceEntry => ({ resourceId: id, resourceType: type, purpose, title, currentVersionId: `v-${id}`, revision: 1, lifecycleVersion: 1, deletedAt: null, fileId: null, canManage: true, createdAt: '2026-10-01', updatedAt: '2026-10-01' });
function show(url = '/data', files: Array<{ fileId: string; name: string; status: string; canManage: boolean }> = []) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['collaboration-tasks', 'p'], { items: [] });
  client.setQueryData(['files', 'p', 'active'], files);
  client.setQueryData(['resource-library', 'p'], [entry('background', 'material', 'background', '研究背景'), entry('source', 'source', 'reference', '原文通知'), entry('result', 'material', 'output', '最终方案')]);
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><DataWorkspacePage /></MemoryRouter></QueryClientProvider>);
}

it('uses the original file preview for an uploaded public file and preserves archive controls', () => {
  show('/data?mode=file&fileId=public-file', [{ fileId: 'public-file', name: '公共文件.pdf', status: 'available', canManage: true }]);
  expect(screen.getByLabelText('预览 公共文件.pdf')).toHaveAttribute('data-file-id', 'public-file');
  expect(screen.getByRole('button', { name: '归档文件' })).toBeInTheDocument();
});

it('marks pending public files unavailable instead of attempting their preview', () => {
  show('/data?mode=file&fileId=pending-file', [{ fileId: 'pending-file', name: '上传中.pdf', status: 'pending', canManage: true }]);
  expect(screen.getByLabelText('预览 上传中.pdf')).toHaveAttribute('data-availability', 'unavailable');
  expect(screen.queryByRole('button', { name: '归档文件' })).toBeNull();
});
it('searches background, imported references and outputs in one list with one embedded detail', async () => {
  show();
  const list = screen.getByRole('complementary', { name: '项目资料列表' });
  expect(within(list).getAllByRole('button').filter(button => button.classList.contains('resource-list-entry'))).toHaveLength(3);
  fireEvent.change(screen.getByLabelText('搜索资料'), { target: { value: '最终' } });
  expect(within(list).getByRole('button', { name: /最终方案/ })).toBeInTheDocument();
  expect(within(list).queryByRole('button', { name: /研究背景/ })).toBeNull();
  fireEvent.click(within(list).getByRole('button', { name: /最终方案/ }));
  expect(await screen.findByText('文档 result · 固定版本 当前 · 详情编辑')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '导入资料' }));
  expect(screen.getByText('单一导入表单')).toBeInTheDocument();
});
it('keeps a material and historical version deep link in the single detail pane', async () => {
  show('/data?resourceType=material&resourceId=result&materialVersionId=old-version');
  expect(await screen.findByText('文档 result · 固定版本 old-version · 详情编辑')).toBeInTheDocument();
  expect(screen.queryByText(/完整页/)).toBeNull();
});
it('locates source hashes even when the referenced version is older than the current version', () => {
  show('/data?sourceVersionId=old-source#source-page-source-3');
  expect(screen.getByText('原文详情 source')).toBeInTheDocument();
});

it('places create and import in the browser sidebar and the shared heading inside the detail card', async () => {
  show();
  const list = screen.getByRole('complementary', { name: '项目资料列表' });
  expect(within(list).getByRole('heading', { name: '资料浏览' })).toBeInTheDocument();
  expect(within(list).getByRole('button', { name: '新建文档' })).toBeInTheDocument();
  expect(within(list).getByRole('button', { name: '导入资料' })).toBeInTheDocument();
  const heading = await screen.findByRole('heading', { name: '研究背景' });
  expect(heading.closest('.card')).toContainElement(screen.getByLabelText('修改资料用途'));
  fireEvent.click(within(list).getByRole('button', { name: /原文通知/ }));
  expect(await screen.findByRole('heading', { name: '原文通知' })).toBeInTheDocument();
});
