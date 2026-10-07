import { useMemo, useState, useDeferredValue } from 'react';
import { useInfiniteQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api, ApiError, type RequestOptions } from '../../api/client';
import type { DataOf, SchemaName } from '../../api/types';

type Item<Name extends SchemaName> = DataOf<Name> extends { items: (infer Value)[] } ? Value : never;
type PagedOptions = { queryKey: QueryKey; path: string; query?: RequestOptions['query']; enabled?: boolean; staleTime?: number; searchable?: boolean };
export function usePagedItems<Name extends SchemaName>(options: PagedOptions) {
  return usePagedRecords<Item<Name>>(options);
}
/** A list fetches one bounded page; callers explicitly request additional pages. */
export function usePagedRecords<Value>({ queryKey, path, query, enabled = true, staleTime, searchable = false }: PagedOptions) {
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const client = useQueryClient();
  const pageKey = [...queryKey, 'pages', query ?? {}, deferredSearch];
  const result = useInfiniteQuery({
    queryKey: pageKey,
    enabled, ...(staleTime !== undefined ? { staleTime } : {}),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const response = await api.get<'ProjectListResponse'>(path, { ...query, limit: 50, cursor: pageParam, ...(searchable ? { q: deferredSearch } : {}) }, signal);
      const page = response as unknown as { items: Value[]; nextCursor?: string | null };
      const previous = client.getQueryData<{ pages: { nextCursor?: string | null }[] }>(pageKey);
      const precedingIndex = pageParam ? previous?.pages.findIndex(previousPage => previousPage.nextCursor === pageParam) ?? -1 : -1;
      const repeatsEarlierPage = Boolean(page.nextCursor && precedingIndex >= 0 && previous?.pages.slice(0, precedingIndex + 1).some(previousPage => previousPage.nextCursor === page.nextCursor));
      if (!Array.isArray(page.items) || repeatsEarlierPage || page.nextCursor && page.nextCursor === pageParam) throw new ApiError(502, { requestId: '', error: { code: 'INVALID_PAGINATION', message: '列表分页响应无效，请重试。', retryable: true } });
      return page;
    },
    getNextPageParam: page => page.nextCursor || undefined,
  });
  const data = useMemo(() => {
    if (!result.data) return undefined;
    const seen = new Set<string>();
    return result.data.pages.flatMap(page => page.items).filter(item => {
      if (!item || typeof item !== 'object') return true;
      const record = item as Record<string, unknown>;
      const idKey = ['id', 'taskId', 'sourceId', 'fileId', 'userId', 'versionId', 'materialId', 'proposalId', 'assessmentId', 'reviewId', 'rehearsalId', 'sessionId', 'fragmentId'].find(key => typeof record[key] === 'string');
      if (!idKey) return true;
      const key = `${idKey}:${record[idKey]}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }, [result.data]);
  return { ...result, data, ...(searchable ? { search, setSearch } : {}) };
}
