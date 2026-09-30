import { ApiError, api, apiUrl, projectPath, request } from '../api/client';

export type TrackedSourceJob = {
  jobId: string;
  sourceId: string;
  sourceVersionId: string;
  sourceTitle: string;
  fileId: string | null;
  status?: 'queued' | 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'cancelled';
};

export type PageRenderLimits = { pageImageMaxEdge: number; pageImageMaxBytes: number; maxPdfPages: number };

const jobsStorageKey = (projectId: string) => `ai-office:v1:${projectId}:source-jobs`;
const filesStorageKey = (projectId: string) => `ai-office:v1:${projectId}:source-files`;

export function createIntentKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function readTrackedSourceJobs(projectId: string): TrackedSourceJob[] {
  try {
    const value = sessionStorage.getItem(jobsStorageKey(projectId));
    const parsed: unknown = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.filter(isTrackedSourceJob) : [];
  } catch {
    return [];
  }
}

export function writeTrackedSourceJobs(projectId: string, jobs: TrackedSourceJob[]): void {
  try {
    const minimal = jobs.map(({ jobId, sourceId, sourceVersionId, sourceTitle, fileId, status }) => ({ jobId, sourceId, sourceVersionId, sourceTitle, fileId, status }));
    sessionStorage.setItem(jobsStorageKey(projectId), JSON.stringify(minimal));
  } catch {
    // Session storage is only a convenience for this tab; the API remains authoritative.
  }
}

export function sourceFileId(projectId: string, sourceVersionId: string): string | null {
  try {
    const value = sessionStorage.getItem(filesStorageKey(projectId));
    const parsed: unknown = value ? JSON.parse(value) : {};
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = (parsed as Record<string, unknown>)[sourceVersionId];
    return typeof candidate === 'string' ? candidate : null;
  } catch {
    return null;
  }
}

export function rememberSourceFile(projectId: string, sourceVersionId: string, fileId: string): void {
  try {
    const value = sessionStorage.getItem(filesStorageKey(projectId));
    const parsed: unknown = value ? JSON.parse(value) : {};
    const files = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    files[sourceVersionId] = fileId;
    sessionStorage.setItem(filesStorageKey(projectId), JSON.stringify(files));
  } catch {
    // A source can still be used when the browser cannot retain this optional association.
  }
}

function contentTypeFor(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.toLowerCase().split('.').pop();
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'md') return 'text/markdown';
  if (extension === 'txt') return 'text/plain';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return 'application/octet-stream';
}

export async function uploadProjectFile(
  projectId: string,
  file: File,
  initIntentKey: string = createIntentKey(),
): Promise<string> {
  const init = await api.post<'FileInitResponse'>(projectPath(projectId, '/files'), {
    fileName: file.name,
    contentType: contentTypeFor(file),
  }, { idempotencyKey: initIntentKey });
  await request<'FileStoredResponse'>(init.upload.url, {
    method: 'PUT',
    rawBody: file,
    headers: { 'Content-Type': contentTypeFor(file) },
  });
  return init.fileId;
}

export async function downloadSourcePdf(projectId: string, fileId: string): Promise<Uint8Array> {
  const requestId = createIntentKey();
  const response = await fetch(apiUrl(projectPath(projectId, `/files/${encodeURIComponent(fileId)}/content`)), {
    credentials: 'include',
    headers: { 'X-Request-Id': requestId },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const failure = payload && typeof payload === 'object' ? payload as { error?: { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> }; requestId?: string } : null;
    throw new ApiError(response.status, {
      error: {
        code: failure?.error?.code ?? `HTTP_${response.status}`,
        message: failure?.error?.message ?? '无法读取已上传的来源 PDF。',
        retryable: failure?.error?.retryable ?? response.status >= 500,
        details: failure?.error?.details,
      },
      requestId: failure?.requestId ?? requestId,
    });
  }
  return new Uint8Array(await response.arrayBuffer());
}

function isTrackedSourceJob(value: unknown): value is TrackedSourceJob {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<TrackedSourceJob>;
  return typeof item.jobId === 'string' && typeof item.sourceId === 'string' && typeof item.sourceVersionId === 'string' && typeof item.sourceTitle === 'string';
}
