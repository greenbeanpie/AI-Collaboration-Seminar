import { useState, type ReactNode } from 'react';

const PAGE_SIZE = 6;
/** Presentation pages stay independent of the selected report and server cursors. */
export function AssessmentHistoryPages<T>({ items, renderItem, hasMore, loading, loadMore }: {
  items: T[]; renderItem: (item: T) => ReactNode; hasMore: boolean; loading: boolean;
  loadMore: () => Promise<boolean>;
}) {
  const [requestedPage, setPage] = useState(0);
  const [turning, setTurning] = useState(false);
  const page = Math.min(requestedPage, Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1));
  const busy = loading || turning;
  const next = async () => {
    if (busy) return;
    setTurning(true);
    try {
      // Fill the whole display page when it straddles a server cursor boundary.
      if ((page + 2) * PAGE_SIZE > items.length && hasMore && !await loadMore()) return;
      setPage(page + 1);
    } finally { setTurning(false); }
  };
  if (!items.length) return null;
  return <>
    <div aria-label="评分历史" className="assessment-history" aria-busy={busy}>
      {items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(renderItem)}
    </div>
    <nav aria-label="评分历史翻页" className="assessment-history-pagination">
      <button className="button button-quiet button-small" disabled={page === 0 || busy} onClick={() => setPage(page - 1)}>上一页</button>
      <span aria-live="polite">第 {page + 1} 页{!hasMore && ` / 共 ${Math.ceil(items.length / PAGE_SIZE)} 页`} · 每页 {PAGE_SIZE} 条</span>
      <button className="button button-quiet button-small" disabled={busy || !hasMore && (page + 1) * PAGE_SIZE >= items.length} onClick={() => void next()}>{turning ? '正在读取' : '下一页'}</button>
    </nav>
  </>;
}
