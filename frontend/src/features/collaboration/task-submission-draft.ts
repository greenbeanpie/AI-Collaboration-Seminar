export interface TaskSubmissionDraft {
  body: string;
  baseRevision: number;
  conflict: boolean;
}

interface StoredTaskSubmissionDraft extends TaskSubmissionDraft {
  version: 1;
  savedAt: string;
}

function key(accountId: string, projectId: string, taskId: string): string {
  // The account prefix also participates in clearAccountStorage's device cleanup.
  return `ai-office:account:${accountId}:task-submission:${encodeURIComponent(projectId)}:${encodeURIComponent(taskId)}`;
}

export function readTaskSubmissionDraft(accountId: string, projectId: string, taskId: string): { draft: StoredTaskSubmissionDraft | null; failed: boolean } {
  try {
    const raw = window.localStorage.getItem(key(accountId, projectId, taskId));
    if (!raw) return { draft: null, failed: false };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return { draft: null, failed: true };
    const draft = value as Partial<StoredTaskSubmissionDraft>;
    if (draft.version !== 1 || typeof draft.body !== 'string' || draft.body.length > 12000
      || !Number.isSafeInteger(draft.baseRevision) || (draft.baseRevision ?? 0) < 1
      || typeof draft.conflict !== 'boolean' || typeof draft.savedAt !== 'string' || !Number.isFinite(Date.parse(draft.savedAt))) {
      return { draft: null, failed: true };
    }
    return { draft: draft as StoredTaskSubmissionDraft, failed: false };
  } catch { return { draft: null, failed: true }; }
}

export function writeTaskSubmissionDraft(accountId: string, projectId: string, taskId: string, draft: TaskSubmissionDraft): boolean {
  if (!draft.body && !draft.conflict) return removeTaskSubmissionDraft(accountId, projectId, taskId);
  try {
    window.localStorage.setItem(key(accountId, projectId, taskId), JSON.stringify({ ...draft, version: 1, savedAt: new Date().toISOString() }));
    return true;
  } catch { return false; }
}

export function removeTaskSubmissionDraft(accountId: string, projectId: string, taskId: string, submitted?: TaskSubmissionDraft): boolean {
  try {
    if (submitted) {
      const current = readTaskSubmissionDraft(accountId, projectId, taskId);
      if (current.failed) return false;
      // A successful submission in one tab must not remove another tab's newer edit.
      if (current.draft && (current.draft.body !== submitted.body || current.draft.baseRevision !== submitted.baseRevision || current.draft.conflict !== submitted.conflict)) return true;
    }
    window.localStorage.removeItem(key(accountId, projectId, taskId));
    return true;
  } catch { return false; }
}
