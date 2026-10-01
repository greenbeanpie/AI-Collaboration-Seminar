import { useEffect, useRef } from 'react';
import { confirmPage, promptPage, type DialogOptions } from './dialog-service';
/** Cancels decisions when their record/account/page goes away. */
export function usePageDialogs(scope = '') {
  const current = useRef<AbortController | null>(null);
  useEffect(() => { const controller = new AbortController(); current.current = controller; return () => controller.abort(); }, [scope]);
  return {
    confirm: (message: string, options: Omit<Partial<DialogOptions>, 'kind' | 'message' | 'signal'> = {}) => current.current ? confirmPage(message, { ...options, signal: current.current.signal }) : Promise.resolve(false),
    prompt: (message: string, value = '') => current.current ? promptPage(message, value, { signal: current.current.signal }) : Promise.resolve(null),
  };
}
