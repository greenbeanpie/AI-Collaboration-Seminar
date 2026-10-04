import { ApiError, api, apiUrl, projectPath, request } from '../api/client';
import { createIntentKey } from './source-workflows';

export const creationFileExtensions = '.pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.mp3,.wav,.m4a,.mp4,.webm';
export const creationFileLimit = 10;

export type CreationPayload = {
  name: string;
  description: string;
  deadlineDate?: string;
  deadlinePrecision: 'date' | 'unknown';
  aiCollaborationEnabled: boolean;
  planningMode?: 'manual' | 'automatic';
  assignmentMode?: 'manual' | 'automatic';
  evaluationMode?: 'manual' | 'automatic';
  progressionMode?: 'manual' | 'automatic';
};
export type CreationFile = {
  localId: string;
  name: string;
  size: number;
  lastModified: number;
  initKey: string;
  sourceKey: string;
  sha256?: string;
  fileId?: string;
  uploadAttempted: boolean;
  uploadConfirmed: boolean;
  sourceId?: string;
  sourceVersionId?: string;
  status: 'pending' | 'uploading' | 'linking' | 'complete' | 'failed' | 'needs_file';
  error?: string;
};
export type CreationDraft = {
  version: 1;
  userId: string;
  createKey: string;
  payload: CreationPayload;
  createAttempted: boolean;
  project: { id: string; name: string; revision: number; status: 'active' | 'archived' } | null;
  files: CreationFile[];
  interrupted: boolean;
};

const storageKey = (userId: string) => `ai-office:v1:${encodeURIComponent(userId)}:project-creation`;

export function newCreationFile(file: File): CreationFile {
  return { localId: createIntentKey(), name: file.name, size: file.size, lastModified: file.lastModified,
    initKey: createIntentKey(), sourceKey: createIntentKey(), uploadAttempted: false, uploadConfirmed: false, status: 'pending' };
}

export function validateCreationFiles(files: readonly Pick<File, 'name' | 'size'>[], maxFileBytes: number): string | null {
  if (files.length > creationFileLimit) return `最多选择 ${creationFileLimit} 个文件。`;
  if (!Number.isFinite(maxFileBytes) || maxFileBytes <= 0) return '文件大小限制尚未确认，请先重新读取后端能力。';
  for (const file of files) {
    const dot = file.name.lastIndexOf('.');
    const extension = dot > 0 ? file.name.slice(dot).toLowerCase() : '';
    if (!creationFileExtensions.split(',').includes(extension)) return `不支持「${file.name}」的文件类型。`;
    if (file.name.length > 255) return '文件名不能超过 255 个字符。';
    if (file.size === 0) return `「${file.name}」为空文件，请重新选择。`;
    const limit=['.mp3','.wav','.m4a','.mp4','.webm'].includes(extension)?50*1024*1024:maxFileBytes;
    if (file.size > limit) return `「${file.name}」超过单文件 ${(limit / (1024 * 1024)).toFixed(1)} MiB 上限。`;
  }
  return null;
}

/** This tab retains only intent/record metadata, never the original file bytes. */
export function writeCreationDraft(draft: CreationDraft): boolean {
  try {
    const files = draft.files.map(({ localId, name, size, lastModified, initKey, sourceKey, sha256, fileId, uploadAttempted, uploadConfirmed, sourceId, sourceVersionId, status, error }) =>
      ({ localId, name, size, lastModified, initKey, sourceKey, sha256, fileId, uploadAttempted, uploadConfirmed, sourceId, sourceVersionId, status, error }));
    sessionStorage.setItem(storageKey(draft.userId), JSON.stringify({ ...draft, files }));
    return true;
  } catch { return false; }
}

export function clearCreationDraft(userId: string): void {
  try { sessionStorage.removeItem(storageKey(userId)); } catch { /* The API remains authoritative. */ }
}

export function readCreationDraft(userId: string): CreationDraft | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(userId)) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const draft = value as CreationDraft;
    if (draft.version !== 1 || draft.userId !== userId || typeof draft.createKey !== 'string' ||
      typeof draft.payload?.name !== 'string' || typeof draft.payload.description !== 'string' ||
      !['date', 'unknown'].includes(draft.payload.deadlinePrecision) || typeof draft.payload.aiCollaborationEnabled !== 'boolean' ||
      !Array.isArray(draft.files) || draft.files.length > creationFileLimit ||
      !draft.files.every(file => typeof file.localId === 'string' && typeof file.name === 'string' &&
        Number.isFinite(file.size) && typeof file.initKey === 'string' && typeof file.sourceKey === 'string' &&
        typeof file.uploadAttempted === 'boolean' && typeof file.uploadConfirmed === 'boolean' &&
        (!file.uploadConfirmed || typeof file.fileId === 'string') && (!file.sourceId || typeof file.sourceVersionId === 'string')) ||
      (draft.project && (typeof draft.project.id !== 'string' || typeof draft.project.name !== 'string' || !Number.isInteger(draft.project.revision)))) return null;
    return { ...draft, interrupted: true, files: draft.files.map(file => ({ ...file,
      status: file.sourceId ? 'complete' : file.uploadConfirmed ? 'pending' : 'needs_file',
      error: file.sourceId ? undefined : file.uploadConfirmed ? '原文件已确认上传，可重试建立来源，无需重新选择。' : '刷新后原文件不在浏览器内存中，请重新选择同一文件。',
    })) };
  } catch { return null; }
}

