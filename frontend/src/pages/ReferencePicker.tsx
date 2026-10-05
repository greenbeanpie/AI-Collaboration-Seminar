import { AiReferenceBadge } from '../components/AiReferenceBadge';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listAllItems, projectPath } from '../api/client';
import { ErrorNotice, Spinner } from '../components/ui';
import { FixedMaterialVersions } from './FixedMaterialVersions';

export type ReferenceSelection = { sourceVersionIds: string[]; materialVersionIds: string[] };
export function ReferencePicker({ projectId, sourceVersionIds, materialVersionIds, onChange, disabled = false, sourceLimit = 5, materialLimit = 10 }: ReferenceSelection & { projectId: string; onChange: (selection: ReferenceSelection) => void; disabled?: boolean; sourceLimit?: number; materialLimit?: number }) {
  const [params, setParams] = useSearchParams();
  const open = params.get('referencePicker') === 'open';
  const page = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; page.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setParams(current => { const next = new URLSearchParams(current); next.delete('referencePicker'); return next; }); }
      if (event.key !== 'Tab') return;
      const elements = Array.from(page.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') ?? []);
      const first=elements[0],last=elements.at(-1);
      if (event.shiftKey && (document.activeElement===first || !page.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement===last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown',handle);
    return () => { document.removeEventListener('keydown',handle); document.body.style.overflow=overflow; previous?.focus(); };
  }, [open,setParams]);
  const sources = useQuery({ queryKey: ['project-assistant-sources', projectId], queryFn: () => listAllItems<'SourceListResponse'>(projectPath(projectId, '/sources'), { limit: 100 }, { requireNextCursor: true }), enabled: open });
  const setOpen = (value: boolean) => { const next = new URLSearchParams(params); if (value) next.set('referencePicker', 'open'); else next.delete('referencePicker'); setParams(next); };
  return <><button type="button" className="button button-quiet" disabled={disabled} onClick={() => setOpen(true)}>选择优先参考文件</button><small>已选择 {sourceVersionIds.length + materialVersionIds.length} 个固定版本</small>{open && createPortal(<section ref={page} tabIndex={-1} role="dialog" aria-modal="true" className="reference-picker-page" aria-label="选择优先参考文件"><header className="modal-head"><h2>选择优先参考文件</h2><button type="button" className="button" onClick={() => setOpen(false)}>完成选择并返回</button></header><p>未选择时 AI 自主查阅授权资料。所选版本优先参考，后续编辑不会替换固定版本。</p><h3>项目来源</h3>{sources.isLoading && <Spinner label="读取项目来源" />}{sources.error && <ErrorNotice error={sources.error} />}{sources.data?.map(source => <label className="checkbox-row" key={source.sourceId}><input type="checkbox" checked={Boolean(source.currentVersionId && sourceVersionIds.includes(source.currentVersionId))} disabled={disabled || !source.currentVersionId || (!sourceVersionIds.includes(source.currentVersionId) && sourceVersionIds.length >= sourceLimit)} onChange={e => onChange({ materialVersionIds, sourceVersionIds: e.target.checked ? [...sourceVersionIds, source.currentVersionId!] : sourceVersionIds.filter(id => id !== source.currentVersionId) })}/>{source.title}<AiReferenceBadge ariaHidden /></label>)}{sourceVersionIds.length > 0 && <div className="chip-list">{sourceVersionIds.map(id => <button type="button" className="chip" disabled={disabled} key={id} onClick={() => onChange({ materialVersionIds, sourceVersionIds: sourceVersionIds.filter(value => value !== id) })}>固定来源 {id.slice(0, 8)} ×</button>)}</div>}<h3>项目文档</h3><FixedMaterialVersions projectId={projectId} selected={materialVersionIds} onChange={ids => onChange({ sourceVersionIds, materialVersionIds: ids })} limit={materialLimit} disabled={disabled}/></section>, document.body)}</>;
}
