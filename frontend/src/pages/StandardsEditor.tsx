import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { ApiError, listAllItems, projectPath } from '../api/client';
import { projectRequest, type StandardCitation, type StandardRequirement, type StandardVersion } from '../api/simplification';
import { useProject } from '../components/ProjectShell';
import { EmptyState, ErrorNotice, Field, SectionCard, Spinner, StatusPill } from '../components/ui';
import { DateInput } from '../components/DateInput';
import { idempotencyKeyForIntent, completeIntent, useVisibleJobPoller, readPendingJob, writePendingJob, clearPendingJob } from './aiWorkflowSupport';
import { useSettingsDirty } from './settings-dirty';

type EditorRow = { key: string; requirementId?: string; standalone?: boolean; title: string; detail: string; category: StandardRequirement['category']; dueDate: string; duePrecision: 'date' | 'datetime' | 'unknown'; originalDueDate?: string | null; scored: boolean; dimensionKey: string; dimensionLabel: string; weight: string; citations: StandardCitation[] };
type EditorDraft = { title: string; rows: EditorRow[]; notes: string };
type GeneratedDraft = {title:string;notes:string;requirements:Array<{title:string;detail:string;category:EditorRow['category'];dimensionKey?:string;dueDate:string|null;duePrecision:EditorRow['duePrecision']}>;weights:Array<{key:string;label:string;weight:number}>};
function fromGenerated(value:GeneratedDraft):EditorDraft {
  const mapped=new Set(value.requirements.map(r=>r.dimensionKey));
  const rows=value.requirements.map(r=>{const weight=value.weights.find(w=>w.key===r.dimensionKey);return {...newRow(),...r,dueDate:r.dueDate?.slice(0,10)??'',originalDueDate:r.dueDate,dimensionKey:r.dimensionKey??'',scored:Boolean(weight),dimensionLabel:weight?.label??'',weight:weight?String(weight.weight):''};});
  return {title:value.title,notes:value.notes,rows:[...rows,...value.weights.filter(w=>!mapped.has(w.key)).map(w=>({...newRow(),standalone:true,title:w.label,category:'scoring' as const,scored:true,dimensionKey:w.key,dimensionLabel:w.label,weight:String(w.weight)}))]};
}
const categoryLabels = { deadline: '截止日期', deliverable: '交付成果', format: '格式', scoring: '评分', team: '团队', other: '其他' };
const newRow = (): EditorRow => ({ key: crypto.randomUUID(), title: '', detail: '', category: 'deliverable', dueDate: '', duePrecision: 'unknown', scored: false, dimensionKey: '', dimensionLabel: '', weight: '', citations: [] });
function fromVersion(version: StandardVersion): EditorDraft {
  const mappedKeys = new Set(version.mappings.map(mapping => mapping.dimensionKey));
  const rows = version.requirements.map(requirement => {
    const dimensionKey = version.mappings.find(mapping => mapping.requirementId === requirement.requirementId)?.dimensionKey ?? '';
    const dimension = version.rubric.weights.find(weight => weight.key === dimensionKey);
    return { ...newRow(), ...requirement, dueDate: requirement.dueDate?.slice(0, 10) ?? '', originalDueDate: requirement.dueDate, duePrecision: requirement.duePrecision ?? 'unknown', scored: Boolean(dimension), dimensionKey, dimensionLabel: dimension?.label ?? '', weight: dimension ? String(dimension.weight) : '', citations: requirement.citations ?? [] };
  });
  const independentDimensions = version.rubric.weights.filter(weight => !mappedKeys.has(weight.key)).map(weight => ({ ...newRow(), standalone: true, title: weight.label, category: 'scoring' as const, scored: true, dimensionKey: weight.key, dimensionLabel: weight.label, weight: String(weight.weight) }));
  return { title: version.title, notes: version.rubric.notes ?? '', rows: [...rows, ...independentDimensions] };
}
export function StandardsEditor() {
  const { projectId } = useProject();
  return <ProjectStandardsEditor key={projectId} />;
}
function ProjectStandardsEditor() {
  const { projectId, project } = useProject();
  const client = useQueryClient();
  const versions = useQuery({ queryKey: ['standards', projectId], queryFn: () => projectRequest<{ items: StandardVersion[] }>(projectId, '/standards') });
  const sets = useQuery({ queryKey: ['requirementSets', projectId], queryFn: () => listAllItems<'RequirementSetListResponse'>(projectPath(projectId, '/requirement-sets'), { limit: 100 }) });
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const current = useQuery({ queryKey: ['current-standard', projectId], queryFn: () => projectRequest<{ standard: StandardVersion | null }>(projectId, '/standards/current') });
  const [setId, setSetId] = useState('');
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
      const result=job.result as {draft?:GeneratedDraft}|null;
      if(result?.draft){setDraft(fromGenerated(result.draft));setConflicted(false);setValidationError(null);}
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
    if (!draft.title.trim() || draft.rows.length === 0 || draft.rows.some(row => !row.title.trim())) throw new Error('请填写标准名称及每一条要求标题。');
    if (weights.some(weight => !weight.key || !weight.label || !Number.isFinite(weight.weight) || weight.weight < 0 || weight.weight > 100) || draft.rows.some(row => row.scored && !row.weight.trim())) throw new Error('评分维度需要唯一标识、名称和 0–100 的权重。');
    const unique = new Map<string, typeof weights[number]>();
    for (const weight of weights) { const previous = unique.get(weight.key); if (previous && (previous.weight !== weight.weight || previous.label !== weight.label)) throw new Error('同一个评分维度的名称和权重必须一致。'); unique.set(weight.key, weight); }
    if (unique.size > 10) throw new Error('每份标准最多包含 10 个不同评分维度；其他要求可保留为检查项。');
    const body = { title: draft.title.trim(), requirements: draft.rows.filter(row => !row.standalone).map(row => ({ ...(row.requirementId ? { requirementId: row.requirementId } : {}), title: row.title.trim(), detail: row.detail.trim(), category: row.category, dueDate: row.duePrecision === 'datetime' ? row.originalDueDate ?? null : row.dueDate || null, duePrecision: row.duePrecision, citations: row.citations.map(({ sourceVersionId, fragmentId, pageNumber, quote }) => ({ sourceVersionId, fragmentId, pageNumber, quote })), ...(row.scored ? { dimensionKey: row.dimensionKey.trim() } : {}) })), weights: [...unique.values()], notes: draft.notes.trim() };
    const tail = '/standards';
    const namespace = `standards-save:${projectId}:new`;
    const idempotencyKey = await idempotencyKeyForIntent(namespace, body);
    const result = await projectRequest<StandardVersion>(projectId, tail, { method: 'POST', body, idempotencyKey }); completeIntent(namespace); return result;
  }, onSuccess: async () => { setDraft(null); setConflicted(false); setValidationError(null); await invalidate(); }, onError: async error => { if (error instanceof ApiError && error.status === 409) { setConflicted(true); await invalidate(); } } });
  const update = (key: string, patch: Partial<EditorRow>) => setDraft(current => current ? { ...current, rows: current.rows.map(row => row.key === key ? { ...row, ...patch } : row) } : current);
  const importSet = async () => {
    if (!draft || !setId) return;
    setValidationError(null);
    try {
      const set = await projectRequest<{ requirements: StandardRequirement[] }>(projectId, `/requirement-sets/${encodeURIComponent(setId)}`);
      setDraft(current => current ? { ...current, rows: [...current.rows.filter(row => row.title.trim()), ...set.requirements.map(requirement => ({ ...newRow(), ...requirement, dueDate: requirement.dueDate?.slice(0, 10) ?? '', originalDueDate: requirement.dueDate, duePrecision: requirement.duePrecision ?? 'unknown', citations: requirement.citations ?? [] }))] } : current);
    } catch (error) { setValidationError(error); }
  };
  return <div className="page-stack">
    <SectionCard title="项目标准" detail="每条要求可选关联评分维度与权重；未计分要求保留为检查项。最新保存版本立即生效，历史标准仅供查看。" action={project.myRole === 'owner' && !draft ? <div className="form-actions"><button className="button button-quiet" disabled={generating} onClick={()=>generate.mutate()}>AI 生成标准</button><button className="button button-primary" disabled={generating} onClick={() => { setDraft({ title: '项目标准', rows: [newRow()], notes: '' }); setConflicted(false); save.reset(); }}><Plus size={16} />新建标准</button></div> : undefined}>
      {generating && <Spinner label="生成项目标准" />}{generate.error && <ErrorNotice error={generate.error} />}{generationPoll.error !== null && <ErrorNotice error={generationPoll.error} />}{!draft && validationError !== null && <ErrorNotice error={validationError} />}
      {current.isLoading && <Spinner label="读取标准版本" />}{current.error && <ErrorNotice error={current.error} onRetry={() => void current.refetch()} />}
      {draft ? <form className="stack standards-form" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
        <Field label="标准名称"><input className="input" required maxLength={200} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></Field>
        <div className="form-actions"><Field label="导入已提取的要求"><select className="input" value={setId} onChange={event => setSetId(event.target.value)}><option value="">选择要求草稿或历史要求集</option>{sets.data?.map(set => <option key={set.requirementSetId} value={set.requirementSetId}>{set.status === 'confirmed' ? '已确认' : '草稿'} · {set.requirements.length} 条 · {set.requirementSetId.slice(0, 8)}</option>)}</select></Field><button type="button" className="button button-quiet" disabled={!setId} onClick={() => void importSet()}>导入到标准草稿</button></div>
        {draft.rows.map((row, index) => <fieldset key={row.key} className="standard-editor-row"><legend>要求 {index + 1}</legend><Field label={`要求 ${index + 1} 标题`}><input className="input" required maxLength={200} value={row.title} onChange={event => update(row.key, { title: event.target.value })} /></Field><Field label={`要求 ${index + 1} 说明`}><textarea className="input" rows={3} maxLength={2000} value={row.detail} onChange={event => update(row.key, { detail: event.target.value })} /></Field><div className="form-grid-two"><Field label="要求分类"><select className="input" value={row.category} onChange={event => update(row.key, { category: event.target.value as EditorRow['category'] })}>{Object.entries(categoryLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><Field label="要求截止日期"><DateInput type="date" className="input" value={row.dueDate} onChange={event => update(row.key, { dueDate: event.target.value, duePrecision: event.target.value ? 'date' : 'unknown' })} /></Field></div>{row.duePrecision === 'datetime' && <p className="form-note">原文明确到时刻：{row.originalDueDate}；未调整日期时保留原值。</p>}<label className="profile-toggle"><input type="checkbox" checked={row.scored} onChange={event => update(row.key, { scored: event.target.checked, dimensionKey: row.dimensionKey || `criterion_${row.key.replace(/-/g, '').slice(0, 20)}`, dimensionLabel: row.dimensionLabel || row.title })} />此要求参与评分</label>{row.scored && <div className="standard-dimension-fields"><Field label="评分维度名称"><input className="input" maxLength={60} value={row.dimensionLabel} onChange={event => update(row.key, { dimensionLabel: event.target.value })} /></Field><Field label="评分权重（%）"><input className="input" type="number" min="0" max="100" step="any" value={row.weight} onChange={event => update(row.key, { weight: event.target.value })} /></Field></div>}
          <SourceCitationPicker projectId={projectId} citations={row.citations} onChange={citations => update(row.key, { citations })} />
          <button type="button" className="button button-quiet button-small" disabled={draft.rows.length <= 1} onClick={() => setDraft({ ...draft, rows: draft.rows.filter(value => value.key !== row.key) })}><Trash2 size={14} />移除这条要求</button>
        </fieldset>)}
        <button className="button button-quiet" type="button" disabled={draft.rows.length >= 100} onClick={() => setDraft({ ...draft, rows: [...draft.rows, newRow()] })}><Plus size={16} />添加要求或评分项</button>
        <Field label="标准说明"><textarea className="input" maxLength={2000} rows={3} value={draft.notes} onChange={event => setDraft({ ...draft, notes: event.target.value })} /></Field>
        {conflicted && <div className="notice notice-warn">标准草稿已更新，本地编辑保留。请核对最新版本；也可另存为新草稿。<button className="button button-quiet" type="button" onClick={() => { setDraft({ ...draft }); setConflicted(false); save.reset(); }}>另存并生效</button></div>}
        {validationError !== null && <ErrorNotice error={validationError} />}{save.error && <ErrorNotice error={save.error} />}
        <div className="form-actions"><button className="button button-primary" disabled={save.isPending || conflicted}>保存并生效</button><button className="button button-quiet" type="button" onClick={() => setDraft(null)}>取消编辑</button></div>
      </form> : <>
        {selected ? <article className="stack"><h3>{selected.title} <StatusPill tone={'good'}>{`生效标准 v${selected.version}`}</StatusPill></h3>{selected.requirements.map(requirement => { const dimension = selected.rubric.weights.find(weight => weight.key === selected.mappings.find(mapping => mapping.requirementId === requirement.requirementId)?.dimensionKey); return <div className="standard-read-row" key={requirement.requirementId}><strong>{requirement.title}</strong><p>{requirement.detail}</p>{requirement.dueDate && <small>截止：{requirement.dueDate}</small>}<p>{dimension ? `${dimension.label} · 权重 ${dimension.weight}%` : '检查项 · 不计分'}</p>{requirement.citations.map((citation, index) => <blockquote className="quote-box" key={index}>原文依据：{citation.quote}{citation.availability === 'unavailable' && '（原始来源不可用 · 历史引文保留）'}{citation.pageNumber ? `（第 ${citation.pageNumber} 页）` : ''}</blockquote>)}</div>; })}{selected.rubric.weights.filter(weight => !selected.mappings.some(mapping => mapping.dimensionKey === weight.key)).map(weight => <p key={weight.key}>{weight.label} · 权重 {weight.weight}%</p>)}{selected.rubric.notes && <p>{selected.rubric.notes}</p>}{project.myRole === 'owner' && <div className="form-actions"><button className="button button-quiet" disabled={generating} onClick={() => { setDraft(fromVersion(selected)); setConflicted(false); save.reset(); }}>修订生效标准</button></div>}</article> : !current.isLoading && !current.error && <EmptyState title="尚未建立统一标准" detail="将要求与评分维度放入同一标准；可以从已提取要求开始。" />}
        <details><summary>历史标准（只读）</summary>{versions.data?.items.filter(version => version.standardsVersionId !== selected?.standardsVersionId).map(version => <article className="standard-read-row" key={version.standardsVersionId}><h3>{version.title} · v{version.version}</h3>{version.requirements.map(requirement => <p key={requirement.requirementId}><strong>{requirement.title}</strong>：{requirement.detail}{requirement.citations.map((citation, index) => <span key={index}> · 原文依据：{citation.quote}</span>)}</p>)}{version.rubric.weights.map(weight => <p key={weight.key}>{weight.label} · {weight.weight}%</p>)}<p>{version.rubric.notes}</p></article>)}</details>
      </>}
    </SectionCard>
  </div>;
}

function SourceCitationPicker({ projectId, citations, onChange }: { projectId: string; citations: StandardCitation[]; onChange: (citations: StandardCitation[]) => void }) {
  const [sourceId, setSourceId] = useState('');
  const [fragmentId, setFragmentId] = useState('');
  const [quote, setQuote] = useState('');
  const [open, setOpen] = useState(false);
  const sources = useQuery({ queryKey: ['sources', projectId], queryFn: () => listAllItems<'SourceListResponse'>(projectPath(projectId, '/sources'), { limit: 100 }, { requireNextCursor: true }), enabled: open });
  const source = sources.data?.find(item => item.sourceId === sourceId);
  const fragments = useQuery({ queryKey: ['sourceFragments', projectId, source?.currentVersionId], queryFn: () => listAllItems<'SourceFragmentListResponse'>(projectPath(projectId, `/sources/${encodeURIComponent(sourceId)}/versions/${encodeURIComponent(source!.currentVersionId!)}/fragments`)), enabled: open && Boolean(source?.currentVersionId) });
  const fragment = fragments.data?.find(item => item.fragmentId === fragmentId);
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>来源引用（{citations.length} 条）</summary>{citations.map((citation, index) => <div key={index}><blockquote className="quote-box">{citation.quote}</blockquote><small>固定来源 {citation.sourceVersionId}{citation.pageNumber ? ` · 第 ${citation.pageNumber} 页` : ''}</small><button className="button button-quiet button-small" type="button" onClick={() => onChange(citations.filter((_, current) => current !== index))}>移除此引用</button></div>)}<Field label="引用资料"><select className="input" value={sourceId} onChange={event => { setSourceId(event.target.value); setFragmentId(''); setQuote(''); }}><option value="">选择导入资料的固定原文</option>{sources.data?.map(item => <option key={item.sourceId} value={item.sourceId}>{item.title}</option>)}</select></Field>{sources.error && <ErrorNotice error={sources.error} />}{fragments.error && <ErrorNotice error={fragments.error} />}{source && <Field label="原文片段"><select className="input" value={fragmentId} onChange={event => { setFragmentId(event.target.value); setQuote(fragments.data?.find(item => item.fragmentId === event.target.value)?.content.slice(0, 2000) ?? ''); }}><option value="">选择原文片段</option>{fragments.data?.map(item => <option key={item.fragmentId} value={item.fragmentId}>{item.pageNumber ? `第 ${item.pageNumber} 页` : '正文'} · {item.content.slice(0, 80)}</option>)}</select></Field>}{fragment && <><blockquote className="quote-box">{fragment.content}</blockquote><Field label="引用原句（可节选）" hint="最多 2000 字，必须是上方原文中的连续节选。"><textarea className="input" rows={4} maxLength={2000} value={quote} onChange={event => setQuote(event.target.value)} /></Field></>}<button type="button" className="button button-quiet" disabled={!fragment || !quote.trim() || !fragment.content.includes(quote.trim()) || !source?.currentVersionId || citations.length >= 10} onClick={() => { if (fragment && source?.currentVersionId) onChange([...citations, { sourceVersionId: source.currentVersionId, fragmentId: fragment.fragmentId, pageNumber: fragment.pageNumber, quote: quote.trim() }]); }}>添加此原文引用</button></details>;
}
