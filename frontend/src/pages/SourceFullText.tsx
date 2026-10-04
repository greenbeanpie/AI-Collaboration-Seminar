import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useProject } from '../components/ProjectShell';
import { listAllItems, projectPath } from '../api/client';
import { ErrorNotice } from '../components/ui';

export function SourceFullText({ sourceId, sourceVersionId }: { sourceId: string; sourceVersionId: string }) {
  const { projectId } = useProject();
  const [params] = useSearchParams();
  const target = params.get('sourceVersionId') === sourceVersionId ? params.get('fragmentId') : null;
  const [open, setOpen] = useState(Boolean(target));
  const query = useQuery({ queryKey: ['sourceFragments', projectId, sourceVersionId], enabled: open || Boolean(target), queryFn: () => listAllItems<'SourceFragmentListResponse'>(projectPath(projectId, `/sources/${sourceId}/versions/${sourceVersionId}/fragments`)) });
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (target && query.data) document.getElementById(`fragment-${target}`)?.scrollIntoView({ block: 'center' });
  }, [target, query.data]);
  return <details open={open || Boolean(target)} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>查看全文片段与引用定位</summary>
    <input className="input" aria-label="搜索来源全文" placeholder="搜索原文" value={search} onChange={e => setSearch(e.target.value)} />
    {query.isLoading && <p>正在读取全文……</p>}{query.error && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
    {query.data?.filter(f => f.content.includes(search) || f.fragmentId === target).map(f => <article key={f.fragmentId} id={`fragment-${f.fragmentId}`} style={{ whiteSpace: 'pre-wrap', padding: '1rem', border: f.fragmentId === target ? '2px solid var(--blue)' : '1px solid var(--line)', marginTop: '0.5rem' }}>
      <strong>{f.content.startsWith('# AI 摘要（非逐字原文）') ? 'AI 音视频摘要（非逐字原文）' : f.pageNumber ? `第 ${f.pageNumber} 页` : '正文'} · 片段 {f.seq}{f.kind === 'ocr' ? ' · OCR 待人工复核' : ''}</strong><p>{f.content}</p>
    </article>)}
    {query.data?.length === 0 && <p>尚无可引用文本，请先解析或补齐 OCR 页面。</p>}
  </details>;
}
