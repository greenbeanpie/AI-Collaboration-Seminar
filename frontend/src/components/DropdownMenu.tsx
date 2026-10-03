import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import './DropdownMenu.css';

export function DropdownMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('.dropdown-content button, .dropdown-content a')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    root.current?.addEventListener('keydown', keyboard);
    const element = root.current;
    return () => { document.removeEventListener('pointerdown', outside); element?.removeEventListener('keydown', keyboard); };
  }, [open]);
  return <div className="dropdown-menu" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} type="button" className="button button-quiet button-small" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{label} ▾</button>
    {open && <div id={id} className="dropdown-content" aria-label={label} onClick={event => { if ((event.target as HTMLElement).closest('button, a')) { setOpen(false); trigger.current?.focus(); } }}>{children}</div>}
  </div>;
}
