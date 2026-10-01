import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SourceRecord } from './SourcesPage';
import type { DataOf } from '../api/types';

vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p' }) }));
vi.mock('./SourceFullText', () => ({ SourceFullText: () => null }));
vi.mock('../api/client', async (original) => ({ ...await original<typeof import('../api/client')>(), api: { get: vi.fn().mockResolvedValue({ jobId: 'j', status: 'waiting_input', result: { needsImages: 1 } }) } }));
afterEach(cleanup);

function record(status: 'queued' | 'running' | 'waiting_input') {
  const onParse = vi.fn();
  render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SourceRecord
    source={{ sourceId: 's', currentVersionId: 'v', kind: 'file', title: '文本 PDF', createdAt: new Date().toISOString() }}
    version={{ sourceVersionId: 'v', sourceId: 's', revision: 1, origin: 'file', fileId: 'f', status: 'processing', parseError: null, pageCount: 4, charCount: 242, pages: [] }}
    projectId="p" highlighted={false} highlightedPageNumber={null}
    jobs={[{ jobId: 'j', sourceId: 's', sourceVersionId: 'v', sourceTitle: '文本 PDF', fileId: 'f', status }]}
    capability={{ features: { aiEnabled: true } } as DataOf<'CapabilitiesResponse'>}
    parsingSourceId={null} scanJobId={null} scanProgress="" onParse={onParse}
    onRetryJob={vi.fn()} onScan={vi.fn()} onJobUpdate={vi.fn()}
  /></QueryClientProvider></MemoryRouter>);
  return onParse;
}

describe('source text-layer retry', () => {
  it('offers an explicit retry for existing PDF with a visible AI usage notice; never retries automatically', () => {
    const onParse = record('waiting_input');
    expect(onParse).not.toHaveBeenCalled();
    expect(screen.getByText(/无需重复上传.*可能产生 AI 用量/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新读取文本层并提取要求' }));
    expect(onParse).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 's' }), 'v');
  });
  it.each(['queued', 'running'] as const)('keeps the parse action disabled while a task is %s', (status) => {
    record(status);
    expect(screen.getByRole('button', { name: '已有任务处理中' })).toBeDisabled();
  });
});
