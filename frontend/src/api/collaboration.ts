import { api, listAllItems, projectPath } from './client';
import type { DataOf, SchemaName } from './types';
import { idempotencyKeyForIntent, completeIntent } from '../pages/aiWorkflowSupport';

export type CollaborationSettingsData = DataOf<'CollaborationSettingsResponse'>;
export type CollaborationMode = CollaborationSettingsData['assignmentMode'];
export type CollaborationTask = DataOf<'CollaborationTaskResponse'>;
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
  settings: (id: string) => get<'CollaborationSettingsResponse'>(id, '/settings'),
  saveSettings: async (id: string, body: Omit<CollaborationSettingsData, 'revision'> & { expectedRevision: number }) => api.patch<'CollaborationSettingsResponse'>(path(id, '/settings'), body),
  tasks: async (id: string) => ({ items: await listAllItems<'CollaborationTaskListResponse'>(path(id, '/tasks'), { limit: 100 }, { requireNextCursor: true }) }),
  createTask: (id: string, body: { title: string; detail: string; criteria: string; effortHours: number; parentTaskId: string | null }) => post<'CollaborationTaskResponse'>(id, '/tasks', body),
  updateTask: (id: string, task: CollaborationTask, fields: { title: string; detail: string; criteria: string; effortHours: number }) => api.patch<'CollaborationTaskResponse'>(path(id, `/tasks/${encodeURIComponent(task.taskId)}`), { expectedRevision: task.revision, ...fields }),
  claim: (id: string, task: CollaborationTask) => post<'CollaborationTaskResponse'>(id, `/tasks/${encodeURIComponent(task.taskId)}/claim`, { expectedRevision: task.revision }),
  assign: (id: string, task: CollaborationTask, assigneeId: string, reason: string) => post<'CollaborationTaskResponse'>(id, `/tasks/${encodeURIComponent(task.taskId)}/assign`, { expectedRevision: task.revision, assigneeId, reason }),
  submissions: (id: string, taskId: string) => get<'CollaborationSubmissionListResponse'>(id, `/tasks/${encodeURIComponent(taskId)}/submissions`),
  submit: (id: string, task: CollaborationTask, body: string, materialVersionIds: string[]) => post<'CollaborationSubmissionResponse'>(id, `/tasks/${encodeURIComponent(task.taskId)}/submissions`, { expectedRevision: task.revision, body, materialVersionIds }),
  decide: (id: string, submission: TaskSubmission, decision: SubmissionDecision, feedback: string) => post<'CollaborationSubmissionResponse'>(id, `/submissions/${encodeURIComponent(submission.submissionId)}/decide`, { expectedRevision: submission.revision, decision, feedback }),
  evaluate: (id: string, submissionId: string) => post<'CollaborationJobResponse'>(id, `/submissions/${encodeURIComponent(submissionId)}/evaluate`, {}),
  decompose: (id: string, brief: string) => post<'CollaborationJobResponse'>(id, '/decompose', { brief }),
  suggestAssignments: (id: string, taskIds: string[]) => post<'CollaborationJobResponse'>(id, '/assign', { taskIds }),
  proposals: async (id: string) => ({ items: await listAllItems<'CollaborationProposalListResponse'>(path(id, '/proposals'), { limit: 100 }, { requireNextCursor: true }) }),
  apply: (id: string, proposal: CollaborationProposal) => post<'CollaborationApplyResponse'>(id, `/proposals/${encodeURIComponent(proposal.proposalId)}/apply`, { expectedRevision: proposal.revision }),
};
