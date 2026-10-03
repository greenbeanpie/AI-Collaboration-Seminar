import { api, projectPath } from './client';
import type { WizardDraft } from '../pages/project-wizard';
import type { DataOf } from './types';

export type ClarificationAnswer = { text: string } | { option: string } | { undecided: true };
export type AiClarification = NonNullable<DataOf<'CreationDraftResponse'>['clarification']>;
export type ProjectClarification = AiClarification & { jobId: string };
export type ClarificationJobResult = DataOf<'ProjectAiClarificationActionResponse'>;
const draftPath = (draftId: string, questionId: string, action: 'answer' | 'cancel') => `/api/v1/creation-drafts/${encodeURIComponent(draftId)}/clarifications/${encodeURIComponent(questionId)}/${action}`;
const questionPath = (questionId: string, action: 'answer' | 'cancel') => `/ai/clarifications/${encodeURIComponent(questionId)}/${action}`;
export const clarificationApi = {
  answerDraft: (draftId: string, question: AiClarification, answer: ClarificationAnswer) => api.post<'CreationDraftResponse'>(draftPath(draftId, question.id, 'answer'), { expectedRevision: question.revision, ...answer }) as Promise<WizardDraft>,
  cancelDraft: (draftId: string, question: AiClarification) => api.post<'CreationDraftResponse'>(draftPath(draftId, question.id, 'cancel'), { expectedRevision: question.revision }) as Promise<WizardDraft>,
  list: async (projectId: string, signal?: AbortSignal): Promise<{ items: ProjectClarification[] }> => {
    const result = await api.get<'ProjectAiClarificationsResponse'>(projectPath(projectId, '/ai/clarifications'), undefined, signal);
    return { items: result.items.filter((question): question is ProjectClarification => typeof question.jobId === 'string') };
  },
  answerProject: (projectId: string, question: AiClarification, answer: ClarificationAnswer) => api.post<'ProjectAiClarificationActionResponse'>(projectPath(projectId, questionPath(question.id, 'answer')), { expectedRevision: question.revision, ...answer }),
  cancelProject: (projectId: string, question: AiClarification) => api.post<'ProjectAiClarificationActionResponse'>(projectPath(projectId, questionPath(question.id, 'cancel')), { expectedRevision: question.revision }),
};

/** Job results are untyped JSON; only present a usable persisted pending question. */
export function clarificationFromJob(result: unknown, jobId: string): ProjectClarification | null {
  if (!result || typeof result !== 'object' || !('clarification' in result)) return null;
  const value = result.clarification;
  if (!value || typeof value !== 'object') return null;
  const question = value as Partial<AiClarification>;
  if (typeof question.id !== 'string' || typeof question.question !== 'string' || question.status !== 'pending'
    || typeof question.revision !== 'number' || typeof question.round !== 'number' || question.maxRounds !== 3
    || typeof question.allowUndecided !== 'boolean' || typeof question.createdAt !== 'string'
    || (question.reason !== undefined && typeof question.reason !== 'string')
    || !Array.isArray(question.options) || !question.options.every(option => typeof option === 'string')) return null;
  return { ...question, jobId } as ProjectClarification;
}

export const clarificationQueryKey = (projectId: string) => ['ai-clarifications', projectId] as const;
