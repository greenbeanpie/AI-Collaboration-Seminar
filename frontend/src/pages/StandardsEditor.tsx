import { Link } from 'react-router-dom';
import { StandardSummary } from './StandardSummary';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { ApiError, listAllItems, projectPath } from '../api/client';
import { projectRequest, type StandardCitation, type StandardRequirement, type StandardVersion } from '../api/simplification';
import { useProject } from '../components/ProjectShell';
import { EmptyState, ErrorNotice, Field, SectionCard, Spinner, StatusPill } from '../components/ui';
import { idempotencyKeyForIntent, completeIntent, useVisibleJobPoller, readPendingJob, writePendingJob, clearPendingJob } from './aiWorkflowSupport';
import { useSettingsDirty } from './settings-dirty';

type EditorRow = { key: string; requirementId?: string; standalone?: boolean; title: string; detail: string; category: StandardRequirement['category']; dueDate: string; duePrecision: 'date' | 'datetime' | 'unknown'; originalDueDate?: string | null; scored: boolean; dimensionKey: string; dimensionLabel: string; weight: string; citations: StandardCitation[] };
type EditorDraft = { title: string; rows: EditorRow[]; notes: string; base?: { id: string; revision: number } };
type GeneratedDraft = {title:string;notes:string;requirements:Array<{title:string;detail:string;category:EditorRow['category'];dimensionKey?:string;dueDate:string|null;duePrecision:EditorRow['duePrecision'];citations?:StandardCitation[]}>;weights:Array<{key:string;label:string;weight:number}>};
function fromGenerated(value:GeneratedDraft):EditorDraft {
  return {title:value.title,notes:'',rows:value.weights.map(weight=>({...newRow(),title:weight.label,dimensionKey:weight.key,dimensionLabel:weight.label,weight:String(weight.weight),citations:value.requirements.filter(requirement=>requirement.dimensionKey===weight.key).flatMap(requirement=>requirement.citations??[])}))};
}
const newRow = (): EditorRow => ({ key: crypto.randomUUID(), title: '', detail: '', category: 'scoring', dueDate: '', duePrecision: 'unknown', scored: true, dimensionKey: '', dimensionLabel: '', weight: '', citations: [] });
function fromVersion(version: StandardVersion): EditorDraft {
  return {title:version.title,notes:'',base:{id:version.standardsVersionId,revision:version.revision},rows:version.rubric.weights.map(weight=>({...newRow(),title:weight.label,dimensionKey:weight.key,dimensionLabel:weight.label,weight:String(weight.weight),citations:version.requirements.filter(requirement=>version.mappings.some(mapping=>mapping.requirementId===requirement.requirementId&&mapping.dimensionKey===weight.key)).flatMap(requirement=>requirement.citations)}))};
}
export function StandardsEditor() {
  const { projectId } = useProject();
  return <ProjectStandardsEditor key={projectId} />;
}
function ProjectStandardsEditor() {
  const { projectId, project } = useProject();
  const client = useQueryClient();
  const versions = useQuery({ queryKey: ['standards', projectId], queryFn: () => projectRequest<{ items: StandardVersion[] }>(projectId, '/standards') });
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const current = useQuery({ queryKey: ['current-standard', projectId], queryFn: () => projectRequest<{ standard: StandardVersion | null }>(projectId, '/standards/current') });
  const [conflicted, setConflicted] = useState(false);
  const [validationError, setValidationError] = useState<unknown>(null);
  const pendingKey=`standards-generation:${projectId}`;
  const [generationJobId,setGenerationJobId]=useState<string|null>(()=>readPendingJob(pendingKey)?.jobId??null);
  const generationPoll=useVisibleJobPoller(generationJobId);
  const generate=useMutation({mutationFn:async()=>{
    const body={};const namespace=`standards-generate:${projectId}`;
    const key=await idempotencyKeyForIntent(namespace,body);
    const response=await projectRequest<{jobId:string}>(projectId,'/standards/generate',{method:'POST',body,idempotencyKey:key});
    completeIntent(namespace);return response;
  },onSuccess:result=>{setValidationError(null);writePendingJob(pendingKey,{jobId:result.jobId,entityId:projectId,action:'standards.generate'});setGenerationJobId(result.jobId);}});
  const generating=generate.isPending || Boolean(generationJobId && !generationPoll.isSettled);
  useEffect(()=>{
    const job=generationPoll.job;
    if(!job || !generationPoll.isSettled || !generationJobId)return;
    clearPendingJob(pendingKey,generationJobId);
    if(job.status==='succeeded'){
      const result=job.result as {draft?:GeneratedDraft;scoringOutputVersion?:number}|null;
      if(result?.draft){if(result.scoringOutputVersion!==2||result.draft.notes||result.draft.requirements.some(row=>row.category!=='scoring'||row.detail||row.dueDate))setValidationError(new Error('生成结果不符合纯评分标准格式，请重新生成'));else{setDraft(fromGenerated(result.draft));setConflicted(false);setValidationError(null);}}
    }
    if(job.status==='failed' || job.status==='cancelled')setValidationError(job.error??new Error('生成未完成，请重新发起'));
    setGenerationJobId(null);
  },[generationPoll.job,generationPoll.isSettled,generationJobId,pendingKey]);
  useSettingsDirty(Boolean(draft));
  const selected = current.data?.standard;
  const invalidate = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['standards', projectId] }), client.invalidateQueries({ queryKey: ['current-standard', projectId] }), client.invalidateQueries({ queryKey: ['requirementSets', projectId] }), client.invalidateQueries({ queryKey: ['rubrics', projectId] })]); };
  const save = useMutation({ mutationFn: async () => {
    if (!draft) throw new Error('请先编辑项目标准。');
    const weights = draft.rows.filter(row => row.scored).map(row => ({ key: row.dimensionKey.trim(), label: row.dimensionLabel.trim() || row.title.trim(), weight: Number(row.weight) }));
    if (!draft.title.trim() || draft.rows.length === 0 || draft.rows.some(row => !row.dimensionLabel.trim())) throw new Error('请填写标准名称及每个评分维度名称。');
    if (weights.some(weight => !weight.key || !weight.label || !Number.isFinite(weight.weight) || weight.weight < 0 || weight.weight > 100) || draft.rows.some(row => row.scored && !row.weight.trim())) throw new Error('评分维度需要唯一标识、名称和 0–100 的权重。');
    const unique = new Map<string, typeof weights[number]>();
    for (const weight of weights) { const previous = unique.get(weight.key); if (previous && (previous.weight !== weight.weight || previous.label !== weight.label)) throw new Error('同一个评分维度的名称和权重必须一致。'); unique.set(weight.key, weight); }
    if (unique.size > 10) throw new Error('每份标准最多包含 10 个不同评分维度；其他要求可保留为检查项。');
    const body = { title: draft.title.trim(), requirements: draft.rows.filter(row => !row.standalone).map(row => ({ ...(row.requirementId ? { requirementId: row.requirementId } : {}), title: row.dimensionLabel.trim(), detail: '', category: 'scoring', dueDate: null, duePrecision: 'unknown', citations: row.citations.map(({ sourceVersionId, fragmentId, pageNumber, quote }) => ({ sourceVersionId, fragmentId, pageNumber, quote })), ...(row.scored ? { dimensionKey: row.dimensionKey.trim() } : {}) })), weights: [...unique.values()], notes: '' };
    const tail = draft.base ? `/standards/${encodeURIComponent(draft.base.id)}` : '/standards';
    const namespace = `standards-save:${projectId}:${draft.base?.id ?? 'new'}`;
    const idempotencyKey = await idempotencyKeyForIntent(namespace, body);
    const result = await projectRequest<StandardVersion>(projectId, tail, { method: draft.base ? 'PATCH' : 'POST', body: { ...body, ...(draft.base ? { expectedRevision: draft.base.revision } : {}) }, idempotencyKey }); completeIntent(namespace); return result;
  }, onSuccess: async () => { setDraft(null); setConflicted(false); setValidationError(null); await invalidate(); }, onError: async error => { if (error instanceof ApiError && error.status === 409) { setConflicted(true); await invalidate(); } } });
  const update = (key: string, patch: Partial<EditorRow>) => setDraft(current => current ? { ...current, rows: current.rows.map(row => row.key === key ? { ...row, ...patch } : row) } : current);
  return <div className="page-stack">
    <p className="notice notice-warn">该页面标准为项目级标准，任务标准请前往<strong><Link to={`/app/projects/${projectId}/tasks`}>任务</Link></strong>页面选择对应任务进行查看</p>
    <SectionCard title="项目标准" action={project.myRole === 'owner' && !draft ? <div className="form-actions"><button className="button button-quiet" disabled={generating} onClick={()=>generate.mutate()}>AI 生成标准</button><button className="button button-primary" disabled={generating} onClick={() => { setDraft({ title: '项目标准', rows: [newRow()], notes: '' }); setConflicted(false); save.reset(); }}><Plus size={16} />新建标准</button></div> : undefined}>
      {generating && <Spinner label="生成项目标准" />}{generate.error && <ErrorNotice error={generate.error} />}{generationPoll.error !== null && <ErrorNotice error={generationPoll.error} />}{!draft && validationError !== null && <ErrorNotice error={validationError} />}
      {current.isLoading && <Spinner label="读取标准版本" />}{current.error && <ErrorNotice error={current.error} onRetry={() => void current.refetch()} />}
      {draft ? <form className="stack standards-form" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
        <Field label="标准名称"><input className="input" required maxLength={200} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></Field>
        {draft.rows.map((row,index)=><fieldset className="standard-editor-row" key={row.key}><legend>评分维度 {index+1}</legend><div className="standard-dimension-fields"><Field label="评分维度名称"><input className="input" required maxLength={60} value={row.dimensionLabel} onChange={event=>update(row.key,{title:event.target.value,dimensionLabel:event.target.value,dimensionKey:row.dimensionKey||'criterion_'+row.key.replace(/-/g,'').slice(0,20)})}/></Field><Field label="评分权重（%）"><input className="input" type="number" min="0" max="100" step="any" value={row.weight} onChange={event=>update(row.key,{weight:event.target.value})}/></Field></div>
          <SourceCitationPicker projectId={projectId} citations={row.citations} dimensionLabel={row.dimensionLabel} onChange={citations => update(row.key, { citations })} />
          <button type="button" className="button button-quiet button-small" disabled={draft.rows.length <= 1} onClick={() => setDraft({ ...draft, rows: draft.rows.filter(value => value.key !== row.key) })}><Trash2 size={14} />移除评分维度</button>
        </fieldset>)}
        <button className="button button-quiet" type="button" disabled={draft.rows.length >= 10} onClick={() => setDraft({ ...draft, rows: [...draft.rows, newRow()] })}><Plus size={16} />添加评分维度</button>
        {conflicted && <div className="notice notice-warn">生效标准已更新，本地编辑保留。请核对最新版本后再保存。<button className="button button-quiet" type="button" onClick={() => { setDraft({ ...draft, base: selected ? { id: selected.standardsVersionId, revision: selected.revision } : undefined }); setConflicted(false); save.reset(); }}>已核对生效标准，继续修订</button></div>}
        {validationError !== null && <ErrorNotice error={validationError} />}{save.error && <ErrorNotice error={save.error} />}
        <div className="form-actions"><button className="button button-primary" disabled={save.isPending || conflicted}>保存并生效</button><button className="button button-quiet" type="button" onClick={() => setDraft(null)}>取消编辑</button></div>
      </form> : <>
        {selected ? <article className="stack"><h3>{selected.title} <StatusPill tone={'good'}>{`生效标准 v${selected.version}`}</StatusPill></h3><StandardSummary standard={selected} projectId={projectId}/>{project.myRole === 'owner' && <div className="form-actions"><button className="button button-quiet" disabled={generating} onClick={() => { setDraft(fromVersion(selected)); setConflicted(false); save.reset(); }}>修订生效标准</button></div>}</article> : !current.isLoading && !current.error && <EmptyState title="尚未建立统一标准" detail="创建项目评分维度及权重。" />}
        <details><summary>历史标准（只读）</summary>{versions.data?.items.filter(version => version.standardsVersionId !== selected?.standardsVersionId).map(version => <article className="standard-read-row" key={version.standardsVersionId}><h3>{version.title} · v{version.version}</h3><StandardSummary standard={version} projectId={projectId}/></article>)}</details>
      </>}
    </SectionCard>
  </div>;
}

