import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import './DropdownMenu.css';

export function DropdownMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const menu = root.current?.querySelector<HTMLElement>('.dropdown-content');
    if (!menu) return;
    const position = () => {
      let left = 8;
      let right = (document.documentElement.clientWidth || window.innerWidth) - 8;
      // Editor cards and dialogs may clip descendants even inside the viewport.
      for (let parent = menu.parentElement; parent; parent = parent.parentElement) {
        if (!parent.clientWidth || !/hidden|auto|scroll|clip/.test(getComputedStyle(parent).overflowX)) continue;
        const box = parent.getBoundingClientRect();
        left = Math.max(left, box.left + parent.clientLeft + 8);
        right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth - 8);
      }
      const available = Math.max(1, right - left);
      menu.style.maxWidth = `${available}px`;
      menu.style.minWidth = `${Math.min(180, available)}px`;
      menu.style.setProperty('--dropdown-offset', '0px');
      const box = menu.getBoundingClientRect();
      const offset = box.left < left ? left - box.left : box.right > right ? right - box.right : 0;
      menu.style.setProperty('--dropdown-offset', `${offset}px`);
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [open]);
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
