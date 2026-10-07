import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { StandardsEditor } from './StandardsEditor';
import type { StandardVersion } from '../api/simplification';
vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p', project: { myRole: 'owner' } }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear(); });
const version: StandardVersion = { standardsVersionId: 's', projectId: 'p', version: 1, title: '统一标准', status: 'confirmed', revision: 1, requirementSetIds: ['r-set'], rubricVersionId: 'rubric', mappings: [], requirements: [{ requirementId: 'r', requirementSetId: 'r-set', title: '提供来源', detail: '所有外部内容可追溯', category: 'other', dueDate: null, duePrecision: 'unknown', citations: [] }], rubric: { rubricVersionId: 'rubric', version: 1, weights: [{ key: 'official_quality', label: '官方质量维度', weight: 70 }], notes: '已保存的官方规则' }, confirmedAt: '2026-10-01', createdAt: '2026-10-01' };
function show(items: StandardVersion[] = [], generatedJobId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } } });
  client.setQueryData(['standards', 'p'], { items }); client.setQueryData(['current-standard', 'p'], { standard: items[0] ?? null, generatedJobId }); client.setQueryData(['requirementSets', 'p'], []);
  render(<QueryClientProvider client={client}><MemoryRouter><StandardsEditor /></MemoryRouter></QueryClientProvider>);
}
it('preserves unmapped existing rubric dimensions in the same editor while keeping internal keys hidden', () => {
  show([version]);
  fireEvent.click(screen.getByRole('button', { name: '修订生效标准' }));
  expect(screen.queryByLabelText('要求 1 标题')).toBeNull();
  expect(screen.queryByLabelText('要求截止日期')).toBeNull();
  expect(screen.queryByLabelText('标准说明')).toBeNull();
  expect(screen.getByLabelText('评分维度名称')).toHaveValue('官方质量维度');
  expect(screen.getByLabelText('评分权重（%）')).toHaveValue(70);
  expect(screen.queryByLabelText('评分维度标识')).toBeNull();
});
it('places the single manual revision action in the header before the standard content', () => {
  show([version]);
  const action = screen.getByRole('button', { name: '修订生效标准' });
  expect(action.closest('.section-head')).not.toBeNull();
  expect(action.compareDocumentPosition(screen.getByText('生效标准 v1')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
it('saves only scoring dimensions without checklist fields, descriptions or dates', async () => {
  const writes: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: unknown, init?: RequestInit) => { if(init?.method==='POST')writes.push(JSON.parse(String(init.body)));return Response.json({data:init?.method==='POST'?version:String(path).endsWith('/current')?{standard:version}:{items:[version]},requestId:'r'}); }));
  show();fireEvent.click(screen.getByRole('button',{name:'新建标准'}));
  fireEvent.change(screen.getByLabelText('评分维度名称'),{target:{value:'成果质量'}});fireEvent.change(screen.getByLabelText('评分权重（%）'),{target:{value:'100'}});
  fireEvent.click(screen.getByRole('button',{name:'保存并生效'}));await waitFor(()=>expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({requirements:[{title:'成果质量',category:'scoring',detail:'',dueDate:null,citations:[]}],notes:''});
  expect(screen.queryByLabelText('要求截止日期')).toBeNull();
});
it('loads AI output into an editable draft and saves mapped and independent dimensions and activates only when saved', async () => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const generated = { title: 'AI 标准草稿', notes: '', requirements: [{ title: '质量', detail: '', category: 'scoring', dimensionKey: 'quality', dueDate: null, duePrecision: 'unknown',citations:[{sourceVersionId:'source-version',fragmentId:'fragment',pageNumber:1,quote:'质量80分',fileName:'评分方法.pdf'}] }], weights: [{ key: 'quality', label: '质量', weight: 80 }, { key: 'format', label: '格式', weight: 20 }] };
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') writes.push({ path, body: JSON.parse(String(init.body)) });
    const data = path.endsWith('/standards/generate') ? { jobId: 'job' }
      : path.endsWith('/jobs/job') ? { jobId: 'job', status: 'succeeded', result: { draft: generated,scoringOutputVersion:2 } }
      : init?.method === 'POST' ? { ...version, status: 'draft' } : { items: [] };
    return new Response(JSON.stringify({ data, requestId: 'fixture' }), { headers: { 'Content-Type': 'application/json' } });
  }));
  show([version]);
  fireEvent.click(screen.getByRole('button', { name: 'AI 生成标准' }));
  await waitFor(() => expect(screen.getByLabelText('标准名称')).toHaveValue('AI 标准草稿'));
  expect(screen.getAllByLabelText('评分权重（%）').map(input => (input as HTMLInputElement).value)).toEqual(['80', '20']);
  expect(writes).toHaveLength(1);
  expect(screen.getByText('来源引用（1 条）')).toBeInTheDocument();
  fireEvent.change(screen.getAllByLabelText('评分维度名称')[0], { target: { value: '修订质量' } });
  fireEvent.click(screen.getByRole('button', { name: '保存并生效' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].body).toMatchObject({ requirements: [{ title: '修订质量', dimensionKey: 'quality' },{title:'格式',dimensionKey:'format'}], weights: generated.weights.map(row=>row.key==='quality'?{...row,label:'修订质量'}:row) });
  expect(writes.some(write => write.path.endsWith('/confirm'))).toBe(false);
  expect((writes[1].body.requirements as Array<{citations:unknown[]}>)[0].citations).toEqual([{sourceVersionId:'source-version',fragmentId:'fragment',pageNumber:1,quote:'质量80分'}]);
});
it('keeps existing standards visible and blocks editing them while generation runs', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => new Response(JSON.stringify({ data: String(input).endsWith('/standards/generate') ? { jobId: 'job' } : { jobId: 'job', status: 'running' }, requestId: 'fixture' }), { headers: { 'Content-Type': 'application/json' } })));
  show([version]);
  fireEvent.click(screen.getByRole('button', { name: 'AI 生成标准' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '修订生效标准' })).toBeDisabled());
  expect(screen.queryByText('提供来源', { exact: true })).toBeNull();
  expect(screen.getByRole('button', { name: '新建标准' })).toBeDisabled();
});

