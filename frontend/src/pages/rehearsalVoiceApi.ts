import { ApiError, isApiFailure } from '../api/client';
export type VoiceConfig = { configured: boolean; ready: boolean; mode: 'text' | 'voice-with-text-fallback'; reason: string | null; speech: { model: string; voice: string } };
export type VoiceSession = { sessionId: string; webSocketPath: string; expiresAt: string };
export type Speech = { speechId: string; jobId?: string; status: 'queued' | 'running' | 'ready' | 'failed'; audioPath?: string; error?: string };
/** Voice operations always use the authenticated network; never enqueue offline audio. */
export async function voiceRequest<T>(path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'include', cache: 'no-store', signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new CustomEvent('auth-expired'));
    if (isApiFailure(payload)) throw new ApiError(response.status, payload);
    throw new Error('语音服务暂时不可用，请使用文字回答。');
  }
  if (!payload || typeof payload !== 'object' || !('data' in payload)) throw new Error('语音服务响应无效。');
  return payload.data as T;
}
export function authenticatedVoicePath(path: string, prefix: string): string {
  if (!path.startsWith(`${prefix}/`) || path.startsWith('//') || path.includes('..') || path.includes('?') || path.includes('#')) throw new Error('语音服务返回了无效的私有资源路径。');
  return path;
}
