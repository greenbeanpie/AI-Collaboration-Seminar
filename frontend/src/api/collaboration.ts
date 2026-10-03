import { api, listAllItems, projectPath } from './client';
import type { DataOf, SchemaName } from './types';
import { idempotencyKeyForIntent, completeIntent } from '../pages/aiWorkflowSupport';
import { projectRequest } from './simplification';

export type CollaborationSettingsData = DataOf<'CollaborationSettingsResponse'> & { planningMode?: 'manual' | 'automatic'; progressionMode?: 'manual' | 'automatic' };
export type CollaborationMode = CollaborationSettingsData['assignmentMode'];
export type TaskSummary = DataOf<'CollaborationTaskSummaryResponse'>;
export type CollaborationTask = DataOf<'CollaborationTaskResponse'> & Pick<DataOf<'TaskResponse'>, 'dependsOnTaskIds' | 'unfinishedDependencyIds' | 'status'>;
export type LifecycleState = CollaborationTask['lifecycleState'];
export type TaskSubmission = DataOf<'CollaborationSubmissionResponse'>;
export type SubmissionDecision = NonNullable<TaskSubmission['decision']>;
export type CollaborationProposal = DataOf<'CollaborationProposalListResponse'>['items'][number];
const path = (id: string, suffix: string) => projectPath(id, `/collaboration${suffix}`);
// These calls share the standard API envelope, errors, credentials and idempotency handling.
async function get<Name extends SchemaName>(projectId: string, suffix: string) { return api.get<Name>(path(projectId, suffix)); }
async function post<Name extends SchemaName>(projectId: string, suffix: string, body: unknown) {
  const namespace = `collaboration:${projectId}:${suffix}`;
  const key = await idempotencyKeyForIntent(namespace, body);
  const result = await api.post<Name>(path(projectId, suffix), body, { idempotencyKey: key });
  completeIntent(namespace);
  return result;
}
export const collaborationApi = {
  settings: (id: string) => get<'CollaborationSettingsResponse'>(id, '/settings') as Promise<CollaborationSettingsData>,
  saveSettings: async (id: string, body: Partial<Omit<CollaborationSettingsData, 'revision'>> & { expectedRevision: number }) => api.patch<'CollaborationSettingsResponse'>(path(id, '/settings'), body) as Promise<CollaborationSettingsData>,
  tasks: async (id: string) => ({ items: await listAllItems<'CollaborationTaskListResponse'>(projectPath(id, '/tasks'), { limit: 100 }, { requireNextCursor: true }) as CollaborationTask[] }),
  summary: (id: string, taskId: string, retry = false) => projectRequest<TaskSummary>(id, `/collaboration/tasks/${encodeURIComponent(taskId)}/summary`, { method: 'POST', body: retry ? { retry: true } : {} }),
  createTask: (id: string, body: { title: string; detail: string; criteria: string; effortHours: number; dependsOnTaskIds: string[]; expectedGraphRevision: number; dueDate?: string | null; assigneeId?: string | null }) => taskPost<CollaborationTask>(id, '/tasks', body),
  updateTask: (id: string, task: CollaborationTask, fields: { title: string; detail: string; criteria: string; effortHours: number }) => projectRequest<CollaborationTask>(id, `/tasks/${encodeURIComponent(task.taskId)}`, { method: 'PATCH', body: { expectedRevision: task.revision, ...fields } }),
  claim: (id: string, task: CollaborationTask) => taskPost<CollaborationTask>(id, `/tasks/${encodeURIComponent(task.taskId)}/claim`, { expectedRevision: task.revision }),
  assign: (id: string, task: CollaborationTask, assigneeId: string | null, reason: string) => taskPost<CollaborationTask>(id, `/tasks/${encodeURIComponent(task.taskId)}/assign`, { expectedRevision: task.revision, assigneeId, reason }),
  submissions: (id: string, taskId: string) => projectRequest<DataOf<'CollaborationSubmissionListResponse'>>(id, `/tasks/${encodeURIComponent(taskId)}/submissions`),
  submit: (id: string, task: CollaborationTask, body: string, materialVersionIds: string[]) => taskPost<TaskSubmission>(id, `/tasks/${encodeURIComponent(task.taskId)}/submissions`, { expectedRevision: task.revision, body, materialVersionIds }),
  decide: (id: string, submission: TaskSubmission, decision: SubmissionDecision, feedback: string) => post<'CollaborationSubmissionResponse'>(id, `/submissions/${encodeURIComponent(submission.submissionId)}/decide`, { expectedRevision: submission.revision, decision, feedback }),
  decompose: (id: string, brief: string, sourceVersionIds?: string[], search?:{allowSearch:boolean;searchQuery:string}, materialVersionIds?: string[]) => post<'CollaborationJobResponse'>(id, '/decompose', { brief, ...(search?.allowSearch?search:{}), ...(sourceVersionIds?.length ? { sourceVersionIds } : {}), ...(materialVersionIds?.length ? { materialVersionIds } : {}) }),
  adjustTasks: (id: string, brief: string, taskIds: string[], sourceVersionIds?: string[], search?:{allowSearch:boolean;searchQuery:string}, materialVersionIds?: string[]) => post<'CollaborationJobResponse'>(id, '/decompose', { brief, ...(search?.allowSearch?search:{}), taskIds, ...(sourceVersionIds?.length ? { sourceVersionIds } : {}), ...(materialVersionIds?.length ? { materialVersionIds } : {}) }),
  overrideScores: (id: string, submission: TaskSubmission, scores: Array<{ key: string; score: number }>, reason: string) => post<'CollaborationSubmissionResponse'>(id, `/submissions/${encodeURIComponent(submission.submissionId)}/scores`, { expectedRevision: submission.revision, scores, reason }),
  suggestAssignments: (id: string, taskIds: string[]) => post<'CollaborationJobResponse'>(id, '/assign', { taskIds }),
  proposals: async (id: string) => ({ items: await listAllItems<'CollaborationProposalListResponse'>(path(id, '/proposals'), { limit: 100 }, { requireNextCursor: true }) }),
  apply: (id: string, proposal: CollaborationProposal) => post<'CollaborationApplyResponse'>(id, `/proposals/${encodeURIComponent(proposal.proposalId)}/apply`, { expectedRevision: proposal.revision }),
};
async function taskPost<T>(id: string, tail: string, body: unknown): Promise<T> {
  const namespace = `project-task:${id}:${tail}`;
  const idempotencyKey = await idempotencyKeyForIntent(namespace, body);
  const result = await projectRequest<T>(id, tail, { method: 'POST', body, idempotencyKey });
  completeIntent(namespace);
  return result;
}
