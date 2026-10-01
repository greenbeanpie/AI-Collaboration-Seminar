import { ApiError, apiUrl, isApiFailure } from '../api/client';
import type { NotificationRequest } from './core';
/** Same authenticated envelope transport, while keeping this feature's contract isolated. */
export const notificationRequest: NotificationRequest = async <T,>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal, expectedAccount?: string): Promise<T> => {
  const response = await fetch(apiUrl(path), { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...(expectedAccount ? {'X-Notification-Account':expectedAccount} : {}) }, credentials: 'include', cache: 'no-store', signal });
  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('auth-expired'));
    if (isApiFailure(payload)) throw new ApiError(response.status, payload);
    throw new Error('通知服务暂不可用，请稍后重试。');
  }
  if (!payload || typeof payload !== 'object' || !('data' in payload)) throw new Error('通知服务返回格式无效。');
  return payload.data as T;
};
