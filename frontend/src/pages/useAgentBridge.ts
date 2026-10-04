import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bridgeApi, type BridgeHandoff, type BridgeDevice } from '../api/agent-bridges';
import type { CollaborationTask } from '../api/collaboration';
import { useSession } from '../auth';

export const bridgeDevicesKey = ['agent-bridge-devices'] as const;
export const bridgeHandoffsKey = (projectId: string, taskId: string) => ['agent-bridge-handoffs', projectId, taskId] as const;
export const bridgeActive = (item: BridgeHandoff) => !['blocked', 'failed', 'cancelled', 'ready_for_review'].includes(item.state);
const devicePreferences = new Map<string, string>();
export function preferredBridgeDevice(projectId: string) {
  try { return localStorage.getItem(`agent-bridge-device:${projectId}`) ?? devicePreferences.get(projectId) ?? ''; }
  catch { return devicePreferences.get(projectId) ?? ''; }
}
export function rememberBridgeDevice(projectId: string, deviceId: string) {
  devicePreferences.set(projectId, deviceId);
  try { localStorage.setItem(`agent-bridge-device:${projectId}`, deviceId); } catch { /* A disabled storage API still allows this session's choice. */ }
}
export function useBridgeDevices() {
  const session = useSession();
  return useQuery({ queryKey: [...bridgeDevicesKey, session.data?.id], enabled: Boolean(session.data?.id), queryFn: ({ signal }) => bridgeApi.devices(signal), retry: false, staleTime: 10_000, networkMode: 'always' });
}
export function boundBridgeDevices(devices: BridgeDevice[] | undefined, projectId: string) {
  return devices?.filter(device => device.paired && !device.revoked && device.protocolVersion === 1 && device.projects.some(project => project.projectId === projectId && project.workspaceLabel)) ?? [];
}
export function useAgentBridge(projectId: string, task: CollaborationTask, poll = false) {
  const client = useQueryClient();
  const session = useSession();
  const currentActor = useRef(session.data?.id);
  useEffect(() => { currentActor.current = session.data?.id; }, [session.data?.id]);
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  useEffect(() => { const change = () => setVisible(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change); }, []);
  const key = [...bridgeHandoffsKey(projectId, task.taskId), session.data?.id];
  const handoffs = useQuery({ queryKey: key, enabled: Boolean(session.data?.id), queryFn: ({ signal }) => bridgeApi.handoffs(projectId, task.taskId, signal), retry: false, networkMode: 'always', staleTime: 0, refetchInterval: query => poll && visible && query.state.data?.items.some(bridgeActive) ? 2000 : false, refetchIntervalInBackground: false });
  const dispatch = useMutation({ mutationKey: [...key, task.revision], retry: false, networkMode: 'always', mutationFn: async (deviceId: string) => { const actorId = session.data?.id ?? ''; const item = await bridgeApi.dispatch(projectId, task.taskId, task.revision, deviceId, actorId); return { actorId, item }; }, onSuccess: ({ actorId, item }) => { if (currentActor.current !== actorId) return; client.setQueryData<{ items: BridgeHandoff[] }>([...bridgeHandoffsKey(projectId, task.taskId), actorId], previous => ({ items: [item, ...(previous?.items ?? []).filter(old => old.handoffId !== item.handoffId)] })); } });
  return { handoffs, dispatch };
}
