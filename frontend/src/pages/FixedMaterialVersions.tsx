import { usePagedItems } from '../features/pagination/usePagedItems';
import { LoadMore } from '../features/pagination/LoadMore';
import { AiReferenceBadge } from '../components/AiReferenceBadge';
import { useState } from 'react';
import { projectPath } from '../api/client';
import { EmptyState, ErrorNotice, Field, Spinner } from '../components/ui';

export function FixedMaterialVersions({ projectId, selected, onChange, limit = 10, disabled = false }: { projectId: string; selected: string[]; onChange: (ids: string[]) => void; limit?: number; disabled?: boolean }) {
  const [chosenMaterialId, setChosenMaterialId] = useState('');
  const materials = usePagedItems<'MaterialListResponse'>({ searchable: true, queryKey: ['materials', projectId], path: projectPath(projectId, '/materials'), query: { limit: 100 } });
  const materialId = chosenMaterialId || materials.data?.[0]?.materialId || '';
  const versions = usePagedItems<'MaterialVersionListResponse'>({ queryKey: ['materialVersions', projectId, materialId], enabled: Boolean(materialId), path: projectPath(projectId, `/materials/${encodeURIComponent(materialId)}/versions`), query: { limit: 100 } });
  return <section className="stack fixed-material-versions" aria-label="固定文档版本">
    <Field aiReference label="选择文档"><select className="input" value={materialId} disabled={disabled} onChange={event => setChosenMaterialId(event.target.value)}><option value="">选择背景、参考或成果文档</option>{materials.data?.map(material => <option key={material.materialId} value={material.materialId}>{material.title}</option>)}</select></Field>
    {materials.error && <ErrorNotice error={materials.error} onRetry={() => void materials.refetch()} />}<LoadMore query={materials} label="文档" />
    {(materials.isLoading || (materialId && versions.isLoading)) && <Spinner label="读取固定文档版本" />}
    {versions.error && <ErrorNotice error={versions.error} onRetry={() => void versions.refetch()} />}<LoadMore query={versions} label="版本" />
    {materialId && versions.data?.length === 0 && <EmptyState title="文档尚未保存版本" detail="先保存正文，再选择固定版本作为 AI 上下文或评分依据。" />}
    <div className="ai-workflow-choice-list">{versions.data?.map(version => <label key={version.versionId} className="collab-version"><input type="checkbox" disabled={disabled || (!selected.includes(version.versionId) && selected.length >= limit)} checked={selected.includes(version.versionId)} onChange={event => onChange(event.target.checked ? [...selected, version.versionId] : selected.filter(id => id !== version.versionId))} /><span>r{version.revision} · {new Date(version.createdAt).toLocaleString('zh-CN')}{materials.data?.find(material => material.materialId === materialId)?.currentVersionId === version.versionId ? ' · 当前' : ''}</span><AiReferenceBadge ariaHidden /></label>)}</div>
    {selected.length > 0 && <div className="chip-list">{selected.map(id => <button type="button" className="chip" key={id} disabled={disabled} onClick={() => onChange(selected.filter(value => value !== id))}>固定版本 {id.slice(0, 8)} ×</button>)}</div>}
    <p className="form-note">已选择 {selected.length} / {limit} 个固定版本；后续文档编辑不会改变所选正文。</p>
  </section>;
}
