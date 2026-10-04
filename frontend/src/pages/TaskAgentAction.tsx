import type { CollaborationTask } from '../api/collaboration';

export function TaskAgentAction({ onHandoff }: { projectId: string; task: CollaborationTask; onHandoff: () => void }) {
  return <button className="button button-quiet button-small" onClick={onHandoff}>AI 辅助</button>;
}