it('shows only current metadata with read-only historical versions and no confirmation controls', () => {
  show([version, { ...version, standardsVersionId: 'old', title: '历史规则', version: 0 }]);
  expect(screen.getByText('生效标准 v1')).toBeInTheDocument();
  expect(screen.getByText('历史规则 · v0')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: '修订生效标准' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: /确认/ })).toBeNull();
  expect(screen.queryByRole('combobox', { name: /标准/ })).toBeNull();
});
it('saving a revision creates the new current standard immediately without a confirmation request', async () => {
  const next = { ...version, standardsVersionId: 'next', title: '新生效标准', version: 2 };
  let saved = false;
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'PATCH') { writes.push(path); saved = true; }
    return Response.json({ requestId: 'r', data: init?.method === 'PATCH' ? next : path.endsWith('/current') ? { standard: saved ? next : version } : { items: [next, version] } });
  }));
  show([version]);
  fireEvent.click(screen.getByRole('button', { name: '修订生效标准' }));
  fireEvent.change(screen.getByLabelText('标准名称'), { target: { value: next.title } });
  fireEvent.click(screen.getByRole('button', { name: '保存并生效' }));
  expect(await screen.findByText('生效标准 v2')).toBeInTheDocument();
  expect(writes).toEqual(['/api/v1/projects/p/standards/s']);
});

it('restores completed AI activity from the current-standard response top-level job pointer', async () => {
  const fetch = vi.fn(async () => Response.json({ data: { jobId: 'completed-standard-job', status: 'succeeded', activity: { code: 'completed', updatedAt: '2026-10-07T00:00:00Z', lastResponseAt: '2026-10-07T00:00:00Z', progress: null, canResume: false, resumeReason: null, uncertain: false } } }));
  vi.stubGlobal('fetch', fetch);
  show([version], 'completed-standard-job');
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/v1/jobs/completed-standard-job', expect.any(Object)));
  expect(await screen.findByText('已完成', { selector: 'strong' })).toBeInTheDocument();
  expect(screen.getByText(/AI 最后一次回复时间/)).toBeInTheDocument();
});
