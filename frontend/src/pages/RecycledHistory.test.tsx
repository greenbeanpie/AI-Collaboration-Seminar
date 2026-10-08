import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { DataOf } from '../api/types';
import { MaterialAttachments } from './MaterialAttachments';

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
});
