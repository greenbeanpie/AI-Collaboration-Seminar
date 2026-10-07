import { afterEach, expect, it, vi } from 'vitest';
import { collaborationApi } from './collaboration';
afterEach(() => vi.unstubAllGlobals());
it.each(['tasks', 'proposals'] as const)('loads one collaboration %s page and follows the cursor only when requested', async (kind) => {
  const count = kind === 'tasks' ? 205 : 107;
  const rows = Array.from({ length: count }, (_, index) => ({ id: `${kind}-${index}` }));
  const fetchMock = vi.fn(async (url: string) => {
    const parsed = new URL(url, 'http://localhost');
    const start = Number(parsed.searchParams.get('cursor') ?? 0);
    const limit = 37;
    return new Response(JSON.stringify({ data: { items: rows.slice(start, start + limit), nextCursor: start + limit < count ? String(start + limit) : null }, requestId: 'paging' }), { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const result = await collaborationApi[kind]('p1');
  expect(result.items).toEqual(rows.slice(0, 37));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const cursor = (result as { nextCursor?: string | null }).nextCursor;
  const next = kind === 'tasks' ? await collaborationApi.tasks('p1', { cursor }) : await collaborationApi.proposals('p1', cursor);
  expect(next.items).toEqual(rows.slice(37, 74));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.every(([url]) => url.includes(kind === 'tasks' ? '/projects/p1/tasks?' : '/collaboration/proposals?'))).toBe(true);
});
it('rejects a truncated collaboration list without a cursor contract', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { items: [] }, requestId: 'paging' }), { headers: { 'Content-Type': 'application/json' } })));
  await expect(collaborationApi.tasks('p1')).rejects.toThrow();
});
