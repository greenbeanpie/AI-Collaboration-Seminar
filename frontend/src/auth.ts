import { useQuery } from '@tanstack/react-query';
import { api, ApiError, isApiFailure } from './api/client';
import type { Capability, User } from './api/types';

export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        return (await api.get<'AuthSessionGetResponse'>('/api/v1/auth/session')).user as User;
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
    queryFn: () => api.get<'CapabilitiesResponse'>('/api/v1/capabilities') as Promise<Capability>,
    staleTime: 60_000,
    retry: 1,
  });
}

/** Admin session cookies are the default; a token is an explicit operations fallback. */
export async function adminRequest<T>(path: string, options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH'; body?: unknown; token?: string } = {}): Promise<T> {
  const token = options.token?.trim();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(path, { method: options.method ?? 'GET', credentials: 'same-origin', cache: /^\/api\/v1\/admin\/(?:accounts|ai-config|ai-diagnostics)(?:[/?]|$)/.test(path) ? 'no-store' : undefined, headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  } catch {
    throw new Error('无法连接服务，请检查网络或后端是否启动。');
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !token) window.dispatchEvent(new CustomEvent('auth-expired'));
    if (token && response.status === 401) throw new Error('管理员令牌无效或已失效，请重新填写。');
    if (isApiFailure(result)) throw new ApiError(response.status, result);
    throw new Error(response.status === 403 ? '需要系统管理员权限，项目负责人不能管理系统账户。' : `请求失败 ${response.status}`);
  }
  if (!result || typeof result !== 'object' || !('data' in result)) throw new Error('服务返回了无法识别的响应。');
  return result.data as T;
}

export type AccountInvitation = { id: string; createdAt: string; usedAt: string | null; usedBy: string | null };
export type CreatedAccountInvitation = { id: string; code: string; createdAt: string };
