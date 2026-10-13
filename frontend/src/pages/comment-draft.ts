type CommentDraft = { version: 1; body: string; savedAt: string };

function key(accountId: string, projectId: string, targetType: 'task' | 'material', targetId: string): string {
  return `ai-office:account:${accountId}:comment-draft:${encodeURIComponent(projectId)}:${targetType}:${encodeURIComponent(targetId)}`;
}

export function readCommentDraft(accountId: string, projectId: string, targetType: 'task' | 'material', targetId: string): { draft: CommentDraft | null; failed: boolean } {
  try {
    const raw = localStorage.getItem(key(accountId, projectId, targetType, targetId));
    if (!raw) return { draft: null, failed: false };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return { draft: null, failed: true };
    const draft = value as Partial<CommentDraft>;
    if (draft.version !== 1 || typeof draft.body !== 'string' || draft.body.length > 4000
      || typeof draft.savedAt !== 'string' || !Number.isFinite(Date.parse(draft.savedAt))) return { draft: null, failed: true };
    return { draft: draft as CommentDraft, failed: false };
  } catch { return { draft: null, failed: true }; }
}

export function writeCommentDraft(accountId: string, projectId: string, targetType: 'task' | 'material', targetId: string, body: string): boolean {
  if (!body) return removeCommentDraft(accountId, projectId, targetType, targetId);
  try {
    localStorage.setItem(key(accountId, projectId, targetType, targetId), JSON.stringify({ version: 1, body, savedAt: new Date().toISOString() }));
    return true;
  } catch { return false; }
}

export function removeCommentDraft(accountId: string, projectId: string, targetType: 'task' | 'material', targetId: string, submitted?: string): boolean {
  try {
    if (submitted !== undefined) {
      const current = readCommentDraft(accountId, projectId, targetType, targetId);
      if (current.failed) return false;
      if (current.draft && current.draft.body !== submitted) return true;
    }
    localStorage.removeItem(key(accountId, projectId, targetType, targetId));
    return true;
  } catch { return false; }
}
