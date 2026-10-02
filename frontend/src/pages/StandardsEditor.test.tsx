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
