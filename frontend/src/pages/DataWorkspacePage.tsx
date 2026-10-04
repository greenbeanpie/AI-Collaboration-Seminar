import { Suspense, useState } from 'react';
import { resilientLazy } from '../resilient-lazy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useSearchParams } from 'react-router-dom';
import { Plus, Search, Upload } from 'lucide-react';
import { api, projectPath } from '../api/client';
import { projectRequest, resourceLibrary, resourcePurposeLabels, type ResourceEntry, type ResourcePurpose } from '../api/simplification';
import { useProject } from '../components/ProjectShell';
import { EmptyState, ErrorNotice, Field, Spinner, StatusPill } from '../components/ui';
import { SourcesPage } from './SourcesPage';
import { ProjectFileLibrary } from './ProjectFileLibrary';
import { useCapabilities } from '../auth';
import './ProjectWorkspace.css';
const MaterialEditor = resilientLazy(() => import('./MaterialsPage').then(module => ({ default: module.MaterialsPage })));

export function DataWorkspacePage() {
  const { projectId } = useProject();
  const client = useQueryClient();
  const capabilities = useCapabilities();
  const [params, setParams] = useSearchParams();
  const { hash } = useLocation();
  const [search, setSearch] = useState('');
  const [purpose, setPurpose] = useState<ResourcePurpose | 'all'>('all');
  const [title, setTitle] = useState('');
  const [newPurpose, setNewPurpose] = useState<ResourcePurpose>('output');
  const library = useQuery({ queryKey: ['resource-library', projectId], queryFn: ({ signal }) => resourceLibrary(projectId, signal) });
  const resources = library.data ?? [];
  const mode = params.get('mode');
  const requestedType = params.get('resourceType');
  const sourceHash = hash.startsWith('#source-page-') ? hash.slice(13).replace(/-\d+$/, '') : hash.startsWith('#source-') ? hash.slice(8) : null;
  const requestedId = params.get('resourceId') ?? params.get('materialId') ?? params.get('material') ?? sourceHash;
  const sourceVersionId = params.get('sourceVersionId');
  const selected = requestedId ? resources.find(resource => resource.resourceId === requestedId && (!requestedType || resource.resourceType === requestedType)) : sourceVersionId ? resources.find(resource => resource.currentVersionId === sourceVersionId) : resources.find(resource => !requestedType || resource.resourceType === requestedType);
  const visible = resources.filter(resource => (purpose === 'all' || resource.purpose === purpose) && resource.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const choose = (resource: ResourceEntry) => setParams({ resourceType: resource.resourceType, resourceId: resource.resourceId });
  const refresh = async () => { await client.invalidateQueries({ queryKey: ['resource-library', projectId] }); };
  const create = useMutation({ mutationFn: () => api.post<'MaterialResponse'>(projectPath(projectId, '/materials'), { title: title.trim(), kind: newPurpose === 'background' ? 'background' : 'document', purpose: newPurpose }), onSuccess: async material => { setTitle(''); setParams({ resourceType: 'material', resourceId: material.materialId }); await Promise.all([refresh(), client.invalidateQueries({ queryKey: ['materials', projectId] })]); } });
  const updatePurpose = useMutation({ mutationFn: ({ resource, purpose }: { resource: ResourceEntry; purpose: ResourcePurpose }) => projectRequest<ResourceEntry>(projectId, `/resource-library/${resource.resourceType}/${encodeURIComponent(resource.resourceId)}`, { method: 'PATCH', body: { purpose, expectedRevision: resource.revision } }), onSuccess: refresh, onError: refresh });
  const detailHeader = selected ? <><header className="resource-detail-heading"><div><h2>{selected.title}</h2><StatusPill>{selected.systemManaged ? '系统背景 · 自动同步' : resourcePurposeLabels[selected.purpose]}</StatusPill></div>{selected.canManage && <Field label="修改资料用途"><select className="input" value={selected.purpose} disabled={updatePurpose.isPending} onChange={event => updatePurpose.mutate({ resource: selected, purpose: event.target.value as ResourcePurpose })}>{Object.entries(resourcePurposeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>}</header>
          {updatePurpose.error && <ErrorNotice error={updatePurpose.error} />}</> : null;
  return <div className="page-stack resource-workspace">

    {library.error && <ErrorNotice error={library.error} onRetry={() => void library.refetch()} />}
    <div className="resource-workspace-layout">
      <aside className="card resource-list-panel" aria-label="项目资料列表">
        <h2 className="resource-browser-title">资料浏览</h2>
        <div className="form-actions project-resource-toolbar" aria-label="资料操作"><button className="button button-quiet" onClick={() => setParams({ mode: 'import' })}><Upload size={16} />导入资料</button><button className="button button-primary" onClick={() => setParams({ mode: 'new' })}><Plus size={16} />新建文档</button></div>
        <Field label="搜索资料"><div className="resource-search"><Search size={16} /><input className="input" value={search} onChange={event => setSearch(event.target.value)} placeholder="按标题搜索" /></div></Field>
        <Field label="资料用途"><select className="input" value={purpose} onChange={event => setPurpose(event.target.value as ResourcePurpose | 'all')}><option value="all">全部资料</option>{Object.entries(resourcePurposeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        {library.isLoading && <Spinner label="读取资料列表" />}
        {visible.map(resource => <button key={`${resource.resourceType}:${resource.resourceId}`} className={`resource-list-entry ${!mode && selected?.resourceId === resource.resourceId && selected.resourceType === resource.resourceType ? 'active' : ''}`} onClick={() => choose(resource)}><strong>{resource.title}</strong><span><StatusPill>{resourcePurposeLabels[resource.purpose]}</StatusPill><small>{resource.resourceType === 'source' ? '导入原文' : '可编辑文档'} · {resource.currentVersionId ? `r${resource.revision}` : '待处理'}</small></span></button>)}
        {!library.isLoading && !library.error && !visible.length && <p className="muted">{search || purpose !== 'all' ? '没有匹配的资料。' : '尚无资料，请导入或新建文档。'}</p>}
        <button className="button button-quiet button-small" onClick={() => setParams({ mode: 'files' })}>附件与回收站</button>
      </aside>
      <section className="resource-detail-panel" aria-label="资料详情工作区">
        {mode === 'import' ? <SourcesPage embedded intakeOnly /> : mode === 'files' ? capabilities.data ? <ProjectFileLibrary projectId={projectId} pageSize={capabilities.data.limits.listMaxPageSize} onChanged={() => void refresh()} /> : <Spinner label="读取附件能力" /> : mode === 'new' ? <form className="card form-card stack" onSubmit={event => { event.preventDefault(); create.mutate(); }}><h2>新建文档</h2><Field label="文档标题"><input className="input" maxLength={200} required value={title} onChange={event => setTitle(event.target.value)} /></Field><Field label="文档用途"><select className="input" value={newPurpose} onChange={event => setNewPurpose(event.target.value as ResourcePurpose)}>{Object.entries(resourcePurposeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>{create.error && <ErrorNotice error={create.error} />}<button className="button button-primary" disabled={create.isPending || !title.trim()}>创建文档</button></form> : selected ? <>
          {selected.resourceType === 'material' ? <Suspense fallback={<Spinner label="打开文档编辑器" />}><MaterialEditor key={selected.resourceId} embedded materialId={selected.resourceId} versionId={params.get('versionId') ?? params.get('materialVersionId')} initialAiOpen={params.get('ai') === '1'} header={detailHeader} /></Suspense> : <SourcesPage key={selected.resourceId} embedded selectedSourceId={selected.resourceId} header={detailHeader} />}
        </> : !library.isLoading && !library.error ? <EmptyState title={requestedId || sourceVersionId ? '对应资料暂不可用' : '选择一份资料'} detail={requestedId || sourceVersionId ? '请检查资料是否在回收站；固定版本的历史引用仍会保留。' : '在左侧选择背景、参考资料或成果，查看原文或编辑文档。'} /> : null}
      </section>
    </div>
  </div>;
}
