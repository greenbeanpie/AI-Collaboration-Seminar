import { DateInput } from '../components/DateInput';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, ExternalLink, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import { api, projectPath, listAllItems } from '../api/client';
import type { DataOf } from '../api/types';
import { ConfirmButton, EmptyState, ErrorNotice, Field, PageHeading, SectionCard, Spinner, StatusPill } from '../components/ui';
import { useProject } from '../components/ProjectShell';
import { createIntentKey, listAllProjectItems } from './source-workflows';
import './RequirementsPage.css';

type RequirementSet = DataOf<'RequirementSetResponse'>;
type Requirement = RequirementSet['requirements'][number];
type RequirementSetSummary = DataOf<'RequirementSetListResponse'>['items'][number];
type Rubric = DataOf<'RubricResponse'>;
type RubricWeight = Rubric['weights'][number];
type Source = DataOf<'SourceListResponse'>['items'][number];
type Category = Requirement['category'];
type DuePrecision = Requirement['duePrecision'];
type RequirementDraft = Pick<Requirement, 'title' | 'detail' | 'category' | 'duePrecision'> & {
  dueDate: string;
  originalDueDate: string | null;
  dueDateChanged: boolean;
};
type RubricDraft = { source: Rubric['source'] | ''; weights: Array<{ key: string; label: string; weight: string }>; notes: string };

const categoryLabels: Record<Category, string> = {
  deadline: '截止时间',
  deliverable: '提交成果',
  format: '格式要求',
  scoring: '评分规则',
  team: '团队要求',
  other: '其他要求',
};

const precisionLabels: Record<DuePrecision, string> = {
  date: '日期明确',
  datetime: '原文明确到时刻',
  unknown: '时间精度未确认',
};

function newRubricDraft(): RubricDraft {
  return { source: '', weights: [{ key: '', label: '', weight: '' }], notes: '' };
}

function toRubricDraft(rubric: Rubric): RubricDraft {
  return {
    source: rubric.source,
    weights: rubric.weights.map((weight) => ({ key: weight.key, label: weight.label, weight: String(weight.weight) })),
    notes: rubric.notes ?? '',
  };
}

function formatDate(value: string | null): string {
  if (!value) return '未记录截止日期';
  return value.slice(0, 10);
}

function RequirementEditor({
  requirement,
  onCancel,
  onSave,
  busy,
  error,
}: {
  requirement: Requirement;
  onCancel: () => void;
  onSave: (draft: RequirementDraft) => void;
  busy: boolean;
  error: unknown;
}) {
  const [draft, setDraft] = useState<RequirementDraft>(() => ({
    title: requirement.title,
    detail: requirement.detail,
    category: requirement.category,
    dueDate: requirement.dueDate?.slice(0, 10) ?? '',
    originalDueDate: requirement.dueDate,
    dueDateChanged: false,
    duePrecision: requirement.duePrecision,
  }));
  return <form className="requirements-edit-form" onSubmit={(event) => { event.preventDefault(); onSave(draft); }}>
    <Field label="要求标题"><input className="input" value={draft.title} maxLength={200} required onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></Field>
    <Field label="详细说明"><textarea className="input textarea" rows={4} maxLength={2000} value={draft.detail} onChange={(event) => setDraft({ ...draft, detail: event.target.value })} /></Field>
    <div className="form-grid-two">
      <Field label="分类"><select className="input" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as Category })}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="截止日期" hint="此页面只编辑日期；若原文明确具体时刻，请保留在要求说明中。"><DateInput className="input" type="date" value={draft.dueDate} onChange={(event) => { const dueDate = event.target.value; setDraft({ ...draft, dueDate, dueDateChanged: true, duePrecision: dueDate ? 'date' : 'unknown' }); }} /></Field>
    </div>
    <Field label="时间精度" hint="当前页面只记录日期，不提供时刻编辑。"><div className="form-note">{precisionLabels[draft.duePrecision]}{draft.duePrecision === 'datetime' && !draft.dueDateChanged ? ' · 服务端原值会在日期未改动时保留' : ''}</div></Field>
    <div className="callout">若原文未给出日期，请保留为空；若确知具体时刻，可写入要求说明。不要推测补全。</div>
    {error ? <ErrorNotice error={error} /> : null}
    <div className="form-actions"><button className="button button-primary button-small" type="submit" disabled={busy}><Save size={14} /> {busy ? '正在保存' : '保存修改'}</button><button className="button button-quiet button-small" type="button" onClick={onCancel} disabled={busy}>取消</button></div>
  </form>;
}

