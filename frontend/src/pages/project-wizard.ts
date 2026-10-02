import type { DataOf } from '../api/types';
export type WizardDraft = DataOf<'CreationDraftResponse'>;
export type WizardPayload = WizardDraft['payload'];
export type WizardTask = NonNullable<WizardDraft['preview']>['tasks'][number];
export const wizardSteps = ['基本信息', '上传文件', '人数与邀请', '任务拆分预览', '创建确认'] as const;
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
