import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { PageDialog } from './PageDialog';

export interface DialogOptions { kind: 'confirm' | 'prompt' | 'alert'; message: string; title?: string; initialValue?: string; confirmLabel?: string; cancelLabel?: string; signal?: AbortSignal }
export type DialogResult = boolean | string | null;
let active: { cancel: () => void } | null = null;
export function cancelPageDialog(): void { active?.cancel(); }
function focusedElement(): HTMLElement | null {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element instanceof HTMLElement ? element : null;
}
/** One visible decision at a time. A second request is cancelled, never implicitly approved. */
export function pageDialog(options: DialogOptions): Promise<DialogResult> {
  const cancelled = options.kind === 'prompt' ? null : false;
  if (active || options.signal?.aborted || typeof document === 'undefined') return Promise.resolve(cancelled);
  const container = document.createElement('div'); container.dataset.pageDialog = 'true'; document.body.append(container);
  const root = createRoot(container); const previousFocus = focusedElement();
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: DialogResult) => {
      if (settled) return; settled = true;
      if (active?.cancel === cancel) active = null;
      window.removeEventListener('popstate', cancel); window.removeEventListener('pagehide', cancel);
      options.signal?.removeEventListener('abort', cancel);
      queueMicrotask(() => {
        root.unmount(); container.remove();
        if (previousFocus?.isConnected) previousFocus.focus();
        resolve(options.signal?.aborted ? cancelled : result);
      });
    };
    const cancel = () => finish(cancelled);
    active = { cancel };
    window.addEventListener('popstate', cancel); window.addEventListener('pagehide', cancel);
    options.signal?.addEventListener('abort', cancel, { once: true });
    root.render(createElement(PageDialog, { options, onFinish: finish }));
  });
}
export async function confirmPage(message: string, options: Omit<Partial<DialogOptions>, 'kind' | 'message'> = {}): Promise<boolean> { return await pageDialog({ ...options, kind: 'confirm', message }) === true; }
export async function promptPage(message: string, initialValue = '', options: Omit<Partial<DialogOptions>, 'kind' | 'message' | 'initialValue'> = {}): Promise<string | null> { const result = await pageDialog({ ...options, kind: 'prompt', message, initialValue }); return typeof result === 'string' ? result : null; }

// The independently loaded update bar can use the same React modal whenever the app is ready.
if (typeof window !== 'undefined') window.addEventListener('app-page-dialog', (event: Event) => {
  const detail = (event as CustomEvent<{ options?: DialogOptions; resolve?: (result: DialogResult) => void }>).detail;
  if (!detail?.options || typeof detail.options.message !== 'string' || typeof detail.resolve !== 'function') return;
  event.preventDefault(); void pageDialog(detail.options).then(detail.resolve);
});
