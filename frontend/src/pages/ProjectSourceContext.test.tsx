import { webcrypto } from 'node:crypto';
import { useCallback, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectSourceContext } from './ProjectSourceContext';
import type { DataOf } from '../api/types';

const response = (data: unknown) => Response.json({ data, requestId: 'fixture' });
type Source = DataOf<'SourceListResponse'>['items'][number];
type Version = DataOf<'SourceVersionResponse'>;
function sources(projectId: string, count = 6): Source[] {
  return Array.from({ length: count }, (_, index) => ({ sourceId: `${projectId}-s${index}`, currentVersionId: `${projectId}-v${index}`, title: `${projectId}资料${index}`, kind: 'file', createdAt: '2026-10-01T00:00:00Z', lifecycleVersion: 1, canDelete: true, deletedAt: null, fileId: `${projectId}-f${index}` }));
}
function version(source: Source, ready = false): Version {
  return { sourceVersionId: source.currentVersionId!, sourceId: source.sourceId, revision: 1, origin: 'file', fileId: `${source.sourceId}-file`, status: ready ? 'ready' : 'pending', parseError: null, pageCount: 1, charCount: ready ? 100 : null,
    pages: [{ pageNumber: 1, textStatus: ready ? 'extracted' : 'none', imageStatus: 'none', ocrStatus: 'none', needsReview: false }] };
}
function processing(textStatus: DataOf<'SourceProcessingResponse'>['textStatus']): DataOf<'SourceProcessingResponse'> {
  return { textStatus, requirementsStatus: textStatus === 'ready' ? 'ready' : 'pending', requirementsError: null, summaryStatus: 'pending', summary: null, summaryError: null, summaryJobId: null, summaryRevision: 0, coveredChars: null, totalChars: null };
}
function SelectionState({ projectId, enabled }: { projectId: string; enabled: boolean }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [readiness, setReadiness] = useState<Record<string, boolean>>({});
  const select = useCallback((id: string, checked: boolean) => setSelected(values => checked ? values.includes(id) || values.length >= 5 ? values : [...values, id] : values.filter(value => value !== id)), []);
  const ready = useCallback((id: string, value: boolean) => setReadiness(values => values[id] === value ? values : { ...values, [id]: value }), []);
  return <>
    <ProjectSourceContext projectId={projectId} enabled={enabled} selected={selected} onSelection={select} onReady={ready} />
    <output data-testid="selected-versions">{JSON.stringify(selected)}</output>
    <output data-testid="version-readiness">{JSON.stringify(readiness)}</output>
    <button disabled={selected.some(id => readiness[id] !== true)}>测试拆解入口</button>
  </>;
}
// Match the workspace's keyed project boundary, so selection/readiness cannot migrate across projects.
function Harness({ projectId, enabled }: { projectId: string; enabled: boolean }) { return <SelectionState key={projectId} projectId={projectId} enabled={enabled} />; }
function seed(client: QueryClient, projectId: string, items: Source[], versions?: Version[]) {
  client.setQueryData(['project-assistant-sources', projectId], items);
  items.filter(source => source.currentVersionId).forEach((source, index) => {
    const body = versions?.[index] ?? version(source);
    client.setQueryData(['project-assistant-source-version', projectId, source.sourceId, source.currentVersionId], body);
    client.setQueryData(['project-assistant-source-processing', projectId, source.sourceId, source.currentVersionId], processing(body.charCount && body.pages.every(page => page.textStatus !== 'none' || page.ocrStatus === 'ok') ? 'ready' : 'pending'));
  });
}
function setup({ projectId = 'p', enabled = true, items = sources(projectId), versions }: { projectId?: string; enabled?: boolean; items?: Source[]; versions?: Version[] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  seed(client, projectId, items, versions);
  const tree = (id: string, flag: boolean) => <QueryClientProvider client={client}><MemoryRouter><Harness projectId={id} enabled={flag} /></MemoryRouter></QueryClientProvider>;
  const view = render(tree(projectId, enabled));
  return { client, view, rerender: (id: string, flag = enabled) => view.rerender(tree(id, flag)) };
}
function selectedIds() { return JSON.parse(screen.getByTestId('selected-versions').textContent ?? '[]') as string[]; }
function row(title: string) { return screen.getByRole('checkbox', { name: `使用来源：${title}` }).closest('article')!; }
beforeEach(() => { sessionStorage.clear(); vi.stubGlobal('crypto', webcrypto); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe('grounded project source selection', () => {
  it('removes recycled versions from the project AI selection without starting new processing', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const items = sources('p', 2);
    const { client } = setup({ items });
    await waitFor(() => expect(selectedIds()).toEqual(['p-v0', 'p-v1']));
    await act(async () => { client.setQueryData(['project-assistant-sources', 'p'], [items[1]]); });
    await waitFor(() => expect(selectedIds()).toEqual(['p-v1']));
    expect(screen.queryByRole('checkbox', { name: '使用来源：p资料0' })).not.toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('version-readiness').textContent ?? '{}')['p-v0']).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('automatically selects at most five immutable source versions but never parses or spends on render', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const items = [...sources('p'), { ...sources('p', 1)[0], sourceId: 'no-version', currentVersionId: null, title: '尚无版本' }];
    setup({ items });
    await waitFor(() => expect(selectedIds()).toEqual(['p-v0', 'p-v1', 'p-v2', 'p-v3', 'p-v4']));
    expect(screen.getByRole('checkbox', { name: '使用来源：p资料5' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: '使用来源：尚无版本' })).toBeDisabled();
    expect(screen.getAllByText('等待正文处理')).toHaveLength(7);
    expect(screen.getByRole('button', { name: '测试拆解入口' })).toBeDisabled();
    expect(screen.getByText(/读取可能使用现有 AI 模型/)).toHaveTextContent('受项目预算');
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: '查看原文件、缺页处理与文件总结' })).toHaveAttribute('href', '/app/projects/p/sources');
  });

  it('permits changing the five-source selection without initiating any read or parse', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); setup();
    await waitFor(() => expect(selectedIds()).toHaveLength(5));
    fireEvent.click(screen.getByRole('checkbox', { name: '使用来源：p资料0' }));
    expect(screen.getByRole('checkbox', { name: '使用来源：p资料5' })).toBeEnabled();
    fireEvent.click(screen.getByRole('checkbox', { name: '使用来源：p资料5' }));
    expect(selectedIds()).toEqual(['p-v1', 'p-v2', 'p-v3', 'p-v4', 'p-v5']); expect(fetch).not.toHaveBeenCalled();
  });

  it('gates intentional parsing with the project/owner-enabled capability and does not auto-start after enabling', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const { rerender } = setup({ items: sources('p', 1), enabled: false });
    const parse = screen.getByRole('button', { name: '读取资料正文' }); expect(parse).toBeDisabled(); fireEvent.click(parse); expect(fetch).not.toHaveBeenCalled();
    rerender('p', true); expect(screen.getByRole('button', { name: '读取资料正文' })).toBeEnabled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('reuses the parse intent after a lost response and refreshes readiness only from job/body responses', async () => {
    const item = sources('stable', 1)[0]; let parseAttempts = 0; let readyBody = false;
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/parse') && init?.method === 'POST') {
        parseAttempts += 1; if (parseAttempts === 1) throw new TypeError('lost parse response');
        return response({ jobId: 'source-job', status: 'queued' });
      }
      if (path === '/api/v1/jobs/source-job') { readyBody = true; return response({ jobId: 'source-job', status: 'succeeded', result: {} }); }
      if (path.endsWith('/processing')) return response(processing(readyBody ? 'ready' : 'pending'));
      if (path.includes('/versions/')) return response(version(item, readyBody));
      throw new Error(`Unexpected fixture route ${path}`);
    });
    vi.stubGlobal('fetch', fetch); setup({ projectId: 'stable', items: [item] });
    expect(screen.getByRole('button', { name: '测试拆解入口' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '读取资料正文' })); await screen.findByText(/暂时无法连接服务/);
    expect(screen.queryByText('正文已就绪')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '读取资料正文' }));
    await screen.findByText('正文已就绪'); await waitFor(() => expect(screen.getByRole('button', { name: '测试拆解入口' })).toBeEnabled());
    const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST'); expect(posts).toHaveLength(2);
    expect(posts.every(([url]) => String(url) === `/api/v1/projects/stable/sources/${item.sourceId}/parse`)).toBe(true);
    expect(posts[0][1]?.body).toBe(posts[1][1]?.body); expect(JSON.parse(String(posts[0][1]?.body))).toEqual({ sourceVersionId: item.currentVersionId });
    expect(new Headers(posts[0][1]?.headers).get('Idempotency-Key')).toBeTruthy();
    expect(new Headers(posts[0][1]?.headers).get('Idempotency-Key')).toBe(new Headers(posts[1][1]?.headers).get('Idempotency-Key'));
    expect(fetch.mock.calls.some(([url]) => String(url) === '/api/v1/jobs/source-job')).toBe(true);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/versions/'))).toBe(true);
  });

  it('does not fabricate ready body after a failed parse or while pages are still missing', async () => {
    const item = sources('failed', 1)[0]; const incomplete = { ...version(item), status: 'failed' as const, parseError: '仍需补充扫描页', charCount: 100,
      pages: [{ pageNumber: 1, textStatus: 'none' as const, imageStatus: 'uploaded' as const, ocrStatus: 'failed' as const, needsReview: true }] };
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ jobId: 'failed-job', status: 'queued' });
      if (String(url).includes('/jobs/')) return response({ jobId: 'failed-job', status: 'failed', result: null });
      if (String(url).endsWith('/processing')) return response(processing('failed'));
      return response(incomplete);
    });
    vi.stubGlobal('fetch', fetch); setup({ projectId: 'failed', items: [item], versions: [incomplete] });
    expect(screen.getByText(/选择此来源会阻止拆解/)).toBeInTheDocument(); expect(screen.getByText(/仍需补充扫描页/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '读取资料正文' })); await screen.findByText(/资料读取未完成/);
    expect(screen.queryByText('正文已就绪')).toBeNull(); expect(screen.getByRole('button', { name: '测试拆解入口' })).toBeDisabled();
    const readiness = JSON.parse(screen.getByTestId('version-readiness').textContent ?? '{}'); expect(readiness['failed-v0']).toBe(false);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('blocks incomplete pages even when some characters exist, and permits complete fixed text without reparsing', async () => {
    const items = sources('pages', 2); const pending = { ...version(items[0], true), pages: [
      { pageNumber: 1, textStatus: 'extracted' as const, imageStatus: 'none' as const, ocrStatus: 'none' as const, needsReview: false },
      { pageNumber: 2, textStatus: 'none' as const, imageStatus: 'uploaded' as const, ocrStatus: 'pending' as const, needsReview: true },
    ] };
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); setup({ projectId: 'pages', items, versions: [pending, version(items[1], true)] });
    await waitFor(() => expect(selectedIds()).toHaveLength(2));
    expect(within(row(items[0].title)).getByText('等待正文处理')).toBeInTheDocument(); expect(within(row(items[1].title)).getByText('正文已就绪')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试拆解入口' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: `使用来源：${items[0].title}` }));
    expect(screen.getByRole('button', { name: '测试拆解入口' })).toBeEnabled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('reinitializes selection and readiness at the keyed project boundary without retaining old IDs', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const { client, rerender } = setup({ projectId: 'first', items: sources('first', 2) });
    await waitFor(() => expect(selectedIds()).toEqual(['first-v0', 'first-v1'])); fireEvent.click(screen.getByRole('checkbox', { name: '使用来源：first资料0' }));
    seed(client, 'second', sources('second', 2), sources('second', 2).map(item => version(item, true)));
    await act(async () => rerender('second'));
    await waitFor(() => expect(selectedIds()).toEqual(['second-v0', 'second-v1']));
    expect(screen.getByTestId('version-readiness')).not.toHaveTextContent('first'); expect(screen.queryByRole('checkbox', { name: '使用来源：first资料1' })).toBeNull();
    expect(screen.getByRole('button', { name: '测试拆解入口' })).toBeEnabled(); expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/app/projects/second/sources');
  });
  it('blocks a failed independent text stage despite retained complete version characters', async () => {
    const item = sources('stale', 1)[0]; const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { client } = setup({ projectId: 'stale', items: [item], versions: [version(item, true)] });
    await waitFor(() => expect(screen.getByRole('button', { name: '测试拆解入口' })).toBeEnabled());
    act(() => { client.setQueryData(['project-assistant-source-processing', 'stale', item.sourceId, item.currentVersionId], processing('failed')); });
    await waitFor(() => expect(screen.getByRole('button', { name: '测试拆解入口' })).toBeDisabled());
    expect(screen.queryByText('正文已就绪')).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['running', 'waiting_input'] as const)('recovers server-side %s processing without starting another parse', async status => {
    const item = sources('recovered', 1)[0];
    const current = { ...version(item), processingJob: { jobId: 'recovered-job', status, phase: 'extract' as const } };
    const fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/jobs/')) return response({ jobId: 'recovered-job', status, result: null });
      if (String(url).endsWith('/processing')) return response(processing(status === 'waiting_input' ? 'waiting_input' : 'processing'));
      return response(current);
    });
    vi.stubGlobal('fetch', fetch); setup({ projectId: 'recovered', items: [item], versions: [current] });
    const button = screen.getByRole('button', { name: status === 'waiting_input' ? '请到来源页面补齐缺页' : '资料处理进行中…' });
    expect(button).toBeDisabled(); fireEvent.click(button);
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url) === '/api/v1/jobs/recovered-job')).toBe(true));
    expect(fetch.mock.calls.every(([url]) => !String(url).endsWith('/parse'))).toBe(true);
    expect(screen.getByRole('button', { name: '测试拆解入口' })).toBeDisabled();
  });

});
