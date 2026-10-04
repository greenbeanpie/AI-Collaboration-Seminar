import { accountRequest } from './simplification';
import { idempotencyKeyForIntent, completeIntent } from '../pages/aiWorkflowSupport';
import { offlineAccount } from '../offline/store';

export type BridgeDevice = { deviceId: string; deviceName: string; paired: boolean; projects: Array<{ projectId: string; name: string; workspaceLabel: string | null }>; lastSeenAt?: string | null; revoked: boolean; protocolVersion: number };
export type BridgeState = 'checking' | 'waiting_device' | 'claimed' | 'running' | 'waiting_input' | 'uploading' | 'ready_for_review' | 'blocked' | 'failed' | 'cancel_requested' | 'cancelled' | 'dispatch_uncertain';
export type BridgeHandoff = { handoffId: string; projectId: string; taskId: string; taskRevision: number; deviceId: string; state: BridgeState; reason: string | null; stale?: boolean; adoptedSubmissionId?: string | null; snapshotHash: string | null; sessionId: string | null; result: null | { summary: string; artifacts: Array<{ artifactId: string; fileId: string; name: string; sizeBytes: number; sha256: string }> }; createdAt: string; updatedAt: string };
export type BridgePairing = { pairingId: string; deviceName: string; expiresAt: string; status: string; projects?: Array<{ projectId: string; name: string }> };
const base = '/api/v1/agent-bridges';
const taskPath = (projectId: string, taskId: string) => `${base}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/handoffs`;
const get = <T>(path: string, signal?: AbortSignal) => accountRequest<T>(path, { signal, networkOnly: true });
const inFlight = new Map<string, Promise<unknown>>();
async function post<T>(path: string, body: unknown, actorId: string) {
  if (!actorId) throw new Error('请登录后重新操作。');
  const operation = `${actorId}:${path}:${JSON.stringify(body)}`;
  const existing = inFlight.get(operation);
  if (existing) return await existing as T;
  const pending = performPost<T>(path, body, actorId);
  inFlight.set(operation, pending);
  try { return await pending; } finally { if (inFlight.get(operation) === pending) inFlight.delete(operation); }
}
async function performPost<T>(path: string, body: unknown, actorId: string) {
  const namespace = `bridge:${actorId}:${path}`;
  const idempotencyKey = await idempotencyKeyForIntent(namespace, body);
  const activeAccount = offlineAccount()?.id;
  if (activeAccount && activeAccount !== actorId) throw new Error('登录账号已切换，请重新操作。');
  const result = await accountRequest<T>(path, { method: 'POST', body, idempotencyKey, networkOnly: true });
  completeIntent(namespace);
  return result;
}
export const bridgeApi = {
  devices: (signal?: AbortSignal) => get<{ items: BridgeDevice[] }>(`${base}/devices`, signal),
  pairing: (id: string, signal?: AbortSignal) => get<BridgePairing>(`${base}/pairings/${encodeURIComponent(id)}`, signal),
  approve: (id: string, projectIds: string[], actorId: string) => post<BridgePairing>(`${base}/pairings/${encodeURIComponent(id)}/approve`, { projectIds }, actorId),
  revoke: (id: string) => accountRequest(`${base}/devices/${encodeURIComponent(id)}`, { method: 'DELETE', networkOnly: true }),
  handoffs: (projectId: string, taskId: string, signal?: AbortSignal) => get<{ items: BridgeHandoff[] }>(taskPath(projectId, taskId), signal),
  dispatch: (projectId: string, taskId: string, expectedRevision: number, targetDeviceId: string, actorId: string) => post<BridgeHandoff>(taskPath(projectId, taskId), { expectedRevision, targetDeviceId }, actorId),
  cancel: (id: string, actorId: string) => post<BridgeHandoff>(`${base}/handoffs/${encodeURIComponent(id)}/cancel`, {}, actorId),
  adopt: (id: string, expectedTaskRevision: number, actorId: string) => post(`${base}/handoffs/${encodeURIComponent(id)}/adopt-and-submit`, { expectedTaskRevision, reviewed: true }, actorId),
};
