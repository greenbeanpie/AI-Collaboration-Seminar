import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceFullText } from './SourceFullText';
import { api } from '../api/client';
vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p' }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const fragment = (id: string) => ({ fragmentId: id, seq: 1, content: `原文 ${id}`, kind: 'text', pageNumber: null });
const show = (entry = '/data') => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[entry]}><SourceFullText sourceId="s" sourceVersionId="v" /></MemoryRouter></QueryClientProvider>);
it('fetches bounded fragment pages and searches on the server', async () => {
  const read = vi.spyOn(api, 'get').mockImplementation((async (_path: string, query?: { cursor?: string; q?: string }) => ({ items: [fragment(query?.q ? 'match' : query?.cursor ? 'second' : 'first')], nextCursor: query?.cursor || query?.q ? null : 'next' })) as typeof api.get);
  show(); fireEvent.click(screen.getByText('查看全文片段与引用定位'));
  await screen.findByText('原文 first'); expect(read).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '加载更多来源全文' })); await screen.findByText('原文 second');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '匹配' } }); await screen.findByText('原文 match');
  expect(read.mock.calls.at(-1)?.[1]).toMatchObject({ q: '匹配', cursor: null, limit: 50 });
});
it('retrieves and displays a linked fragment beyond the first page without fetching every page', async () => {
  const read = vi.spyOn(api, 'get').mockImplementation((async (_path: string, query?: { fragmentId?: string }) => ({ items: [fragment(query?.fragmentId ?? 'first')], nextCursor: query?.fragmentId ? null : 'more' })) as typeof api.get);
  Element.prototype.scrollIntoView = vi.fn();
  show('/data?sourceVersionId=v&fragmentId=target');
  await screen.findByText('原文 target'); await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(read.mock.calls.some(([, query]) => query?.fragmentId === 'target' && query.limit === 1)).toBe(true);
});
