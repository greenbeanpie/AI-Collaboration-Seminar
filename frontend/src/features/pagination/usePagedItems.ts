import { useMemo, useState, useDeferredValue } from 'react';
import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
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
  const result = useInfiniteQuery({
    queryKey: [...queryKey, 'pages', query ?? {}, deferredSearch],
    enabled, ...(staleTime !== undefined ? { staleTime } : {}),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const response = await api.get<'ProjectListResponse'>(path, { ...query, limit: 50, cursor: pageParam, ...(searchable ? { q: deferredSearch } : {}) }, signal);
      const page = response as unknown as { items: Value[]; nextCursor?: string | null };
      if (!Array.isArray(page.items) || page.nextCursor && page.nextCursor === pageParam) throw new ApiError(502, { requestId: '', error: { code: 'INVALID_PAGINATION', message: '列表分页响应无效，请重试。', retryable: true } });
      return page;
    },
    getNextPageParam: (page, pages) => {
      const cursor = page.nextCursor;
      return cursor && !pages.slice(0, -1).some(previous => previous.nextCursor === cursor) ? cursor : undefined;
    },
  });
  const data = useMemo(() => result.data?.pages.flatMap(page => page.items), [result.data]);
  return { ...result, data, ...(searchable ? { search, setSearch } : {}) };
}
