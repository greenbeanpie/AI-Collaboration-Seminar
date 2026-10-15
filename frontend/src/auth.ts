import { useQuery } from '@tanstack/react-query';
import { api, ApiError, fetchWithTimeout, isApiFailure } from './api/client';
import type { Capability, User } from './api/types';

export function useSession() {
  return useQuery({
    queryKey: ['session'],
    networkMode: 'always',
    queryFn: async ({ signal }) => {
      try {
        return (await api.get<'AuthSessionGetResponse'>('/api/v1/auth/session', undefined, signal)).user as User;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function useCapabilities() {
  return useQuery({
    queryKey: ['capabilities'],
    networkMode: 'always',
    queryFn: ({ signal }) => api.get<'CapabilitiesResponse'>('/api/v1/capabilities', undefined, signal) as Promise<Capability>,
    staleTime: 60_000,
    retry: 1,
  });
}

/** Admin session cookies are the default; a token is an explicit operations fallback. */
export async function adminRequest<T>(path: string, options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown; token?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const token = options.token?.trim();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  let result: unknown;
  const method = options.method ?? 'GET';
  const deadline = options.timeoutMs ?? (method === 'GET' ? 15_000 : /^\/api\/v1\/admin\/(?:resource-policy|ai-resource-dispatches(?:\/|$)|accounts(?:\/|$)|account-invitations(?:\/|$))/.test(path) ? 30_000 : undefined);
  try {
    ({ response } = await fetchWithTimeout(
      path,
      {
        method,
        credentials: 'same-origin',
        cache: /^\/api\/v1\/(?:resource-usage|admin\/(?:accounts|resource-policy|ai-resource-dispatches|ai-config|ai-diagnostics|ai-retries))(?:[/?]|$)/.test(path) ? 'no-store' : undefined,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      },
      { signal: options.signal, timeoutMs: deadline },
    ));
    result = await response.json().catch(error => { if (options.signal?.aborted) throw error; return null; });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if ((error as { timedOut?: boolean })?.timedOut) {
      throw new ApiError(0, { requestId: '', error: { code: 'REQUEST_TIMEOUT', message: method === 'GET' ? '读取服务超时，请检查网络后重试。' : '请求超时，服务端结果尚未确认；请先刷新状态，再继续操作。', retryable: true, ...(method === 'GET' ? {} : { details: { outcomeUnknown: true } }) } });
    }
    throw new Error('无法连接服务，请检查网络或后端是否启动。', { cause: error });
  }
  if (!response.ok) {
    if (response.status === 401 && !token) window.dispatchEvent(new CustomEvent('auth-expired'));
    if (isApiFailure(result)) throw new ApiError(response.status, result);
    if (token && response.status === 401) throw new Error('管理员令牌无效或已失效，请重新填写。');
    throw new Error(response.status === 403 ? '需要系统管理员权限，项目负责人不能管理系统账户。' : '请求失败，请稍后重试。');
  }
  if (!result || typeof result !== 'object' || !('data' in result)) throw new Error('服务返回了无法识别的响应。');
  return result.data as T;
}

export type AccountInvitation = { id: string; createdAt: string; usedAt: string | null; usedBy: string | null };
export type CreatedAccountInvitation = { id: string; code: string; createdAt: string };
