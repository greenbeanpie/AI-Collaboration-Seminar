import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { DataOf } from '../api/types';
import { MaterialAttachments } from './MaterialAttachments';
import { RequirementsPage } from './RequirementsPage';

vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p', project: { myRole: 'owner' } }) }));
afterEach(cleanup);

function wrapper(children: React.ReactNode, client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })) {
  render(<MemoryRouter><QueryClientProvider client={client}>{children}</QueryClientProvider></MemoryRouter>);
}

describe('recycled original history', () => {
  it('keeps an unavailable material attachment name but removes its download link', () => {
    const material = { materialId: 'm', revision: 1, currentVersion: { attachments: [
      { fileId: 'removed', name: '历史原件.pdf', availability: 'unavailable', deletedAt: '2026-10-02T00:00:00Z' },
      { fileId: 'active', name: '可用原件.pdf' },
    ] } } as DataOf<'MaterialResponse'>;
    wrapper(<MaterialAttachments material={material} disabled={false} />);
    expect(screen.getByText(/历史原件.pdf.*附件历史保留/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '历史原件.pdf' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '可用原件.pdf' })).toHaveAttribute('href', '/api/v1/projects/p/files/active/content');
  });

  it('keeps requirement text and quoted evidence while hiding unavailable original links', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const set: DataOf<'RequirementSetResponse'> = { requirementSetId: 'set', sourceVersionId: 'v', sourceAvailability: 'unavailable', sourceDeletedAt: '2026-10-02T00:00:00Z', revision: 1, status: 'confirmed', confirmedAt: '2026-10-01T00:00:00Z', requirements: [{ requirementId: 'r', seq: 1, category: 'deliverable', title: '保留的确认要求', detail: '原件删除不修改已确认要求', dueDate: null, duePrecision: 'unknown', fieldState: 'confirmed', citations: [{ sourceVersionId: 'v', fragmentId: 'fragment', pageNumber: 2, quote: '请提交作品介绍和演示视频', availability: 'unavailable', deletedAt: '2026-10-02T00:00:00Z' }] }] };
    client.setQueryData(['requirementSets', 'p'], [set]);
    client.setQueryData(['requirementSet', 'p', 'set'], set);
    client.setQueryData(['rubrics', 'p'], []);
    client.setQueryData(['capabilities'], { limits: { listMaxPageSize: 100 } });
    client.setQueryData(['sources', 'p'], []);
    wrapper(<RequirementsPage />, client);
    expect(await screen.findByText('1. 保留的确认要求')).toBeInTheDocument();
    expect(screen.getByText('请提交作品介绍和演示视频')).toBeInTheDocument();
    expect(screen.getByText(/历史引文保留/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '查看来源' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '查看原始来源' })).not.toBeInTheDocument();
  });
});
