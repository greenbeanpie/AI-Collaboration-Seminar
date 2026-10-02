import { Navigate, useLocation, useParams } from 'react-router-dom';

/** Keeps old record IDs, fragments and query parameters when opening the unified workspaces. */
export function ProjectRouteRedirect({ destination, defaults = {} }: { destination: string; defaults?: Record<string, string> }) {
  const location = useLocation();
  const route = useParams();
  const params = new URLSearchParams(location.search);
  for (const [key, value] of Object.entries(defaults)) if (!params.has(key)) params.set(key, value);
  if (route.taskId) params.set('task', route.taskId);
  if (route.sourceId) { params.set('resourceType', 'source'); params.set('resourceId', route.sourceId); params.delete('mode'); }
  if (route.materialId) { params.set('resourceType', 'material'); params.set('resourceId', route.materialId); }
  if (route.reviewId || route.rehearsalId) params.set('assessmentId', route.reviewId ?? route.rehearsalId!);
  if (destination === 'data' && location.hash.startsWith('#source-')) { const sourceId = location.hash.startsWith('#source-page-') ? location.hash.slice(13).replace(/-\d+$/, '') : location.hash.slice(8); params.set('resourceType', 'source'); params.set('resourceId', sourceId); }
  if (destination === 'data' && (params.has('sourceVersionId') || params.has('resourceId'))) params.delete('mode');
  return <Navigate replace to={{ pathname: `/app/projects/${encodeURIComponent(route.projectId ?? '')}/${destination}`, search: params.size ? `?${params}` : '', hash: location.hash }} />;
}