function SourceCitationPicker({ projectId, citations, dimensionLabel, onChange }: { projectId: string; citations: StandardCitation[]; dimensionLabel: string; onChange: (citations: StandardCitation[]) => void }) {
  const [sourceId, setSourceId] = useState('');
  const [fragmentId, setFragmentId] = useState('');
  const [quote, setQuote] = useState('');
  const [open, setOpen] = useState(false);
  const sources = useQuery({ queryKey: ['sources', projectId], queryFn: () => listAllItems<'SourceListResponse'>(projectPath(projectId, '/sources'), { limit: 100 }, { requireNextCursor: true }), enabled: open });
  const source = sources.data?.find(item => item.sourceId === sourceId);
  const fragments = useQuery({ queryKey: ['sourceFragments', projectId, source?.currentVersionId], queryFn: () => listAllItems<'SourceFragmentListResponse'>(projectPath(projectId, `/sources/${encodeURIComponent(sourceId)}/versions/${encodeURIComponent(source!.currentVersionId!)}/fragments`)), enabled: open && Boolean(source?.currentVersionId) });
  const fragment = fragments.data?.find(item => item.fragmentId === fragmentId);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>来源引用（{citations.length} 条）</summary>{citations.map((citation, index) => <div key={index}><p>[{index+1}] {citation.fileName??citation.sourceTitle??''}</p><button className="button button-quiet button-small" type="button" onClick={() => onChange(citations.filter((_, current) => current !== index))}>移除此引用</button></div>)}<Field label="引用资料"><select className="input" value={sourceId} onChange={event => { setSourceId(event.target.value); setFragmentId(''); setQuote(''); }}><option value="">选择导入资料的固定原文</option>{sources.data?.map(item => <option key={item.sourceId} value={item.sourceId}>{item.title}</option>)}</select></Field>{sources.error && <ErrorNotice error={sources.error} />}{fragments.error && <ErrorNotice error={fragments.error} />}{source && <Field label="原文片段"><select className="input" value={fragmentId} onChange={event => { setFragmentId(event.target.value); setQuote(''); }}><option value="">选择原文片段</option>{fragments.data?.map((item,index) => <option key={item.fragmentId} value={item.fragmentId}>{item.pageNumber ? `第 ${item.pageNumber} 页` : '正文'} · 片段 {index+1}</option>)}</select></Field>}{fragment && <><Field label="评分项原文" hint="最多 2000 字，必须是上方原文中的连续节选。"><textarea className="input" rows={4} maxLength={2000} value={quote} onChange={event => setQuote(event.target.value)} /></Field></>}<button type="button" className="button button-quiet" disabled={!fragment || !quote.trim() || !fragment.content.includes(quote.trim()) || !quote.includes(dimensionLabel) || !/[0-9]+(?:\.[0-9]+)?\s*(?:%|％|分|点)/.test(quote) || !source?.currentVersionId || citations.length >= 10} onClick={() => { if (fragment && source?.currentVersionId) onChange([...citations, { sourceVersionId: source.currentVersionId, fragmentId: fragment.fragmentId, pageNumber: fragment.pageNumber, quote: quote.trim(),sourceId:sourceId,sourceTitle:source.title,fileName:source.title,fileId:source.fileId??null }]); }}>添加此原文引用</button></details>;
}
