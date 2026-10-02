import { api, request, type RequestOptions } from './client';
import type { DataOf } from './types';
import type { WizardDraft, WizardGoal, WizardPayload, WizardTask } from '../pages/project-wizard';
import { completeIntent, idempotencyKeyForIntent } from '../pages/aiWorkflowSupport';
import { creationFileHash } from '../pages/project-creation-workflow';

export type TemplateMaterial = { key: string; title: string; markdown: string; purpose: 'background' | 'reference' | 'output' };
export type TemplateRequirement = { key: string; title: string; detail: string; category: 'deadline' | 'deliverable' | 'format' | 'scoring' | 'team' | 'other'; dueDate?: string | null; duePrecision?: 'date' | 'datetime' | 'unknown'; dimensionKey?: string };
export type TemplateStandard = { title: string; requirements: TemplateRequirement[]; weights: { key: string; label: string; weight: number }[]; notes?: string | null };
export type TemplateWorkspace = { templateId: 'blank'; materials: TemplateMaterial[]; standards: TemplateStandard | null };
export type TemplatePayload = WizardPayload & { workspace?: TemplateWorkspace };
export type TemplateDraft = Omit<WizardDraft, 'payload'> & { payload: TemplatePayload };
export type TemplateTask = WizardTask & { key: string; dependsOn: string[] };
export type ProjectTemplate = { templateId: 'blank'; name: string; description: string };
async function templateRequest<T>(path: string, options: RequestOptions = {}): Promise<T> { return await request<'CreationDraftResponse'>(path, options) as unknown as T; }
export const templateDraftPath = (draftId: string, tail = '') => `/api/v1/creation-drafts/${encodeURIComponent(draftId)}${tail}`;
export function isTemplatePayload(payload: unknown): payload is TemplatePayload & { workspace: TemplateWorkspace } {
  if (!payload || typeof payload !== 'object' || !('workspace' in payload)) return false;
  const workspace = payload.workspace;
  return Boolean(workspace && typeof workspace === 'object' && 'templateId' in workspace && workspace.templateId === 'blank');
}
export const projectTemplateApi = {
  catalog: (signal?: AbortSignal) => templateRequest<{ items: ProjectTemplate[] }>('/api/v1/project-templates', { signal }),
  create: async (userId: string, signal?: AbortSignal) => { const body = { templateId: 'blank' }; const namespace = `blank-template:${userId}`; const idempotencyKey = await idempotencyKeyForIntent(namespace, body); const result = await templateRequest<TemplateDraft>('/api/v1/creation-drafts/from-template', { method: 'POST', body, idempotencyKey, signal }); completeIntent(namespace); return result; },
  get: (draftId: string, signal?: AbortSignal) => templateRequest<TemplateDraft>(templateDraftPath(draftId), { signal }),
  save: (draftId: string, expectedRevision: number, payload: TemplatePayload) => templateRequest<TemplateDraft>(templateDraftPath(draftId), { method: 'PATCH', body: { expectedRevision, payload } }),
  preview: (draftId: string, expectedRevision: number, goal: WizardGoal, tasks: TemplateTask[]) => api.post<'CreationDraftResponse'>(templateDraftPath(draftId, '/preview'), { expectedRevision, mode: 'manual', goal, tasks, regenerate: true }) as Promise<TemplateDraft>,
  commit: async (draftId: string, expectedRevision: number): Promise<DataOf<'CreationCommitResponse'>> => { const body = { expectedRevision, confirmed: true }; const namespace = `template-commit:${draftId}`; const idempotencyKey = await idempotencyKeyForIntent(namespace, body); const result = await api.post<'CreationCommitResponse'>(templateDraftPath(draftId, '/commit'), body, { idempotencyKey }); completeIntent(namespace); return result; },
  state: (draftId: string, expectedRevision: number, status: 'active' | 'cancelled') => api.post<'CreationDraftResponse'>(templateDraftPath(draftId, '/state'), { expectedRevision, status }) as Promise<TemplateDraft>,
  upload: async (userId: string, draftId: string, expectedRevision: number, file: File, signal?: AbortSignal) => {
    const sha256 = await creationFileHash(file);
    const identity = { name: file.name, size: file.size, sha256 };
    const namespace = `template-upload:${userId}:${draftId}:${sha256}:${encodeURIComponent(file.name)}`;
    const fileId = await idempotencyKeyForIntent(namespace, identity);
    try {
      const result = await templateRequest<TemplateDraft>(templateDraftPath(draftId, `/files/${fileId}`), { method: 'PUT', query: { expectedRevision, name: file.name }, rawBody: file, signal });
      if (!result.files.some(item => item.id === fileId && item.name === file.name && item.sizeBytes === file.size && item.sha256 === sha256)) throw new Error('上传响应与原文件校验不一致，已保留草稿，请重新核对。');
      completeIntent(namespace); return result;
    } catch (reason) {
      if (signal?.aborted) throw reason;
      try {
        const latest = await templateRequest<TemplateDraft>(templateDraftPath(draftId), { signal });
        if (latest.files.some(item => item.id === fileId && item.name === file.name && item.sizeBytes === file.size && item.sha256 === sha256)) { completeIntent(namespace); return latest; }
      } catch { /* Retain the exact file intent for an explicit retry when reconciliation is unavailable. */ }
      throw reason;
    }
  },
  fileState: (draftId: string, expectedRevision: number, fileId: string, removed: boolean) => api.post<'CreationDraftResponse'>(templateDraftPath(draftId, `/files/${encodeURIComponent(fileId)}/state`), { expectedRevision, removed }) as Promise<TemplateDraft>,
};
