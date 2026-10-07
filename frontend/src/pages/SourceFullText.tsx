import { VirtualList } from '../components/VirtualList';
import { usePagedItems } from '../features/pagination/usePagedItems';
import { LoadMore } from '../features/pagination/LoadMore';
import { AiReferenceBadge } from '../components/AiReferenceBadge';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useProject } from '../components/ProjectShell';
import { api, projectPath } from '../api/client';
import { ErrorNotice } from '../components/ui';

export function SourceFullText({ sourceId, sourceVersionId }: { sourceId: string; sourceVersionId: string }) {
  const { projectId } = useProject();
  const [params] = useSearchParams();
  const target = params.get('sourceVersionId') === sourceVersionId ? params.get('fragmentId') : null;
  const [open, setOpen] = useState(Boolean(target));
  const path = projectPath(projectId, `/sources/${encodeURIComponent(sourceId)}/versions/${encodeURIComponent(sourceVersionId)}/fragments`);
  const query = usePagedItems<'SourceFragmentListResponse'>({ queryKey: ['sourceFragments', projectId, sourceVersionId], path, enabled: open || Boolean(target), searchable: true });
  const targetQuery = useQuery({ queryKey: ['sourceFragment', projectId, sourceVersionId, target], enabled: Boolean(target), queryFn: () => api.get<'SourceFragmentListResponse'>(path, { fragmentId: target, limit: 1 }) });
  const fragments = targetQuery.data?.items[0] && !query.data?.some(fragment => fragment.fragmentId === target) ? [targetQuery.data.items[0], ...(query.data ?? [])] : query.data ?? [];
  useEffect(() => {
    if (target && query.data) document.getElementById(`fragment-${target}`)?.scrollIntoView({ block: 'center' });
  }, [target, query.data, targetQuery.data]);
  return <details open={open || Boolean(target)} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>查看全文片段与引用定位</summary>
    <LoadMore query={query} label="来源全文" />
    {query.isLoading && <p>正在读取全文……</p>}{query.error && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
    <VirtualList label="来源全文片段" items={fragments} getKey={fragment => fragment.fragmentId} renderItem={f => <article key={f.fragmentId} id={`fragment-${f.fragmentId}`} style={{ whiteSpace: 'pre-wrap', padding: '1rem', border: f.fragmentId === target ? '2px solid var(--blue)' : '1px solid var(--line)', marginTop: '0.5rem' }}>
      <strong>{f.content.startsWith('# AI 摘要（非逐字原文）') ? 'AI 音视频摘要（非逐字原文）' : f.pageNumber ? `第 ${f.pageNumber} 页` : '正文'} · 片段 {f.seq}{f.kind === 'ocr' ? ' · OCR 待人工复核' : ''}<AiReferenceBadge ariaHidden /></strong><p>{f.content}</p>
    </article>} />
    {query.data?.length === 0 && !query.hasNextPage && <p>{query.search ? '未找到匹配原文，可调整搜索词。' : '尚无可引用文本，请先解析或补齐 OCR 页面。'}</p>}
  </details>;
}
