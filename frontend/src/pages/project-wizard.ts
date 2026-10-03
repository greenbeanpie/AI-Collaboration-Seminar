import type { DataOf } from '../api/types';
type ApiWizardDraft = DataOf<'CreationDraftResponse'>;
export type WizardGoal = { title: string; detail: string };
export type WizardPayload = ApiWizardDraft['payload'] & { goal?: WizardGoal };
export type WizardTask = NonNullable<ApiWizardDraft['preview']>['tasks'][number] & { key?: string; dependsOn?: string[] };
export type WizardDraft = Omit<ApiWizardDraft, 'payload' | 'preview'> & { payload: WizardPayload; preview: (Omit<NonNullable<ApiWizardDraft['preview']>, 'tasks'> & { goal?: WizardGoal; tasks: WizardTask[] }) | null };
export const wizardSteps = ['基本信息', '上传文件', '人数与邀请', '目标与任务预览', '创建确认'] as const;
export const emptyWizardPayload: WizardPayload = {
  name: '', description: '', aiCollaborationEnabled: false, teamSize: 1, inviteUsernames: [], inviteLabels: [], brief: ''
};
export function sameWizardPayload(a: WizardPayload, b: WizardPayload) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function canConfirmDraft(draft: WizardDraft) {
  return draft.status === 'active' && draft.previewState === 'ready' && draft.previewRevision === draft.revision;
}
export function confirmationIssue(latest: WizardDraft, reviewed: WizardDraft): string | null {
  if (latest.status === 'committed') return null;
  if (latest.status === 'cancelled') return '草稿已取消，配置和文件仍保留。请恢复草稿后重新确认。';
  if (latest.previewState === 'waiting_input') return 'AI 正在等待补充信息，请回答问题或取消本次 AI 操作后继续。';
  if (latest.previewState === 'running') return '任务预览仍在生成，请等待完成后重新核对。';
  if (latest.previewState === 'failed') return '任务预览失败，草稿和文件仍保留。请核对并重新保存当前任务预览。';
  if (!canConfirmDraft(latest) || !latest.preview) return '尚未保存当前配置的任务预览。请保存任务预览后重新确认。';
  if (latest.previewAttemptId !== reviewed.previewAttemptId || latest.revision !== reviewed.revision || !sameWizardPayload(latest.payload,reviewed.payload) || JSON.stringify(latest.preview) !== JSON.stringify(reviewed.preview)) return '服务端草稿的配置或任务预览已更新，请复核最新内容后重新确认创建。';
  return null;
}
export const wizardStorageKey = (userId: string) => `ai-office:creation-wizard:${encodeURIComponent(userId)}`;
