import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api, projectPath } from '../../api/client';
import { usePagedItems } from '../pagination/usePagedItems';
import { projectRequest } from '../../api/simplification';
import type { SourceItem } from './types';
import type { SourceVersion } from './types';

export function useSourceQueries(projectId: string, selectedSourceId?: string, targetSourceVersionId?: string | null) {
  const capabilityQuery = useQuery({ queryKey: ['capabilities'], queryFn: () => api.get<'CapabilitiesResponse'>('/api/v1/capabilities') });
  const capability = capabilityQuery.data;
  const sourceQuery = usePagedItems<'SourceListResponse'>({ queryKey: ['sources', projectId], path: projectPath(projectId, '/sources'), query: { deleted: false }, enabled: Boolean(capability), searchable: true });
  const selectedSource = useQuery({ queryKey: ['source', projectId, selectedSourceId], enabled: Boolean(selectedSourceId), queryFn: () => projectRequest<SourceItem>(projectId, `/sources/${encodeURIComponent(selectedSourceId!)}`) });
  const sources = useMemo(() => {
    const list = sourceQuery.data ?? [];
    return selectedSource.data && !list.some(source => source.sourceId === selectedSource.data.sourceId) ? [selectedSource.data, ...list] : list;
  }, [sourceQuery.data, selectedSource.data]);
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