async function fileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(new Error('无法读取原文件。'));
    reader.onerror = () => reject(new Error('无法读取原文件。'));
    reader.readAsArrayBuffer(file);
  });
}

export async function creationFileHash(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('浏览器无法校验原文件，请使用 HTTPS 或本地开发地址。');
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(await fileBytes(file)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function contentType(fileName: string): string {
  const extension = fileName.toLowerCase().split('.').pop();
  return ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain', md: 'text/markdown' } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream';
}

/** Only reconcile the exact private file ID returned for this project. A 404 is not success. */
async function verifyStoredOriginal(projectId: string, fileId: string, original: File): Promise<boolean> {
  const response = await fetch(apiUrl(projectPath(projectId, `/files/${encodeURIComponent(fileId)}/content`)), {
    credentials: 'include', cache: 'no-store', headers: { 'X-Request-Id': createIntentKey() },
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`无法核对已上传原文件（HTTP ${response.status}），请稍后重试。`);
  const length = Number(response.headers.get('content-length'));
  if (length && length !== original.size) throw new Error('已存储内容与所选原文件大小不同，已停止，未建立来源。');
  const stored = new Uint8Array(await response.arrayBuffer());
  const local = new Uint8Array(await fileBytes(original));
  if (stored.length !== local.length || stored.some((byte, index) => byte !== local[index])) {
    throw new Error('已存储内容与所选原文件不同，已停止，未建立来源。');
  }
  return true;
}

export async function completeCreationFile(
  projectId: string,
  initial: CreationFile,
  original: File | undefined,
  onProgress: (file: CreationFile) => void,
  stopped: () => boolean,
): Promise<CreationFile> {
  let file = { ...initial };
  const update = (changes: Partial<CreationFile>) => { file = { ...file, ...changes }; onProgress(file); };
  if (file.sourceId) return file;
  if (!file.uploadConfirmed) {
    if (!original) throw new Error('请重新选择同一原文件，再重试未完成的上传。');
    if (original.name !== file.name || original.size !== file.size) throw new Error('所选文件与原文件名称或大小不同，请重新选择。');
    const sha256 = await creationFileHash(original);
    if (file.sha256 && sha256 !== file.sha256) throw new Error('所选文件内容已变化，请重新选择最初上传的原文件。');
    update({ sha256, status: 'uploading', error: undefined });
    if (stopped()) return file;
    if (!file.fileId) {
      const init = await api.post<'FileInitResponse'>(projectPath(projectId, '/files'), { fileName: file.name, contentType: contentType(file.name) }, { idempotencyKey: file.initKey });
      if (!init.fileId || init.upload.method !== 'PUT' || init.upload.url !== projectPath(projectId, `/files/${encodeURIComponent(init.fileId)}/content`)) {
        throw new Error('服务端返回了不符合当前项目的上传地址，已停止上传。');
      }
      update({ fileId: init.fileId });
    }
    if (stopped()) return file;
    if (file.uploadAttempted && await verifyStoredOriginal(projectId, file.fileId!, original)) update({ uploadConfirmed: true });
    if (!file.uploadConfirmed) {
      if (stopped()) return file;
      update({ uploadAttempted: true });
      try {
        const stored = await request<'FileStoredResponse'>(projectPath(projectId, `/files/${encodeURIComponent(file.fileId!)}/content`), {
          method: 'PUT', rawBody: original, headers: { 'Content-Type': contentType(file.name) },
        });
        if (stored.fileId !== file.fileId || stored.sizeBytes !== file.size || stored.sha256 !== file.sha256) throw new Error('上传响应与原文件校验不一致，已停止建立来源。');
        update({ uploadConfirmed: true });
      } catch (error) {
        // An accepted PUT whose response was lost must never allocate/upload another file.
        const uncertain = !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.code === 'INVALID_RESPONSE' || error.code === 'INVALID_STATE';
        if (!uncertain || !await verifyStoredOriginal(projectId, file.fileId!, original)) throw error;
        update({ uploadConfirmed: true });
      }
    }
  }
  if (stopped()) return file;
  update({ status: 'linking', error: undefined });
  const source = await api.post<'SourceCreateResponse'>(projectPath(projectId, '/sources'), { kind: 'file', fileId: file.fileId, title: file.name.slice(0, 200) }, { idempotencyKey: file.sourceKey });
  if (!source.sourceId || !source.sourceVersionId) throw new Error('来源响应尚未确认，请用原进度重试。');
  update({ sourceId: source.sourceId, sourceVersionId: source.sourceVersionId, status: 'complete', error: undefined });
  return file;
}
