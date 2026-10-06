import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api, projectPath } from '../../api/client';
import { listAllProjectItems } from '../../pages/source-workflows';
import type { SourceVersion } from './types';

export function useSourceQueries(projectId: string, selectedSourceId?: string, targetSourceVersionId?: string | null) {
  const capabilityQuery = useQuery({ queryKey: ['capabilities'], queryFn: () => api.get<'CapabilitiesResponse'>('/api/v1/capabilities') });
  const capability = capabilityQuery.data;
  const sourceQuery = useQuery({
    queryKey: ['sources', projectId],
    queryFn: ({ signal }) => listAllProjectItems<'SourceListResponse'>(projectId, '/sources', capability!.limits.listMaxPageSize, signal, { deleted: false }),
    enabled: Boolean(capability),
  });
  const sources = useMemo(() => sourceQuery.data ?? [], [sourceQuery.data]);
  const versionQueries = useQueries({ queries: sources.filter((source) => source.currentVersionId).map((source) => ({
    queryKey: ['sourceVersion', projectId, source.sourceId, source.sourceId === selectedSourceId && targetSourceVersionId ? targetSourceVersionId : source.currentVersionId],
    queryFn: () => api.get<'SourceVersionResponse'>(projectPath(projectId, `/sources/${encodeURIComponent(source.sourceId)}/versions/${encodeURIComponent(source.sourceId === selectedSourceId && targetSourceVersionId ? targetSourceVersionId : source.currentVersionId!)}`)),
    enabled: Boolean(source.currentVersionId),
  })) });
  const versionsBySourceId = useMemo(() => {
    const map = new Map<string, SourceVersion>();
    sources.filter((source) => source.currentVersionId).forEach((source, index) => {
      const version = versionQueries[index]?.data;
      if (version) map.set(source.sourceId, version);
    });
    return map;
  }, [sources, versionQueries]);

  return { capabilityQuery, capability, sourceQuery, sources, versionQueries, versionsBySourceId };
}
