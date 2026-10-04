import type { CollaborationTask } from '../api/collaboration';
import { useTaskAgentEligibility } from './useTaskAgentEligibility';
import { TaskAgentEligibilityNotice } from './TaskAgentEligibilityNotice';
import { useEffect, useRef } from 'react';
import { useSession } from '../auth';
import { ErrorNotice } from '../components/ui';
import { boundBridgeDevices, bridgeActive, preferredBridgeDevice, useAgentBridge, useBridgeDevices } from './useAgentBridge';

export function TaskAgentAction({ projectId, task, onHandoff }: { projectId: string; task: CollaborationTask; onHandoff: () => void }) {
  const eligibility = useTaskAgentEligibility(projectId, task);
  const session = useSession();
  const currentActor = useRef(session.data?.id);
  useEffect(() => { currentActor.current = session.data?.id; }, [session.data?.id]);
  const devices = useBridgeDevices();
  const bridge = useAgentBridge(projectId, task);
  const lock = useRef(false);
  const bound = boundBridgeDevices(devices.data?.items, projectId);
  const resumable = bridge.handoffs.data?.items.some(item => bridgeActive(item) || item.state === 'ready_for_review');
  const invalid = eligibility.readError || eligibility.loading || eligibility.pending || (eligibility.result && eligibility.result.taskRevision !== task.revision) || eligibility.result?.status === 'disabled' || eligibility.result?.status === 'failed' || (eligibility.result?.status === 'ready' && eligibility.result.eligible === false);
  const automatic = bound.length > 0 && !devices.error;
  const disabled = bridge.dispatch.isPending || (!resumable && (automatic ? Boolean(invalid) || bridge.handoffs.isPending || Boolean(bridge.handoffs.error) : !eligibility.eligible));
  const send = async () => {
    if (disabled || lock.current) return;
    if (!automatic || resumable) { onHandoff(); return; }
    lock.current = true;
    try {
      const preferred = preferredBridgeDevice(projectId);
      const device = bound.find(item => item.deviceId === preferred) ?? (bound.length === 1 ? bound[0] : undefined);
      if (!device) { onHandoff(); return; }
      const result = await bridge.dispatch.mutateAsync(device.deviceId);
      if (result.actorId === currentActor.current) onHandoff();
    } catch { /* The mutation exposes a retryable error without opening a false success. */ }
    finally { lock.current = false; }
  };
  const reasonId = `agent-ineligible-${task.taskId}`;
  return <>
    <button className="button button-quiet button-small" disabled={disabled} aria-describedby={eligibility.reason && !resumable ? reasonId : undefined} onClick={() => void send()}>{bridge.dispatch.isPending ? '正在派发' : resumable ? '查看 Agent 进度' : '交给本地 Agent'}</button>
    {(!automatic || invalid) && !resumable && <TaskAgentEligibilityNotice eligibility={eligibility} reasonId={reasonId} />}
    {bridge.dispatch.error && <ErrorNotice error={bridge.dispatch.error} />}
    {automatic && bridge.handoffs.error && <ErrorNotice error={bridge.handoffs.error} onRetry={() => void bridge.handoffs.refetch()} />}
    {!devices.isPending && !automatic && !invalid && <a className="button button-quiet button-small" href="/app/settings/agent-bridges">连接 DSH</a>}
  </>;
}
