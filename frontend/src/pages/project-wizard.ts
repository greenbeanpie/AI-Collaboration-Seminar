import type { DataOf } from '../api/types';
type ApiWizardDraft = DataOf<'CreationDraftResponse'>;
export type WizardGoal = { title: string; detail: string };
export type WizardPayload = ApiWizardDraft['payload'] & { goal?: WizardGoal };
export type WizardTask = NonNullable<ApiWizardDraft['preview']>['tasks'][number] & { key?: string; dependsOn?: string[] };
export type WizardDraft = Omit<ApiWizardDraft, 'payload' | 'preview'> & { payload: WizardPayload; preview: (Omit<NonNullable<ApiWizardDraft['preview']>, 'tasks'> & { goal?: WizardGoal; tasks: WizardTask[] }) | null };
export const wizardSteps = ['基本信息', '上传文件', '人数与邀请', '目标与子任务预览', '创建确认'] as const;
export const emptyWizardPayload: WizardPayload = {
  name: '', description: '', aiCollaborationEnabled: false, teamSize: 1, inviteUsernames: [], inviteLabels: [], brief: ''
};
export function sameWizardPayload(a: WizardPayload, b: WizardPayload) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function canConfirmDraft(draft: WizardDraft) {
  return draft.status === 'active' && draft.previewState === 'ready' && draft.previewRevision === draft.revision;
}
export const wizardStorageKey = (userId: string) => `ai-office:creation-wizard:${encodeURIComponent(userId)}`;
