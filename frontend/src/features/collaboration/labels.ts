import type { CollaborationTask } from '../../api/collaboration';
export const lifecycleLabels = { open: '待认领', in_progress: '进行中', submitted: '待验收', accepted: '已通过', improve: '需改进', rework: '需重做' };
export const decisionLabels = { accept: '通过', improve: '改进', rework: '重做' };
export const taskStateLabel = (task: CollaborationTask) => task.pendingHumanReview ? '已完成（待人工审核）' : task.lifecycleState === 'accepted' && !task.currentSubmissionId ? '历史已完成' : lifecycleLabels[task.lifecycleState];
export type FeedbackSnapshot = {versionId:string|null;version:number;feedback:string;actorId:string|null;createdAt:string|null};
