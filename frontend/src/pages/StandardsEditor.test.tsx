import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { StandardsEditor } from './StandardsEditor';
import type { StandardVersion } from '../api/simplification';
vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p', project: { myRole: 'owner' } }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });
const version: StandardVersion = { standardsVersionId: 's', projectId: 'p', version: 1, title: '统一标准', status: 'confirmed', revision: 1, requirementSetIds: ['r-set'], rubricVersionId: 'rubric', mappings: [], requirements: [{ requirementId: 'r', requirementSetId: 'r-set', title: '提供来源', detail: '所有外部内容可追溯', category: 'other', dueDate: null, duePrecision: 'unknown', citations: [] }], rubric: { rubricVersionId: 'rubric', version: 1, weights: [{ key: 'official_quality', label: '官方质量维度', weight: 70 }], notes: '已保存的官方规则' }, confirmedAt: '2026-10-01', createdAt: '2026-10-01' };
function show(items: StandardVersion[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } } });
  client.setQueryData(['standards', 'p'], { items }); client.setQueryData(['requirementSets', 'p'], []);
  render(<QueryClientProvider client={client}><MemoryRouter><StandardsEditor /></MemoryRouter></QueryClientProvider>);
}
it('preserves unmapped existing rubric dimensions in the same editor while keeping internal keys hidden', () => {
  show([version]);
  fireEvent.click(screen.getByRole('button', { name: '基于此版本修订' }));
  expect(screen.getByLabelText('要求 1 标题')).toHaveValue('提供来源');
  expect(screen.getByLabelText('评分维度名称')).toHaveValue('官方质量维度');
  expect(screen.getByLabelText('评分权重（%）')).toHaveValue(70);
  expect(screen.queryByLabelText('评分维度标识')).toBeNull();
});
it('saves pure checklist requirements with dates without inventing a numeric dimension', async () => {
  const writes: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_path: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') writes.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ data: init?.method === 'POST' ? { ...version, status: 'draft', rubric: { ...version.rubric, weights: [] } } : { items: [] }, requestId: 'standards' }), { headers: { 'Content-Type': 'application/json' } });
  }));
  show(); fireEvent.click(screen.getByRole('button', { name: '新建标准' }));
  fireEvent.change(screen.getByLabelText('要求 1 标题'), { target: { value: '按时提交 PDF' } });
  fireEvent.change(screen.getByLabelText('要求截止日期'), { target: { value: '2026-11-01' } });
  fireEvent.click(screen.getByRole('button', { name: '保存标准草稿' }));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({ requirements: [{ title: '按时提交 PDF', dueDate: '2026-11-01', duePrecision: 'date' }], weights: [] });
});
it('loads AI output into an editable draft and saves mapped and independent dimensions without publishing', async () => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const generated = { title: 'AI 标准草稿', notes: '建议评分', requirements: [{ title: '可操作原型', detail: '完整交付', category: 'deliverable', dimensionKey: 'quality', dueDate: null, duePrecision: 'unknown' }], weights: [{ key: 'quality', label: '质量', weight: 80 }, { key: 'format', label: '格式', weight: 20 }] };
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') writes.push({ path, body: JSON.parse(String(init.body)) });
    const data = path.endsWith('/standards/generate') ? { jobId: 'job' }
      : path.endsWith('/jobs/job') ? { jobId: 'job', status: 'succeeded', result: { draft: generated } }
      : init?.method === 'POST' ? { ...version, status: 'draft' } : { items: [] };
    return new Response(JSON.stringify({ data, requestId: 'fixture' }), { headers: { 'Content-Type': 'application/json' } });
  }));
  show([version]);
  fireEvent.click(screen.getByRole('button', { name: 'AI 生成标准' }));
  await waitFor(() => expect(screen.getByLabelText('标准名称')).toHaveValue('AI 标准草稿'));
  expect(screen.getAllByLabelText('评分权重（%）').map(input => (input as HTMLInputElement).value)).toEqual(['80', '20']);
  expect(writes).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('要求 1 标题'), { target: { value: '修订后的可操作原型' } });
  fireEvent.click(screen.getByRole('button', { name: '保存标准草稿' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1].body).toMatchObject({ requirements: [{ title: '修订后的可操作原型', dimensionKey: 'quality' }], weights: generated.weights });
  expect(writes.some(write => write.path.endsWith('/confirm'))).toBe(false);
});
it('keeps existing standards visible and blocks editing them while generation runs', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => new Response(JSON.stringify({ data: String(input).endsWith('/standards/generate') ? { jobId: 'job' } : { jobId: 'job', status: 'running' }, requestId: 'fixture' }), { headers: { 'Content-Type': 'application/json' } })));
  show([version]);
  fireEvent.click(screen.getByRole('button', { name: 'AI 生成标准' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '基于此版本修订' })).toBeDisabled());
  expect(screen.getByText('提供来源', { exact: true })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '新建标准' })).toBeDisabled();
});
