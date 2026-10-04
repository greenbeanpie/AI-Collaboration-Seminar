import type { CollaborationTask } from '../api/collaboration';
import { useTaskAgentEligibility } from './useTaskAgentEligibility';
import { TaskAgentEligibilityNotice } from './TaskAgentEligibilityNotice';

export function TaskAgentAction({ projectId, task, onHandoff }: { projectId: string; task: CollaborationTask; onHandoff: () => void }) {
  const eligibility = useTaskAgentEligibility(projectId, task);
  const reasonId = `agent-ineligible-${task.taskId}`;
  return <>
    <button className="button button-quiet button-small" disabled={!eligibility.eligible} aria-describedby={eligibility.reason ? reasonId : undefined} onClick={() => { if (eligibility.eligible) onHandoff(); }}>交给本地 Agent</button>
    <TaskAgentEligibilityNotice eligibility={eligibility} reasonId={reasonId} />
  </>;
}
