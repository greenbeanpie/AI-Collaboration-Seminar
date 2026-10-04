import { AudioPipelineStatus } from './AudioPipelineStatus';
import { api } from '../api/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus, Save, Trash2 } from 'lucide-react';
import { ApiError } from '../api/client';
import { isTemplatePayload, projectTemplateApi, type TemplateDraft, type TemplateMaterial, type TemplateRequirement, type TemplateStandard, type TemplateTask, type TemplateWorkspace } from '../api/project-templates';
import { useCapabilities, useSession } from '../auth';
import { DateInput } from '../components/DateInput';
import { EmptyState, ErrorNotice, Field, Spinner, StatusPill } from '../components/ui';
import { usePageDialogs } from '../dialogs/usePageDialogs';
import { canConfirmDraft } from './project-wizard';
import { creationFileExtensions, validateCreationFiles } from './project-creation-workflow';
import { useSettingsDirty } from './settings-dirty';
import { normalizedTemplate, sameTemplateValue, templateFormFromDraft, templateSignature, validateTemplateForm, type TemplateForm } from './template-workspace';
import './TemplateDraftWorkspace.css';
import { CreationBehaviorFields } from './CreationBehaviorFields';

const tabs = [['overview', '概览'], ['tasks', '任务'], ['materials', '资料'], ['standards', '评分'], ['team', '团队']] as const;
type PreviewTab = typeof tabs[number][0];
export function TemplateDraftWorkspace() {
  const { draftId = '' } = useParams();
  const session = useSession();
  if (session.isLoading) return <Spinner label="正在确认草稿账户" />;
  if (session.error) return <ErrorNotice error={session.error} />;
  if (!session.data) return <div className="callout">请登录后打开私有草稿。</div>;
  return <PrivateTemplateDraft key={`${session.data.id}:${draftId}`} draftId={draftId} userId={session.data.id} />;
}
function PrivateTemplateDraft({ draftId, userId }: { draftId: string; userId: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const capabilities = useCapabilities();
  const dialogs = usePageDialogs(`template:${draftId}`);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const draftRef = useRef<TemplateDraft | null>(null);
  const [form, setForm] = useState<TemplateForm | null>(null);
  const [baseline, setBaseline] = useState('');
  const [parseMode,setParseMode]=useState<'auto'|'cloud'|'browser'>('auto');
  const [tab, setTab] = useState<PreviewTab>('overview');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflicted, setConflicted] = useState(false);
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  const controllerRef = useRef<AbortController | null>(null);
  const signature = form ? templateSignature(form, draft?.files ?? []) : '';
  const dirty = Boolean(form && signature !== baseline && draft?.status === 'active');
  const clearDirty = useSettingsDirty(dirty);
  const rememberServer = useCallback((next: TemplateDraft) => { draftRef.current = next; if (mounted.current) setDraft(next); }, []);
  const hydrate = useCallback((next: TemplateDraft) => { if (!mounted.current) return; rememberServer(next); const restored = templateFormFromDraft(next); setForm(restored); setBaseline(templateSignature(restored, next.files)); setConflicted(false); setError(null); setNotice(''); }, [rememberServer]);
  useEffect(() => {
    const controller = new AbortController(); controllerRef.current = controller; mounted.current = true;
    void projectTemplateApi.get(draftId, controller.signal).then(next => { if (!controller.signal.aborted) hydrate(next); }).catch(reason => { if (!controller.signal.aborted) setError(reason); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); mounted.current = false; };
  }, [draftId, hydrate]);
  const mediaPending = draft?.files.some(file => ['pending','uploading','processing','generating'].includes(file.mediaStatus ?? '')) ?? false;
  const mediaPoll = useQuery({ queryKey: ['template-media',draftId], queryFn: () => projectTemplateApi.get(draftId), enabled: mediaPending && draft?.files.some(file => file.audio?.phase !== 'waiting_config' && ['pending','uploading','processing','generating'].includes(file.mediaStatus ?? '')) && !busy, refetchInterval: 3000, retry: false });
  useEffect(() => { const next = mediaPoll.data; if (next && !lock.current && next.revision >= (draftRef.current?.revision ?? 0)) rememberServer(next); }, [mediaPoll.data, rememberServer]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null); setNotice('');
    try { await action(); }
    catch (reason) { if (mounted.current) { setError(reason); if (reason instanceof ApiError && reason.status === 409) setConflicted(true); } }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const persist = async (createProject: boolean) => {
    if (!form || !draftRef.current || conflicted) return;
    const captured = structuredClone(form); const normalized = normalizedTemplate(captured); validateTemplateForm(normalized);
    let current = draftRef.current;
    if (current.status !== 'active') throw new Error('请先恢复草稿，或进入已经创建的项目。');
    if (!sameTemplateValue(normalized.payload, current.payload)) { current = await projectTemplateApi.save(draftId, current.revision, normalized.payload); rememberServer(current); }
    if (!mounted.current) return;
    const previewMatches = current.preview && sameTemplateValue(current.preview.goal, normalized.goal) && sameTemplateValue(current.preview.tasks, normalized.tasks);
    if (!canConfirmDraft(current) || !previewMatches) { current = await projectTemplateApi.preview(draftId, current.revision, normalized.goal, normalized.tasks); rememberServer(current); }
    if (!mounted.current) return;
    setBaseline(templateSignature(captured, current.files)); clearDirty();
    if (!createProject) { setNotice('私有草稿已保存，尚未创建正式项目。'); return; }
    const result = await projectTemplateApi.commit(draftId, current.revision);
    if (!mounted.current) return;
    clearDirty(); void client.invalidateQueries({ queryKey: ['projects'] }); void client.invalidateQueries({ queryKey: ['creation-drafts'] });
    navigate(`/app/projects/${encodeURIComponent(result.projectId)}`, { replace: true });
  };
  const reload = () => run(async () => { if (dirty && !await dialogs.confirm('载入最新草稿会替换当前未保存编辑。确定继续吗？')) return; hydrate(await projectTemplateApi.get(draftId)); });
  const setPayload = <K extends keyof TemplateForm['payload']>(key: K, value: TemplateForm['payload'][K]) => setForm(current => current ? { ...current, payload: { ...current.payload, [key]: value } } : current);
  const updateWorkspace = (workspace: TemplateWorkspace) => setForm(current => current ? { ...current, payload: { ...current.payload, workspace } } : current);
  const updateTasks = (tasks: TemplateTask[]) => setForm(current => current ? { ...current, tasks } : current);
  const rememberFileUpdate = (next: TemplateDraft, base: TemplateDraft) => {
    if (!sameTemplateValue(next.payload, base.payload) || !sameTemplateValue(next.preview?.tasks, base.preview?.tasks) || !sameTemplateValue(next.preview?.goal, base.preview?.goal)) throw new ApiError(409, { requestId: 'template-draft-conflict', error: { code: 'VERSION_CONFLICT', message: '草稿内容在文件操作期间已更新。当前本地输入保留，请先核对最新草稿。', retryable: false } });
    rememberServer(next);
  };
  const changeFile = async (fileId: string, removed: boolean) => { const base = draftRef.current!; rememberFileUpdate(await projectTemplateApi.fileState(draftId, base.revision, fileId, removed), base); };
  const uploadFiles = (chosen: FileList | null) => run(async () => {
    if (!chosen || !draftRef.current) return;
    const files = Array.from(chosen);
    const validation = validateCreationFiles([...draftRef.current.files.map(file => ({ name: file.name, size: file.sizeBytes })), ...files], capabilities.data?.limits.maxFileBytes ?? null);
    if (validation) throw new Error(validation);
    for (const file of files) { if (!mounted.current) return; const base = draftRef.current!; const next = await projectTemplateApi.upload(userId, draftId, base.revision, file, controllerRef.current?.signal,parseMode); rememberFileUpdate(next, base); }
    if (mounted.current) setNotice('文件已暂存到私有草稿。当前目标与任务编辑仍保留，保存草稿后可一并恢复。');
  });
  if (loading) return <Spinner label="正在恢复模板私有草稿" />;
  if (!draft || !form) return <div className="page-stack"><Link to="/app/projects/new">返回新建项目</Link><ErrorNotice error={error ?? new Error('未找到可访问的模板草稿。')} onRetry={() => void reload()} /></div>;
  if (!isTemplatePayload(draft.payload)) return <div className="card template-edit-card"><h1>此草稿来自分步创建</h1><Link to={`/app/projects/new/wizard?draftId=${encodeURIComponent(draft.id)}`}>继续分步创建</Link></div>;
  if (draft.status === 'committed') return <div className="card template-edit-card"><StatusPill tone="good">项目已创建</StatusPill><h1>{draft.payload.name}</h1><p>此草稿已对应一个正式项目，不会重复创建。</p><Link className="button button-primary" to={`/app/projects/${encodeURIComponent(draft.projectId ?? '')}`}>进入已创建项目</Link></div>;
  if (draft.status === 'cancelled') return <div className="card template-edit-card"><h1>模板草稿已取消</h1><p>已保存内容和文件仍保留，恢复后可继续预览编辑。</p>{error !== null && <ErrorNotice error={error} />}<button className="button button-primary" disabled={busy} onClick={() => void run(async () => hydrate(await projectTemplateApi.state(draftId, draft.revision, 'active')))}>恢复模板草稿</button><Link to="/app/projects/new">返回新建项目</Link></div>;
  const workspace = form.payload.workspace!;
  return <div className="page-stack template-draft-workspace">
    <div className="template-draft-status"><div className="template-status-copy"><StatusPill tone="warn">模板预览 · 未创建</StatusPill><small>{dirty ? '有未保存编辑' : '当前账户的私有草稿'}</small></div><div className="form-actions"><button className="button button-quiet" disabled={busy || conflicted} onClick={() => void run(() => persist(false))}><Save size={15} />{busy ? '正在保存' : '保存草稿'}</button><button className="button button-primary" disabled={busy || conflicted} onClick={() => void run(() => persist(true))}>保存并创建项目</button></div></div>
    <div className="project-banner template-preview-banner"><div className="project-breadcrumb"><Link to="/app/projects/new">新建项目</Link><span>/</span><span>空项目模板</span></div><div className="project-name-row"><div><h1>{form.payload.name || '未命名项目'}</h1><p>{form.payload.description || '在下方各分区编辑；最终保存后创建正式项目。'}</p></div><StatusPill>私有草稿</StatusPill></div></div>
    <nav className="project-content-navigation project-group-navigation template-preview-nav" aria-label="模板预览分区"><div className="project-content-links">{tabs.map(([key, label]) => <button className={`project-tab ${tab === key ? 'active' : ''}`} key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => setTab(key)}>{label}</button>)}</div><select className="input project-content-select" aria-label="切换模板预览分区" value={tab} onChange={event => setTab(event.target.value as PreviewTab)}>{tabs.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></nav>
    {error !== null && <ErrorNotice error={error} />}{notice && <p className="notice notice-success" role="status">{notice}</p>}
    {conflicted && <div className="notice notice-warn"><p>草稿已在其他页面更新。当前所有输入保留，不能用旧版本覆盖；请核对后载入最新草稿。</p><button className="button button-quiet" disabled={busy} onClick={() => void reload()}>载入最新草稿</button></div>}
    <fieldset className="template-panel" disabled={busy || conflicted} style={{ border: 0, padding: 0, margin: 0 }} aria-label={`${tabs.find(([key]) => key === tab)?.[1]}预览编辑`}>
      {tab === 'overview' && <section className="card template-edit-card"><h2>项目概览</h2><Field label="项目名称"><input className="input" maxLength={100} required value={form.payload.name} onChange={event => setPayload('name', event.target.value)} /></Field><Field label="项目说明（可选）"><textarea className="input" rows={4} maxLength={2000} value={form.payload.description} onChange={event => setPayload('description', event.target.value)} /></Field><Field label="截止日期（可选）"><DateInput className="input" type="date" value={form.payload.deadlineDate ?? ''} onChange={event => setPayload('deadlineDate', event.target.value || undefined)} /></Field><GoalFields form={form} onChange={goal => setForm({ ...form, goal })} /><div className="template-preview-summary"><div><span>任务</span><strong>{form.tasks.length}</strong></div><div><span>文档</span><strong>{workspace.materials.length}</strong></div><div><span>项目要求</span><strong>{workspace.standards?.requirements.length ?? 0}</strong></div><div><span>评分维度</span><strong>{workspace.standards?.weights.length ?? 0}</strong></div></div></section>}
      {tab === 'tasks' && <TemplateTasksEditor form={form} onGoal={goal => setForm({ ...form, goal })} onTasks={updateTasks} />}
      {tab === 'materials' && <><TemplateMaterialsEditor materials={workspace.materials} onChange={materials => updateWorkspace({ ...workspace, materials })} /><section className="card template-edit-card"><h2>暂存项目文件</h2><Field label="正文解析方式"><select className="input" value={parseMode} onChange={e=>setParseMode(e.target.value as typeof parseMode)}><option value="auto">自动建议：小PDF云端，大PDF本机；DOCX本机</option><option value="cloud">云端读取小PDF</option><option value="browser">本机读取正文</option></select></Field><Field label="导入文件（可选）" hint="只上传到本账户的私有草稿，最终创建时保留到项目资料中。"><input className="input" type="file" accept={creationFileExtensions} multiple disabled={!capabilities.data} onChange={event => { const files = event.target.files; void uploadFiles(files); event.target.value = ''; }} /></Field>{capabilities.error && <ErrorNotice error={capabilities.error} />}<div className="template-file-list">{draft.files.map(file => <div className="template-file-row" key={file.id}><div><strong>{file.name}</strong><small>{file.textReady ? '已读取文本' : '已私有暂存，尚无可读取文本'} · {(file.sizeBytes / 1024).toFixed(1)} KiB</small><AudioPipelineStatus audio={file.audio} disabled={busy} onRefresh={() => void run(async () => rememberServer(await projectTemplateApi.get(draftId)))} onResume={() => void run(async () => { if(!file.mediaJobId)return; await api.post<'DraftAudioFallbackResumeResponse'>(`/api/v1/creation-drafts/${draftId}/files/${file.id}/media-resume`,{jobId:file.mediaJobId}); rememberServer(await projectTemplateApi.get(draftId)); })}/>{file.mediaStatus && <small>音视频处理：{file.mediaStatus} · AI 摘要（非逐字原文）</small>}{file.mediaError && <small role="alert">{file.mediaError}</small>}{file.textError && <small>{file.textError}</small>}</div><button className="button button-quiet button-small" onClick={() => void run(() => changeFile(file.id, true))}>移出本次创建</button></div>)}</div>{Boolean(draft.removedFiles?.length) && <details><summary>已移出的暂存文件</summary>{draft.removedFiles?.map(file => <div className="template-file-row" key={file.id}><strong>{file.name}</strong><button className="button button-quiet button-small" onClick={() => void run(() => changeFile(file.id, false))}>恢复到本次创建</button></div>)}</details>}</section></>}
      {tab === 'standards' && <TemplateStandardsEditor standard={workspace.standards} onChange={standards => updateWorkspace({ ...workspace, standards })} />}
      {tab === 'team' && <section className="card template-edit-card"><h2>团队计划</h2><Field label="计划组员总人数（含负责人）（可选）" hint="用于团队规划，可在创建后继续邀请成员；不设置项目人数上限。"><input className="input" type="number" min="1" max="100" value={form.payload.teamSize} onChange={event => setPayload('teamSize', Number(event.target.value))} /></Field><Field label="拟邀请的登录用户名（可选）" hint="每行一个完整用户名。仅在保存并创建项目成功后发送邀请。"><textarea className="input" rows={5} value={form.payload.inviteUsernames.join('\n')} onChange={event => setPayload('inviteUsernames', event.target.value.split('\n'))} /></Field><label className="checkbox-row"><input type="checkbox" checked={form.payload.aiCollaborationEnabled} onChange={event => setPayload('aiCollaborationEnabled', event.target.checked)} />创建后开启 AI 智能协作</label><CreationBehaviorFields payload={form.payload} onChange={(key, value) => setPayload(key, value)} /><Link to="/app/profile">专业、技能与偏好在全局个人资料中维护</Link></section>}
    </fieldset>
    <div className="template-inline-actions"><button className="button button-quiet button-small" disabled={busy} onClick={() => void reload()}>重新读取草稿</button><button className="button button-quiet button-small" disabled={busy} onClick={() => void run(async () => { if (dirty && !await dialogs.confirm('取消草稿将保留已保存资料，当前未保存编辑会放弃。确定取消吗？')) return; const next = await projectTemplateApi.state(draftId, draftRef.current!.revision, 'cancelled'); clearDirty(); hydrate(next); })}>取消草稿（保留已保存资料）</button></div>
  </div>;
}
function GoalFields({ form, onChange }: { form: TemplateForm; onChange: (goal: TemplateForm['goal']) => void }) { return <><Field label="项目主目标（可选）" hint="留空时使用项目名称；主目标独立保存，不作为任务。"><input className="input" maxLength={200} value={form.goal.title} onChange={event => onChange({ ...form.goal, title: event.target.value })} /></Field><Field label="主目标说明（可选）"><textarea className="input" rows={3} maxLength={4000} value={form.goal.detail} onChange={event => onChange({ ...form.goal, detail: event.target.value })} /></Field></>; }
function TemplateTasksEditor({ form, onGoal, onTasks }: { form: TemplateForm; onGoal: (goal: TemplateForm['goal']) => void; onTasks: (tasks: TemplateTask[]) => void }) {
  const patch = (key: string, fields: Partial<TemplateTask>) => onTasks(form.tasks.map(task => task.key === key ? { ...task, ...fields } : task));
  return <section className="card template-edit-card"><h2>主目标与依赖任务</h2><GoalFields form={form} onChange={onGoal} />{form.tasks.length === 0 && <EmptyState title="尚无任务" detail="空模板不会自动生成任务；可按自己的主目标添加。" />}<div className="template-editor-list">{form.tasks.map((task, index) => <fieldset className="template-edit-item" key={task.key}><legend>任务 {index + 1}</legend><Field label="任务标题"><input className="input" maxLength={200} value={task.title} onChange={event => patch(task.key, { title: event.target.value })} /></Field><Field label="任务说明"><textarea className="input" maxLength={4000} rows={3} value={task.detail} onChange={event => patch(task.key, { detail: event.target.value })} /></Field><Field label="验收标准"><textarea className="input" maxLength={4000} rows={3} value={task.criteria} onChange={event => patch(task.key, { criteria: event.target.value })} /></Field><Field label="预计投入（小时）"><input className="input" type="number" min="0.25" max="200" step="0.25" value={task.effortHours} onChange={event => patch(task.key, { effortHours: Number(event.target.value) })} /></Field><fieldset><legend>前置任务</legend>{form.tasks.filter(item => item.key !== task.key).map(item => <label className="checkbox-row" key={item.key}><input type="checkbox" checked={task.dependsOn.includes(item.key)} onChange={event => patch(task.key, { dependsOn: event.target.checked ? [...task.dependsOn, item.key] : task.dependsOn.filter(key => key !== item.key) })} />{item.title || '未命名任务'}</label>)}</fieldset><button className="button button-quiet button-small" onClick={() => onTasks(form.tasks.filter(item => item.key !== task.key).map(item => ({ ...item, dependsOn: item.dependsOn.filter(key => key !== task.key) })))}><Trash2 size={14} />移除任务</button></fieldset>)}</div><button className="button button-quiet" disabled={form.tasks.length >= 20} onClick={() => onTasks([...form.tasks, { key: crypto.randomUUID(), title: '', detail: '', criteria: '', effortHours: 1, dependsOn: [], citations: [] }])}><Plus size={16} />添加任务</button></section>;
}
function TemplateMaterialsEditor({ materials, onChange }: { materials: TemplateMaterial[]; onChange: (materials: TemplateMaterial[]) => void }) {
  const patch = (key: string, fields: Partial<TemplateMaterial>) => onChange(materials.map(material => material.key === key ? { ...material, ...fields } : material));
  return <section className="card template-edit-card"><h2>背景、参考与成果文档</h2>{materials.length === 0 && <EmptyState title="尚无文档" detail="可从空白开始，填入背景或撰写成果正文。" />}<div className="template-editor-list">{materials.map((material, index) => <fieldset className="template-edit-item" key={material.key}><legend>文档 {index + 1}</legend><Field label="文档标题"><input className="input" maxLength={200} value={material.title} onChange={event => patch(material.key, { title: event.target.value })} /></Field><Field label="文档用途"><select className="input" value={material.purpose} onChange={event => patch(material.key, { purpose: event.target.value as TemplateMaterial['purpose'] })}><option value="background">背景</option><option value="reference">参考</option><option value="output">成果</option></select></Field><Field label="文档正文（Markdown）"><textarea className="input template-markdown" maxLength={200000} value={material.markdown} onChange={event => patch(material.key, { markdown: event.target.value })} /></Field><button className="button button-quiet button-small" onClick={() => onChange(materials.filter(item => item.key !== material.key))}><Trash2 size={14} />移除文档</button></fieldset>)}</div><button className="button button-quiet" disabled={materials.length >= 20} onClick={() => onChange([...materials, { key: crypto.randomUUID(), title: '', markdown: '', purpose: 'output' }])}><Plus size={16} />新建文档</button></section>;
}
function TemplateStandardsEditor({ standard, onChange }: { standard: TemplateStandard | null; onChange: (standard: TemplateStandard | null) => void }) {
  const categories = { deadline: '截止日期', deliverable: '交付成果', format: '格式', scoring: '评分', team: '团队', other: '其他' };
  if (!standard) return <section className="card template-edit-card"><h2>项目要求与评分标准</h2><EmptyState title="尚无项目标准" detail="空模板不预设要求或评分；可添加检查项，并按需维护评分维度。" /><button className="button button-quiet" onClick={() => onChange({ title: '项目标准', requirements: [], weights: [], notes: '' })}><Plus size={16} />添加项目标准</button></section>;
  const patch = (key: string, fields: Partial<TemplateRequirement>) => onChange({ ...standard, requirements: standard.requirements.map(requirement => requirement.key === key ? { ...requirement, ...fields } : requirement) });
  const scoring = (requirement: TemplateRequirement, enabled: boolean) => { const dimensionKey = requirement.dimensionKey ?? `criterion_${requirement.key.replace(/-/g, '').slice(0, 20)}`; onChange({ ...standard, requirements: standard.requirements.map(item => item.key === requirement.key ? { ...item, dimensionKey: enabled ? dimensionKey : undefined } : item), weights: enabled ? standard.weights.some(weight => weight.key === dimensionKey) ? standard.weights : [...standard.weights, { key: dimensionKey, label: requirement.title, weight: 100 }] : standard.requirements.some(item => item.key !== requirement.key && item.dimensionKey === dimensionKey) ? standard.weights : standard.weights.filter(weight => weight.key !== dimensionKey) }); };
  return <section className="card template-edit-card"><h2>项目要求与评分标准</h2><Field label="标准名称"><input className="input" maxLength={200} value={standard.title} onChange={event => onChange({ ...standard, title: event.target.value })} /></Field><div className="template-editor-list">{standard.requirements.map((requirement, index) => <fieldset className="template-edit-item" key={requirement.key}><legend>要求 {index + 1}</legend><Field label="要求标题"><input className="input" maxLength={200} value={requirement.title} onChange={event => { const title = event.target.value; onChange({ ...standard, requirements: standard.requirements.map(item => item.key === requirement.key ? { ...item, title } : item), weights: standard.weights.map(weight => weight.key === requirement.dimensionKey && (!weight.label || weight.label === requirement.title) ? { ...weight, label: title } : weight) }); }} /></Field><Field label="要求说明"><textarea className="input" rows={3} maxLength={2000} value={requirement.detail} onChange={event => patch(requirement.key, { detail: event.target.value })} /></Field><div className="form-grid-two"><Field label="要求分类"><select className="input" value={requirement.category} onChange={event => patch(requirement.key, { category: event.target.value as TemplateRequirement['category'] })}>{Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><Field label="要求截止日期"><DateInput className="input" type="date" value={requirement.dueDate?.slice(0, 10) ?? ''} onChange={event => patch(requirement.key, { dueDate: event.target.value || null, duePrecision: event.target.value ? 'date' : 'unknown' })} /></Field></div><label className="checkbox-row"><input type="checkbox" disabled={!requirement.dimensionKey && standard.weights.length >= 10} checked={Boolean(requirement.dimensionKey)} onChange={event => scoring(requirement, event.target.checked)} />此要求参与评分</label><button className="button button-quiet button-small" onClick={() => { const requirements = standard.requirements.filter(item => item.key !== requirement.key); onChange({ ...standard, requirements, weights: standard.weights.filter(weight => weight.key !== requirement.dimensionKey || requirements.some(item => item.dimensionKey === weight.key)) }); }}><Trash2 size={14} />移除要求</button></fieldset>)}</div><button className="button button-quiet" disabled={standard.requirements.length >= 100} onClick={() => onChange({ ...standard, requirements: [...standard.requirements, { key: crypto.randomUUID(), title: '', detail: '', category: 'deliverable', dueDate: null, duePrecision: 'unknown' }] })}><Plus size={16} />添加要求</button>{standard.weights.map(weight => <div className="form-grid-two" key={weight.key}><Field label="评分项名称"><input className="input" maxLength={60} value={weight.label} onChange={event => onChange({ ...standard, weights: standard.weights.map(item => item.key === weight.key ? { ...item, label: event.target.value } : item) })} /></Field><Field label="权重（%）"><input className="input" type="number" min="0" max="100" step="any" value={weight.weight} onChange={event => onChange({ ...standard, weights: standard.weights.map(item => item.key === weight.key ? { ...item, weight: Number(event.target.value) } : item) })} /></Field></div>)}<Field label="标准说明"><textarea className="input" rows={3} maxLength={2000} value={standard.notes ?? ''} onChange={event => onChange({ ...standard, notes: event.target.value })} /></Field><button className="button button-quiet button-small" onClick={() => onChange(null)}>移除本预览中的项目标准</button></section>;
}
