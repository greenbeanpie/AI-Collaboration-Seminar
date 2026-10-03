import { useEffect, useRef, type ReactNode } from 'react';

let modalCount = 0;
let originalOverflow = '';
function lockPageScroll() {
  if (modalCount++ === 0) { originalOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; }
  return () => { if (--modalCount === 0) document.body.style.overflow = originalOverflow; };
}

export function Modal({ title, children, onClose, descriptionId, headerActions, mode = 'dialog' }: { title: string; descriptionId?: string; children: ReactNode; headerActions?: ReactNode; onClose: () => void; mode?: 'dialog' | 'page' | 'hidden' }) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    if (mode === 'page') { dialog.current?.focus(); return; }
    if (mode !== 'dialog') return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unlockScroll = lockPageScroll();
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0);
    (focusable()[0] ?? dialog.current)?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).at(-1) !== dialog.current) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== 'Tab') return;
      const targets = focusable();
      const first = targets[0]; const last = targets[targets.length - 1];
      if (!first) { event.preventDefault(); dialog.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); unlockScroll(); previousFocus?.focus(); };
  }, [mode]);
  return <div hidden={mode === 'hidden'} className={mode === 'dialog' ? 'modal-backdrop' : 'workspace-subpage'} role={mode === 'dialog' ? 'presentation' : undefined} onMouseDown={(event) => { if (mode === 'dialog' && event.target === event.currentTarget) onClose(); }}><section ref={dialog} tabIndex={-1} className={mode === 'dialog' ? 'modal' : 'stack'} role={mode === 'dialog' ? 'dialog' : undefined} aria-modal={mode === 'dialog' ? true : undefined} aria-label={title} aria-describedby={descriptionId}><div className="modal-head"><h2>{title}</h2><div className="form-actions">{headerActions}<button className={mode === 'page' ? 'button button-quiet' : 'icon-button'} aria-label={mode === 'page' ? '返回任务操作' : '关闭'} onClick={onClose}>{mode === 'page' ? '返回任务操作' : '×'}</button></div></div>{children}</section></div>;
}
