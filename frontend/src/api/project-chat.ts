import { projectRequest } from './simplification';
import type { DataOf } from './types';

export type ChatHistory = DataOf<'ProjectChatHistoryResponse'>;
export type ChatMessage = ChatHistory['items'][number];
export type ChatReference = NonNullable<ChatMessage['references']>[number];
export type ChatOperations = DataOf<'ProjectChatOperationsResponse'>;
export type ChatOperation = ChatOperations['items'][number];
export const readChat = (projectId: string, cursor?: string, signal?: AbortSignal) => projectRequest<ChatHistory>(projectId, '/ai-chat', { query: { cursor }, signal, networkOnly: true });
export const readChatOperations = (projectId: string, questionId: string, cursor?: string, signal?: AbortSignal) => projectRequest<ChatOperations>(projectId, `/ai-chat/questions/${encodeURIComponent(questionId)}/operations`, { query: { cursor }, signal, networkOnly: true });
export const sendChat = (projectId: string, content: string, idempotencyKey: string) => projectRequest<{ questionId: string; jobId: string }>(projectId, '/ai-chat', { method: 'POST', body: { content }, idempotencyKey, networkOnly: true });
export const clearChat = (projectId: string, idempotencyKey: string) => projectRequest<{ cleared: true }>(projectId, '/ai-chat', { method: 'DELETE', idempotencyKey, networkOnly: true });

/** Project resource links only. Never expose model-provided external/javascript URLs as navigation. */
export function chatResourceHref(projectId: string, href: string | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, window.location.origin);
    const prefix = `/app/projects/${encodeURIComponent(projectId)}`;
    return url.origin === window.location.origin && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch { return null; }
}
