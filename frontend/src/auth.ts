import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from './api/client';
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
