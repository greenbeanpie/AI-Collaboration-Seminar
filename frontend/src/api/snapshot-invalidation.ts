import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Determine whether a TanStack Query key should be invalidated when the background
 * snapshot for `url` changes. Scopes invalidations to the affected resource/project
 * rather than broadcasting an unfiltered global refetch.
 */
export function matchesSnapshotUrl(queryKey: QueryKey, url: string): boolean {
  const path = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'https://localhost').pathname;
  const root = String(queryKey[0] ?? '');

  if (path === '/api/v1/auth/session') return root === 'session';
  if (path === '/api/v1/capabilities') return root === 'capabilities';
  if (path === '/api/v1/projects') return root === 'projects';

  const projectMatch = path.match(/^\/api\/v1\/projects\/([^/]+)(?:\/(.+))?$/);
  if (!projectMatch) return false;
  const projectId = decodeURIComponent(projectMatch[1]!);
  const tail = projectMatch[2] ?? '';

  // Never invalidate queries belonging to another project or global non-project queries.
  if (queryKey[1] !== projectId) return false;

  if (!tail) {
    return root === 'project' || root === 'collaboration-settings';
  }
  if (tail === 'goal') {
    return root === 'project-goal';
  }
  if (tail === 'collaboration/settings') {
    return root === 'collaboration-settings' || root === 'project';
  }
  if (tail === 'collaboration/feedback/current') {
    return root === 'project-feedback';
  }
  if (tail === 'collaboration/feedback/history') {
    return root === 'project-feedback-history';
  }
  if (tail.startsWith('collaboration/proposals')) {
    return root === 'collaboration-proposals';
  }
  if (tail === 'ai/clarifications') {
    return root === 'ai-clarifications' || root === 'collaboration-clarifications' || root.includes('clarification');
  }
  if (tail === 'task-inquiries/unread') {
    return root === 'task-inquiries-unread';
  }
  if (tail === 'members/me') {
    return root === 'member' || root === 'member-me';
  }
  if (tail.startsWith('members')) {
    return root === 'members' || root === 'member' || root === 'member-me';
  }
  if (tail === 'tasks/graph') {
    return root === 'task-graph' || root === 'tasks';
  }
  if (/^(?:collaboration\/)?tasks(?:\/|$)/.test(tail)) {
    const subMatch = tail.match(/^(?:collaboration\/)?tasks\/([^/]+)(?:\/(.+))?$/);
    if (subMatch?.[2] === 'submissions') {
      return root === 'collaboration-submissions' || root === 'tasks' || root === 'collaboration-tasks';
    }
    if (subMatch?.[2] === 'files') {
      return root === 'task-files';
    }
    return (
      root === 'tasks' ||
      root === 'task' ||
      root === 'task-graph' ||
      root === 'collaboration-tasks' ||
      root === 'collaboration-task'
    );
  }
  if (tail.startsWith('materials')) {
    return (
      root === 'materials' ||
      root === 'material' ||
      root === 'materialVersions' ||
      root === 'materialVersion' ||
      root === 'recordingMaterial' ||
      root === 'resource-library' ||
      root === 'resource-detail'
    );
  }
  if (tail.startsWith('sources')) {
    return (
      root === 'sources' ||
      root === 'source' ||
      root === 'sourceVersion' ||
      root === 'sourceProcessing' ||
      root === 'sourceFragments' ||
      root === 'sourceFragment' ||
      root === 'project-assistant-sources' ||
      root === 'project-assistant-source-version' ||
      root === 'project-assistant-source-processing' ||
      root === 'resource-library' ||
      root === 'resource-detail'
    );
  }
  if (tail.startsWith('resource-library')) {
    return root === 'resource-library' || root === 'resource-detail';
  }
  if (tail.startsWith('files')) {
    return root === 'files' || root === 'fileProcessing' || root === 'resource-library';
  }
  if (tail.startsWith('requirement-sets')) {
    return root === 'requirementSets' || root === 'standards' || root === 'current-standard';
  }
  if (tail.startsWith('standards')) {
    return root === 'standards' || root === 'current-standard';
  }
  if (tail.startsWith('comments')) {
    return root === 'comments' || root === 'task-comments';
  }
  if (tail.startsWith('recording-sessions')) {
    return root === 'recording-sessions' || root === 'recording-session' || root === 'recordingMaterial';
  }

  // Fallback for unclassified project endpoints: invalidate only queries scoped to this projectId.
  return queryKey[1] === projectId;
}

export function createSnapshotInvalidationScheduler(
  queryClient: QueryClient,
  getActiveAccountId: () => string | null | undefined,
  windowMs = 50,
) {
  const pendingUrls = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    if (!pendingUrls.size) return;
    const urls = [...pendingUrls];
    pendingUrls.clear();
    void queryClient.invalidateQueries({
      predicate: query => urls.some(url => matchesSnapshotUrl(query.queryKey, url)),
    });
  };

  return {
    schedule(detail?: { accountId?: string; url?: string }) {
      if (detail?.accountId && getActiveAccountId() && detail.accountId !== getActiveAccountId()) return;
      if (!detail?.url) return;
      pendingUrls.add(detail.url);
      clearTimeout(timer);
      timer = setTimeout(flush, windowMs);
    },
    flush,
    dispose() {
      clearTimeout(timer);
      timer = undefined;
      pendingUrls.clear();
    },
  };
}
