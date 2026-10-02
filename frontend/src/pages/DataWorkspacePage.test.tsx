import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DataWorkspacePage } from './DataWorkspacePage';
import type { ResourceEntry } from '../api/simplification';
vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p', project: { myRole: 'owner' } }) }));
vi.mock('../auth', () => ({ useCapabilities: () => ({ data: { limits: { listMaxPageSize: 100 } } }) }));
vi.mock('./MaterialsPage', () => ({ MaterialsPage: ({ materialId, versionId, embedded }: { materialId?: string; versionId?: string; embedded?: boolean }) => <p>文档 {materialId} · 固定版本 {versionId || '当前'} · {embedded ? '详情编辑' : '完整页'}</p> }));
vi.mock('./SourcesPage', () => ({ SourcesPage: ({ selectedSourceId, intakeOnly }: { selectedSourceId?: string; intakeOnly?: boolean }) => <p>{intakeOnly ? '单一导入表单' : `原文详情 ${selectedSourceId}`}</p> }));
afterEach(cleanup);
const entry = (id: string, type: 'source' | 'material', purpose: ResourceEntry['purpose'], title: string): ResourceEntry => ({ resourceId: id, resourceType: type, purpose, title, currentVersionId: `v-${id}`, revision: 1, lifecycleVersion: 1, deletedAt: null, fileId: null, canManage: true, createdAt: '2026-10-01', updatedAt: '2026-10-01' });
function show(url = '/data') {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(['resource-library', 'p'], [entry('background', 'material', 'background', '研究背景'), entry('source', 'source', 'reference', '原文通知'), entry('result', 'material', 'output', '最终方案')]);
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><DataWorkspacePage /></MemoryRouter></QueryClientProvider>);
}
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
