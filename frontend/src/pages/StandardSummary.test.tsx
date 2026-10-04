import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StandardSummary } from './StandardSummary';
import type { StandardVersion } from '../api/simplification';
afterEach(cleanup);
const citation = { sourceVersionId: 'sv', fragmentId: 'fragment', pageNumber: 2, quote: '不应显示的原文', sourceId: 'source', fileId: 'file', fileName: '通知原文件.pdf' };
const standard: StandardVersion = { standardsVersionId: 'standard', projectId: 'p', version: 1, title: '不应出现在正文的标准标题', status: 'confirmed', revision: 1, requirementSetIds: [], rubricVersionId: 'rubric', mappings: [{ requirementId: 'one', dimensionKey: 'quality' }, { requirementId: 'two', dimensionKey: 'format' }], requirements: [{ requirementId: 'one', requirementSetId: 'set', title: '不应显示的要求', detail: '不应显示的细节', category: 'scoring', dueDate: '2026-12-07', citations: [citation, { ...citation, fragmentId: 'second' }] }, { requirementId: 'two', requirementSetId: 'set', title: '另一个要求', detail: '', category: 'scoring', citations: [citation] }], rubric: { rubricVersionId: 'rubric', version: 1, weights: [{ key: 'quality', label: '质量', weight: 70 }, { key: 'format', label: '格式', weight: 30 }], notes: '不应显示的长说明' }, confirmedAt: null, createdAt: '2026-10-04' };
it('shows only rubric proportions and deduplicated numbered file references', () => {
  render(<MemoryRouter><StandardSummary standard={standard} projectId="p"/></MemoryRouter>);
  const panel = screen.getByRole('region', { name: '评分比例与参考资料' });
  expect(panel).toHaveTextContent('质量 · 权重 70%[1]格式 · 权重 30%[1][1] 通知原文件.pdf');
  expect(within(panel).getAllByRole('listitem')).toHaveLength(1);
  expect(panel.textContent).not.toMatch(/不应|2026-12|检查项|原文依据/);
  expect(within(panel).getByRole('link', { name: '[1] 通知原文件.pdf' })).toHaveAttribute('href', '/api/v1/projects/p/files/file/content');
  expect(panel.querySelectorAll('sup')).toHaveLength(2);
});
it('keeps unavailable references numbered without displaying status prose or fabricating a link', () => {
  const archived = { ...standard, requirements: standard.requirements.map(requirement => ({ ...requirement, citations: [{ ...citation, availability: 'unavailable' as const }] })) };
  render(<MemoryRouter><StandardSummary standard={archived} projectId="p"/></MemoryRouter>);
  expect(screen.queryByRole('link', { name: '[1] 通知原文件.pdf' })).toBeNull();
  expect(screen.getByText('[1] 通知原文件.pdf')).toHaveAttribute('title', '原始来源不可用，历史引用保留');
  expect(screen.queryByText(/不应显示/)).toBeNull();
});
it('opens the immutable cited file even when its archive state differs from the current source', () => {
  const archived = { ...standard, requirements: standard.requirements.map(requirement => ({ ...requirement, citations: [{ ...citation, archivedAt: '2026-10-04' }] })) };
  render(<MemoryRouter><StandardSummary standard={archived} projectId="p"/></MemoryRouter>);
  expect(screen.getByRole('link', { name: '[1] 通知原文件.pdf' })).toHaveAttribute('href', '/api/v1/projects/p/files/file/content');
  expect(screen.getByRole('link', { name: '[1] 通知原文件.pdf' })).toHaveAttribute('title', '归档资料，固定版本只读');
});
