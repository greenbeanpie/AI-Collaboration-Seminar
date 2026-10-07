import { uploadMultipartFile } from './document-import-client';
import { ApiError, responseError, api, apiUrl, projectPath, request, type RequestOptions } from '../api/client';
import type { DataOf, SchemaName } from '../api/types';
import { offlineAccount } from '../offline/store';

export type TrackedSourceJob = {
  jobId: string;
  sourceId: string;
  sourceVersionId: string;
  sourceTitle: string;
  fileId: string | null;
  status?: 'queued' | 'running' | 'waiting_input' | 'succeeded' | 'failed' | 'cancelled';
};

export type PageRenderLimits = { pageImageMaxEdge: number; pageImageMaxBytes: number; maxPdfPages: number | null };

type ItemsOf<Name extends SchemaName> = DataOf<Name> extends { items: infer Items } ? Items : never;

const maxPageCount = 200;

function paginationError(code: string, message: string): ApiError {
  return new ApiError(200, {
    error: { code, message, retryable: false },
    requestId: createIntentKey(),
  });
}

export async function listAllProjectItems<Name extends SchemaName>(
  projectId: string,
  tail: string,
  pageSize: number,
  signal?: AbortSignal,
  query: RequestOptions['query'] = {},
): Promise<ItemsOf<Name>> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw paginationError('INVALID_PAGINATION_LIMIT', '服务端返回了无效的列表分页上限。');
  }

  const all: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let pageCount = 0; pageCount < maxPageCount; pageCount += 1) {
    const page = await api.get<Name>(projectPath(projectId, tail), { ...query, limit: pageSize, cursor }, signal);
    if (!page || typeof page !== 'object') {
      throw paginationError('INVALID_PAGINATION', '服务端列表响应无法识别，已停止加载。');
    }
    const candidate = page as { items?: unknown; nextCursor?: unknown };
    if (!Array.isArray(candidate.items) || !Object.prototype.hasOwnProperty.call(candidate, 'nextCursor')) {
      throw paginationError('INVALID_PAGINATION', '服务端列表响应缺少 items 或 nextCursor，已停止加载。');
    }
    all.push(...candidate.items);

    if (candidate.nextCursor === null) return all as ItemsOf<Name>;
    if (typeof candidate.nextCursor !== 'string' || candidate.nextCursor.length === 0) {
      throw paginationError('INVALID_PAGINATION', '服务端返回了无效的分页游标，已停止加载。');
    }
    if (candidate.nextCursor === cursor || seenCursors.has(candidate.nextCursor)) {
      throw paginationError('INVALID_PAGINATION', '服务端返回了重复分页游标，已停止加载以避免重复记录。');
    }
    seenCursors.add(candidate.nextCursor);
    cursor = candidate.nextCursor;
  }

  throw paginationError('PAGINATION_LIMIT', `列表超过 ${maxPageCount} 页安全读取上限，未显示不完整结果。`);
}

const jobsStorageKey = (projectId: string) => `ai-office:source-jobs:${offlineAccount()?.id ?? 'anonymous'}:${projectId}`;
const filesStorageKey = (projectId: string) => `ai-office:source-files:${offlineAccount()?.id ?? 'anonymous'}:${projectId}`;

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
  if (extension === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (extension === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (extension === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
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
  onInitialized?: (fileId: string) => void,
  attribution?: { contributorIds?: string[]; derivedFromFileId?: string },
): Promise<string> {
  const init = await api.post<'FileInitResponse'>(projectPath(projectId, '/files'), {
    fileName: file.name,
    contentType: contentTypeFor(file),
    ...attribution,
  }, { idempotencyKey: initIntentKey });
  onInitialized?.(init.fileId);
  if (file.size > 8 * 1024 * 1024 || /\.(docx|xlsx|pptx)$/i.test(file.name)) { await uploadMultipartFile(projectId,init.fileId,file); return init.fileId; }
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
  if (!response.ok) throw await responseError(response, '无法读取已上传的来源 PDF。');
  return new Uint8Array(await response.arrayBuffer());
}

function isTrackedSourceJob(value: unknown): value is TrackedSourceJob {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<TrackedSourceJob>;
  return typeof item.jobId === 'string' && typeof item.sourceId === 'string' && typeof item.sourceVersionId === 'string' && typeof item.sourceTitle === 'string';
}