function CitationCard({ citation, sourceTitle, sourceId }: { citation: Requirement['citations'][number]; sourceTitle?: string; sourceId?: string }) {
  const { projectId } = useProject();
  const pageQuery = citation.pageNumber ? `&page=${citation.pageNumber}` : '';
  const hash = sourceId
    ? citation.pageNumber ? `#source-page-${encodeURIComponent(sourceId)}-${citation.pageNumber}` : `#source-${encodeURIComponent(sourceId)}`
    : '';
  const link = `/app/projects/${projectId}/sources?sourceVersionId=${encodeURIComponent(citation.sourceVersionId)}${pageQuery}&fragmentId=${encodeURIComponent(citation.fragmentId)}${hash}`;
  return <div className="requirements-citation">
    <div className="requirements-citation-head"><span>{sourceTitle ?? `来源版本 ${citation.sourceVersionId.slice(0, 8)}`}{citation.pageNumber ? ` · 第 ${citation.pageNumber} 页` : ' · 网页或文字片段'}</span><Link className="button-link" to={link}>查看来源 <ExternalLink size={12} /></Link></div>
    <blockquote className="quote-box">{citation.quote}</blockquote>
  </div>;
}

function RubricEditor({
  draft,
  onChange,
  onCancel,
  onSave,
  busy,
  error,
  isNew,
}: {
  draft: RubricDraft;
  onChange: (value: RubricDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
  error: unknown;
  isNew: boolean;
}) {
  const total = draft.weights.reduce((sum, weight) => sum + (Number(weight.weight) || 0), 0);
  const updateWeight = (index: number, patch: Partial<RubricDraft['weights'][number]>) => onChange({ ...draft, weights: draft.weights.map((weight, current) => current === index ? { ...weight, ...patch } : weight) });
  return <div className="requirements-rubric-form">
    <div className="form-grid-two">
      <Field label="规则来源"><select className="input" value={draft.source} disabled={!isNew} onChange={(event) => onChange({ ...draft, source: event.target.value as RubricDraft['source'] })}>{isNew && <option value="">请选择来源</option>}<option value="official">官方规则</option><option value="custom">自拟细则</option></select></Field>
      <div className="requirements-rubric-total">当前权重合计：{total}% · 请以来源原文核对。API 不强制合计为 100%。</div>
    </div>
    <div className="stack">
      {draft.weights.map((weight, index) => <div className="requirements-rubric-row" key={`${index}:${weight.key}`}>
        <Field label="字段键"><input className="input input-sm" value={weight.key} maxLength={40} onChange={(event) => updateWeight(index, { key: event.target.value })} placeholder="唯一标识" /></Field>
        <Field label="评分项"><input className="input input-sm" value={weight.label} maxLength={60} onChange={(event) => updateWeight(index, { label: event.target.value })} placeholder="原文中的评分项" /></Field>
        <Field label="权重（%）"><input className="input input-sm" type="number" min={0} max={100} step="any" value={weight.weight} onChange={(event) => updateWeight(index, { weight: event.target.value })} placeholder="0–100" /></Field>
        <button className="icon-button requirements-row-remove" type="button" aria-label={`移除评分项 ${index + 1}`} disabled={draft.weights.length <= 1} onClick={() => onChange({ ...draft, weights: draft.weights.filter((_, current) => current !== index) })}><Trash2 size={15} /></button>
      </div>)}
    </div>
    <div className="form-actions"><button className="button button-quiet button-small" type="button" disabled={draft.weights.length >= 10} onClick={() => onChange({ ...draft, weights: [...draft.weights, { key: '', label: '', weight: '' }] })}><Plus size={14} /> 添加评分项</button></div>
    <Field label="说明（可选）" hint="自拟细则应标注为自拟，并说明信息来源。"><textarea className="input textarea" rows={3} maxLength={2000} value={draft.notes} onChange={(event) => onChange({ ...draft, notes: event.target.value })} /></Field>
    {error ? <ErrorNotice error={error} /> : null}
    <div className="form-actions"><button className="button button-primary button-small" type="button" disabled={busy} onClick={onSave}><Save size={14} /> {busy ? '正在保存' : isNew ? '创建草稿' : '保存评分标准'}</button><button className="button button-quiet button-small" type="button" disabled={busy} onClick={onCancel}>取消</button></div>
  </div>;
}

export function RequirementsPage() {
  const { projectId, project } = useProject();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const setFromUrl = searchParams.get('setId');
  const [selectedRubricId, setSelectedRubricId] = useState<string | null>(null);
  const [editingRequirementId, setEditingRequirementId] = useState<string | null>(null);
  const [savingRequirementId, setSavingRequirementId] = useState<string | null>(null);
  const [requirementError, setRequirementError] = useState<unknown>(null);
  const [confirmingSet, setConfirmingSet] = useState(false);
  const [setActionError, setSetActionError] = useState<unknown>(null);
  const [rubricMode, setRubricMode] = useState<'create' | 'edit' | null>(null);
  const [rubricDraft, setRubricDraft] = useState<RubricDraft>(newRubricDraft);
  const [rubricSaving, setRubricSaving] = useState(false);
  const [rubricError, setRubricError] = useState<unknown>(null);
  const [confirmingRubricId, setConfirmingRubricId] = useState<string | null>(null);
  const [rubricConfirmError, setRubricConfirmError] = useState<unknown>(null);
  const previousProjectId = useRef(projectId);
  const editIntentKeys = useRef(new Map<string, string>());
  const requirementConfirmKeys = useRef(new Map<string, string>());
  const rubricCreateIntentKeys = useRef(new Map<string, string>());
  const rubricEditIntentKeys = useRef(new Map<string, string>());
  const rubricConfirmKeys = useRef(new Map<string, string>());

  const setQuery = useQuery({ queryKey: ['requirementSets', projectId], queryFn: ({ signal }) => listAllItems<'RequirementSetListResponse'>(projectPath(projectId, '/requirement-sets'), {}, { signal }) });
  const sets = useMemo(() => setQuery.data ?? [], [setQuery.data]);
  const selectedSetId = (setFromUrl && sets.some((set) => set.requirementSetId === setFromUrl)) ? setFromUrl : sets[0]?.requirementSetId ?? null;
  const detailQuery = useQuery({
    queryKey: ['requirementSet', projectId, selectedSetId],
    queryFn: () => api.get<'RequirementSetResponse'>(projectPath(projectId, `/requirement-sets/${encodeURIComponent(selectedSetId!)}`)),
    enabled: Boolean(selectedSetId),
  });
  const rubricQuery = useQuery({ queryKey: ['rubrics', projectId], queryFn: ({ signal }) => listAllItems<'RubricListResponse'>(projectPath(projectId, '/rubrics'), {}, { signal }) });
  const capabilityQuery = useQuery({ queryKey: ['capabilities'], queryFn: () => api.get<'CapabilitiesResponse'>('/api/v1/capabilities') });
  const sourceQuery = useQuery({
    queryKey: ['sources', projectId],
    queryFn: ({ signal }) => listAllProjectItems<'SourceListResponse'>(projectId, '/sources', capabilityQuery.data!.limits.listMaxPageSize, signal),
    enabled: Boolean(capabilityQuery.data),
  });
  const sourcesByVersion = useMemo(() => {
    const map = new Map<string, Source>();
    for (const source of sourceQuery.data ?? []) if (source.currentVersionId) map.set(source.currentVersionId, source);
    return map;
  }, [sourceQuery.data]);
  const rubrics = useMemo(() => rubricQuery.data ?? [], [rubricQuery.data]);
  const selectedRubricIdResolved = selectedRubricId && rubrics.some((rubric) => rubric.rubricId === selectedRubricId) ? selectedRubricId : rubrics[0]?.rubricId ?? null;

  useEffect(() => {
    if (setFromUrl && !sets.some((set) => set.requirementSetId === setFromUrl) && setQuery.isSuccess && sets.length) {
      setSearchParams({ setId: sets[0]!.requirementSetId }, { replace: true });
    }
  }, [setFromUrl, sets, setQuery.isSuccess, setSearchParams]);

  useEffect(() => {
    setEditingRequirementId(null);
    setRequirementError(null);
    setSetActionError(null);
  }, [selectedSetId]);

  useEffect(() => {
    if (previousProjectId.current === projectId) return;
    previousProjectId.current = projectId;
    setSelectedRubricId(null);
    setRubricMode(null);
    setRubricDraft(newRubricDraft());
    setRubricError(null);
    setRubricConfirmError(null);
    setSetActionError(null);
    setRequirementError(null);
    setEditingRequirementId(null);
    editIntentKeys.current.clear();
    requirementConfirmKeys.current.clear();
    rubricEditIntentKeys.current.clear();
    rubricConfirmKeys.current.clear();
    rubricCreateIntentKeys.current.clear();
  }, [projectId]);

  useEffect(() => {
    if (!selectedRubricId && rubrics[0]) setSelectedRubricId(rubrics[0].rubricId);
  }, [rubrics, selectedRubricId]);

  const setIntentKey = (map: Map<string, string>, key: string) => {
    const existing = map.get(key);
    if (existing) return existing;
    const created = createIntentKey();
    map.set(key, created);
    return created;
  };

  const saveRequirement = async (requirement: Requirement, draft: RequirementDraft) => {
    setRequirementError(null);
    setSavingRequirementId(requirement.requirementId);
    try {
      const body = {
        title: draft.title.trim(),
        detail: draft.detail.trim(),
        category: draft.category,
        dueDate: draft.dueDateChanged ? draft.dueDate || null : draft.originalDueDate,
        duePrecision: draft.dueDateChanged ? draft.dueDate ? 'date' : 'unknown' : draft.duePrecision,
      };
      const intentId = `${requirement.requirementId}:${JSON.stringify(body)}`;
      await api.patch<'RequirementResponse'>(projectPath(projectId, `/requirements/${encodeURIComponent(requirement.requirementId)}`), body, { idempotencyKey: setIntentKey(editIntentKeys.current, intentId) });
      editIntentKeys.current.delete(intentId);
      setEditingRequirementId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['requirementSet', projectId, selectedSetId] }),
        queryClient.invalidateQueries({ queryKey: ['requirementSets', projectId] }),
      ]);
    } catch (error) {
      setRequirementError(error);
    } finally {
      setSavingRequirementId(null);
    }
  };

  const confirmSet = async (setId: string) => {
    setConfirmingSet(true);
    setSetActionError(null);
    try {
      await api.post<'RequirementSetResponse'>(projectPath(projectId, `/requirement-sets/${encodeURIComponent(setId)}/confirm`), undefined, { idempotencyKey: setIntentKey(requirementConfirmKeys.current, setId) });
      requirementConfirmKeys.current.delete(setId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['requirementSet', projectId, setId] }),
        queryClient.invalidateQueries({ queryKey: ['requirementSets', projectId] }),
      ]);
    } catch (error) {
      setSetActionError(error);
    } finally {
      setConfirmingSet(false);
    }
  };

  const startCreateRubric = () => {
    setRubricMode('create');
    setRubricDraft(newRubricDraft());
    setRubricError(null);
  };

  const startEditRubric = (rubric: Rubric) => {
    setSelectedRubricId(rubric.rubricId);
    setRubricMode('edit');
    setRubricDraft(toRubricDraft(rubric));
    setRubricError(null);
  };

  const saveRubric = async () => {
    setRubricError(null);
    const sourceType = rubricDraft.source === 'official' || rubricDraft.source === 'custom' ? rubricDraft.source : null;
    if (rubricMode === 'create' && !sourceType) {
      setRubricError(new Error('请选择官方规则或自拟细则。'));
      return;
    }
    if (rubricDraft.weights.length < 1 || rubricDraft.weights.length > 10) {
      setRubricError(new Error('每个评分版本至少需要 1 项，最多 10 项。'));
      return;
    }
    const weights: RubricWeight[] = [];
    for (const [index, item] of rubricDraft.weights.entries()) {
      const key = item.key.trim();
      const label = item.label.trim();
      const weight = Number(item.weight);
      if (!key || !label || !item.weight.trim() || !Number.isFinite(weight) || weight < 0 || weight > 100) {
        setRubricError(new Error(`第 ${index + 1} 项请填写字段键、评分项，并输入 0–100 的权重。`));
        return;
      }
      if (weights.some((entry) => entry.key === key)) {
        setRubricError(new Error(`字段键“${key}”重复，请为每项设置不同的键。`));
        return;
      }
      weights.push({ key, label, weight });
    }
    setRubricSaving(true);
    try {
      if (rubricMode === 'create') {
        const body = {
          source: sourceType!,
          weights,
          ...(rubricDraft.notes.trim() ? { notes: rubricDraft.notes.trim() } : {}),
        };
        const intentId = JSON.stringify(body);
        const rubric = await api.post<'RubricResponse'>(projectPath(projectId, '/rubrics'), body, { idempotencyKey: setIntentKey(rubricCreateIntentKeys.current, intentId) });
        rubricCreateIntentKeys.current.delete(intentId);
        setSelectedRubricId(rubric.rubricId);
      } else if (rubricMode === 'edit' && selectedRubricIdResolved) {
        const body = {
          weights,
          notes: rubricDraft.notes.trim() || null,
        };
        const intentId = `${selectedRubricIdResolved}:${JSON.stringify(body)}`;
        await api.patch<'RubricResponse'>(projectPath(projectId, `/rubrics/${encodeURIComponent(selectedRubricIdResolved)}`), body, { idempotencyKey: setIntentKey(rubricEditIntentKeys.current, intentId) });
        rubricEditIntentKeys.current.delete(intentId);
      }
      setRubricMode(null);
      await queryClient.invalidateQueries({ queryKey: ['rubrics', projectId] });
    } catch (error) {
      setRubricError(error);
    } finally {
      setRubricSaving(false);
    }
  };

  const confirmRubric = async (rubricId: string) => {
    setConfirmingRubricId(rubricId);
    setRubricConfirmError(null);
    try {
      await api.post<'RubricResponse'>(projectPath(projectId, `/rubrics/${encodeURIComponent(rubricId)}/confirm`), undefined, { idempotencyKey: setIntentKey(rubricConfirmKeys.current, rubricId) });
      rubricConfirmKeys.current.delete(rubricId);
      await queryClient.invalidateQueries({ queryKey: ['rubrics', projectId] });
    } catch (error) {
      setRubricConfirmError(error);
    } finally {
      setConfirmingRubricId(null);
    }
  };

  const activeSet: RequirementSetSummary | undefined = sets.find((set) => set.requirementSetId === selectedSetId);
  const setDetail = detailQuery.data;
  const owner = project.myRole === 'owner';

  return <div className="page-stack requirements-page">
    <PageHeading eyebrow="项目规则" title="要求与评分" detail="核对原文引用、人工修改提取草稿，并由项目负责人明确确认要求集和评分版本。" />
    {capabilityQuery.error ? <ErrorNotice error={capabilityQuery.error} onRetry={() => void capabilityQuery.refetch()} /> : null}
    {sourceQuery.error ? <ErrorNotice error={sourceQuery.error} onRetry={() => void sourceQuery.refetch()} /> : null}

    <SectionCard title="要求集" detail="重新解析会产生新的草稿。已确认内容保持独立，不会被后续解析覆盖。">
      {setQuery.isLoading ? <Spinner label="正在读取项目要求集" /> : setQuery.error ? <ErrorNotice error={setQuery.error} onRetry={() => void setQuery.refetch()} /> : sets.length === 0 ? <EmptyState title="还没有要求草稿" detail="请先在“通知来源”导入原文并发起解析。解析失败或 AI 未启用时，此处不会展示虚构结果。" action={<Link className="button button-primary button-small" to={`/app/projects/${projectId}/sources`}>前往通知来源</Link>} /> : <div className="requirements-layout">
        <nav className="requirements-set-list" aria-label="要求集列表">{sets.map((set) => <button className="requirements-set-button" type="button" key={set.requirementSetId} aria-current={selectedSetId === set.requirementSetId} onClick={() => { setSearchParams({ setId: set.requirementSetId }); setEditingRequirementId(null); }}>
          <div className="requirements-set-meta"><StatusPill tone={set.status === 'confirmed' ? 'good' : 'warn'}>{set.status === 'confirmed' ? '已确认' : '待确认草稿'}</StatusPill><small>{set.requirements.length} 项要求</small></div>
          <strong>要求集 {set.requirementSetId.slice(0, 8)}</strong><small>{set.sourceVersionId ? `来源版本 ${set.sourceVersionId.slice(0, 8)}` : '未关联来源版本'} · 修订 ${set.revision}</small>
        </button>)}</nav>

        <div className="stack">
          {detailQuery.isLoading ? <Spinner label="正在读取要求详情与引用" /> : detailQuery.error ? <ErrorNotice error={detailQuery.error} onRetry={() => void detailQuery.refetch()} /> : setDetail ? <>
            <div className="card">
              <div className="section-head"><div><div className="requirements-set-meta"><StatusPill tone={setDetail.status === 'confirmed' ? 'good' : 'warn'}>{setDetail.status === 'confirmed' ? '已确认' : '人工复核前的草稿'}</StatusPill><span className="muted">修订 {setDetail.revision}</span></div><h2>要求集 {setDetail.requirementSetId.slice(0, 8)}</h2><p>{setDetail.confirmedAt ? `确认于 ${new Date(setDetail.confirmedAt).toLocaleString('zh-CN')}` : '每项要求都保留来源引文；AI 建议不会自动成为正式要求。'}</p></div>
                {setDetail.status === 'draft' && owner && <ConfirmButton className="button button-primary button-small" disabled={confirmingSet} onClick={() => void confirmSet(setDetail.requirementSetId)}><Check size={14} /> {confirmingSet ? '正在确认' : '负责人确认要求'}</ConfirmButton>}
              </div>
              {setDetail.status === 'draft' && !owner && <div className="callout warning-callout">只有项目负责人可以确认要求集。你仍可编辑草稿中的要求条目。</div>}
              {setDetail.status === 'draft' && owner && <div className="callout">确认前请核对截止日期精度、提交物、团队限制和每条引用。若官方文本未明确，不要补充推测值。</div>}
              {setActionError ? <ErrorNotice error={setActionError} /> : null}
              {activeSet?.sourceVersionId && <p className="requirements-item-meta"><Link className="button-link" to={`/app/projects/${projectId}/sources?sourceVersionId=${encodeURIComponent(activeSet.sourceVersionId)}`}>查看原始来源 <ExternalLink size={12} /></Link></p>}
            </div>
            {setDetail.requirements.length === 0 ? <EmptyState title="此要求集没有条目" detail="API 返回了空要求集，可重新解析来源或联系项目负责人核对服务状态。" /> : <div className="requirements-item-list">{setDetail.requirements.map((requirement) => {
              return <article className="requirements-item" key={requirement.requirementId}>
                <div className="requirements-item-head"><div><div className="requirements-set-meta"><StatusPill tone="blue">{categoryLabels[requirement.category]}</StatusPill><StatusPill tone={requirement.fieldState === 'edited' ? 'good' : requirement.fieldState === 'confirmed' ? 'good' : 'warn'}>{requirement.fieldState === 'edited' ? '人工已修改' : requirement.fieldState === 'confirmed' ? '已确认' : 'AI 建议'}</StatusPill></div><h3>{requirement.seq}. {requirement.title}</h3><p>{requirement.detail || '暂无补充说明。'}</p><div className="requirements-set-meta"><span className="muted">截止日期：{formatDate(requirement.dueDate)}</span><span className="muted">{precisionLabels[requirement.duePrecision]}</span></div></div>
                  {setDetail.status === 'draft' && <button className="button button-quiet button-small" type="button" disabled={savingRequirementId === requirement.requirementId} onClick={() => { setRequirementError(null); setEditingRequirementId(editingRequirementId === requirement.requirementId ? null : requirement.requirementId); }}><Pencil size={13} /> {editingRequirementId === requirement.requirementId ? '收起' : '编辑'}</button>}
                </div>
                {editingRequirementId === requirement.requirementId && <RequirementEditor requirement={requirement} onCancel={() => { setEditingRequirementId(null); setRequirementError(null); }} onSave={(draft) => void saveRequirement(requirement, draft)} busy={savingRequirementId === requirement.requirementId} error={requirementError} />}
                <div className="requirements-citations">{requirement.citations.length ? requirement.citations.map((citation) => {
                  const citedSource = sourcesByVersion.get(citation.sourceVersionId);
                  return <CitationCard key={`${citation.sourceVersionId}:${citation.fragmentId}`} citation={citation} sourceTitle={citedSource?.title} sourceId={citedSource?.sourceId} />;
                }) : <div className="callout warning-callout">此要求没有可展示的来源引文，需要人工核对后再确认。</div>}</div>
              </article>;
            })}</div>}
          </> : <EmptyState title="无法读取要求集" detail="当前没有可用的要求详情响应。" />}
        </div>
      </div>}
    </SectionCard>

    <SectionCard title="评分标准版本" detail="官方规则与自拟细则分开标记。创建版本不会自动确认，也不预填任何示例权重。" action={owner ? <button className="button button-primary button-small" type="button" disabled={rubricMode !== null} onClick={startCreateRubric}><Plus size={14} /> 新建评分草稿</button> : <StatusPill>仅负责人可管理</StatusPill>}>
      {rubricQuery.isLoading ? <Spinner label="正在读取评分标准版本" /> : rubricQuery.error ? <ErrorNotice error={rubricQuery.error} onRetry={() => void rubricQuery.refetch()} /> : <div className="stack">
        {rubricConfirmError ? <ErrorNotice error={rubricConfirmError} /> : null}
        {rubricMode === 'create' && <RubricEditor draft={rubricDraft} onChange={setRubricDraft} onCancel={() => setRubricMode(null)} onSave={() => void saveRubric()} busy={rubricSaving} error={rubricError} isNew />}
        {rubrics.length === 0 && rubricMode !== 'create' ? <EmptyState title="还没有评分版本" detail="请依据赛事通知原文创建官方规则或自拟细则；未获得来源支持的信息不要预填。" /> : <div className="requirements-rubrics">{rubrics.map((rubric) => {
          const editing = rubricMode === 'edit' && rubric.rubricId === selectedRubricIdResolved;
          const total = rubric.weights.reduce((sum, item) => sum + item.weight, 0);
          return <article className="requirements-rubric-card" key={rubric.rubricId}>
            <div className="requirements-item-head"><div><div className="requirements-set-meta"><StatusPill tone={rubric.source === 'official' ? 'blue' : 'warn'}>{rubric.source === 'official' ? '官方规则' : '自拟细则'}</StatusPill><StatusPill tone={rubric.status === 'confirmed' ? 'good' : 'warn'}>{rubric.status === 'confirmed' ? '已确认' : '草稿'}</StatusPill><span className="muted">版本 {rubric.version}</span></div><h3>评分标准版本 {rubric.version}</h3></div>
              <div className="requirements-rubric-actions">{owner && rubric.status === 'draft' && <button className="button button-quiet button-small" type="button" onClick={() => startEditRubric(rubric)} disabled={rubricMode !== null}><Pencil size={13} /> 编辑</button>}{owner && rubric.status === 'draft' && <ConfirmButton className="button button-primary button-small" disabled={confirmingRubricId === rubric.rubricId} onClick={() => void confirmRubric(rubric.rubricId)}><Check size={13} /> {confirmingRubricId === rubric.rubricId ? '正在确认' : '确认版本'}</ConfirmButton>}</div>
            </div>
            <div className="requirements-weight-list">{rubric.weights.map((weight) => <div className="requirements-weight" key={`${rubric.rubricId}:${weight.key}`}><span>{weight.label}</span><strong>{weight.weight}%</strong></div>)}</div>
            <div className="requirements-set-meta"><span className="muted">权重合计 {total}%</span>{rubric.confirmedAt && <span className="muted">确认于 {new Date(rubric.confirmedAt).toLocaleString('zh-CN')}</span>}</div>
            {rubric.notes && <p>{rubric.notes}</p>}
            {editing && <RubricEditor draft={rubricDraft} onChange={setRubricDraft} onCancel={() => setRubricMode(null)} onSave={() => void saveRubric()} busy={rubricSaving} error={rubricError} isNew={false} />}
          </article>;
        })}</div>}
        {rubricMode === 'edit' && !rubrics.some((rubric) => rubric.rubricId === selectedRubricIdResolved) && <ErrorNotice error={new Error('所选评分版本已从服务端列表中移除。')} />}
      </div>}
    </SectionCard>
  </div>;
}
