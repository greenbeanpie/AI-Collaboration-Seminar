import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Window long display lists; editable forms should remain mounted. */
export function VirtualList<T>({ items, getKey, renderItem, label, className = '' }: {
  items: T[]; getKey: (item: T) => string; renderItem: (item: T) => ReactNode; label: string; className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const [viewport, setViewport] = useState({ top: 0, height: 640 });
  const [revision, setRevision] = useState(0);
  const [focused, setFocused] = useState<number | null>(null);
  const virtual = items.length > 100;
  const offsets = [0];
  for (const item of items) offsets.push(offsets[offsets.length - 1]! + (heights.current.get(getKey(item)) ?? 180));
  const start = virtual ? Math.max(0, offsets.findIndex(offset => offset >= viewport.top) - 5) : 0;
  let end = virtual ? offsets.findIndex(offset => offset > viewport.top + viewport.height) + 5 : items.length;
  if (end < 5 || end > items.length) end = items.length;
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || !virtual || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.virtualKey;
        if (key && entry.contentRect.height > 0 && heights.current.get(key) !== entry.contentRect.height) {
          heights.current.set(key, entry.contentRect.height); changed = true;
        }
      }
      if (changed) setRevision(value => value + 1);
      setViewport(current => current.height === (element.clientHeight || 640) ? current : ({ ...current, height: element.clientHeight || 640 }));
    });
    observer.observe(element);
    element.querySelectorAll('[data-virtual-key]').forEach(row => observer.observe(row));
    return () => observer.disconnect();
  }, [virtual, start, end, items, focused, revision]);
  const indexes = Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
  if (virtual && focused !== null && focused < items.length && !indexes.includes(focused)) indexes.push(focused);
  indexes.sort((a, b) => a - b);
  const goTo = (index: number) => {
    const next = Math.max(0, Math.min(items.length - 1, index));
    setFocused(next);
    if (container.current) container.current.scrollTop = offsets[next]!;
    setViewport(current => ({ ...current, top: offsets[next]! }));
    requestAnimationFrame(() => container.current?.querySelector<HTMLElement>(`[data-virtual-index="${next}"]`)?.focus());
  };
  if (!virtual) return <div className={className}>{items.map(item => <div key={getKey(item)}>{renderItem(item)}</div>)}</div>;
  return <div ref={container} className={className} role="list" aria-label={label} tabIndex={0}
    style={{ overflowY: 'auto', maxHeight: 'min(70vh, 800px)', position: 'relative', display: 'block' }}
    onScroll={event => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight || 640 })}
    onKeyDown={event => {
      // Preserve controls' own keyboard interaction (selects, text inputs and buttons).
      if (event.target !== container.current && !(event.target as HTMLElement).hasAttribute('data-virtual-index')) return;
      const index = focused ?? 0;
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); goTo(event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1));
      }
    }}>
    <div style={{ height: offsets[items.length], position: 'relative' }}>{indexes.map(index => <div
      key={getKey(items[index]!)} role="listitem" aria-setsize={items.length} aria-posinset={index + 1}
      data-virtual-key={getKey(items[index]!)} data-virtual-index={index} tabIndex={-1}
      onFocus={() => setFocused(index)} style={{ position: 'absolute', top: offsets[index], left: 0, right: 0 }}>
      {renderItem(items[index]!)}
    </div>)}</div>
  </div>;
}
