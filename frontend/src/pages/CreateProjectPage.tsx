import { Fragment, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api, request } from '../api/client';
import type { DataOf } from '../api/types';
import { useSession, useCapabilities } from '../auth';
import { Field, ErrorNotice, PageHeading, Spinner } from '../components/ui';
import { DateInput } from '../components/DateInput';
import { AiClarificationCard } from '../components/AiClarificationCard';
import { clarificationApi, type ClarificationAnswer } from '../api/clarifications';
import { readCreationDraft, creationFileExtensions, validateCreationFiles } from './project-creation-workflow';
import { LegacyCreateProjectPage } from './LegacyCreateProjectPage';
import { isTemplatePayload } from '../api/project-templates';
import { emptyWizardPayload, wizardSteps, canConfirmDraft, confirmationIssue, sameWizardPayload, wizardStorageKey, type WizardDraft, type WizardPayload, type WizardTask, type WizardGoal } from './project-wizard';
import './ProjectWizard.css';
import { CreationBehaviorFields } from './CreationBehaviorFields';
import { creationBehaviors, creationBehavior } from './project-wizard';
type LocalFile = {
  id: string;
  name: string;
  size: number;
  original?: File;
  error?: string;
};
const draftPath = (id: string, tail = '') => `/api/v1/creation-drafts/${id}${tail}`;
export { NewProjectEntryPage as CreateProjectPage } from './NewProjectEntryPage';
export function CreateProjectWizardPage() {
  const session = useSession();
  if (session.isLoading) {
    return <Spinner label="正在确认创建账户"/>;
  }
  if (session.error) {
    return <ErrorNotice error={session.error}/>;
  }
  if (!session.data) {
    return <div className="callout">请先登录，再创建项目。</div>;
  }
  if (readCreationDraft(session.data.id)?.createAttempted) {
    return <LegacyCreateProjectPage />;
  }
  return <CreationWizard key={session.data.id} userId={session.data.id}/>;
}
function CreationWizard({ userId }: {
  userId: string;
}) {
  const [searchParams] = useSearchParams();
  const initial = () => {
    const linkedDraftId = searchParams.get('draftId');
    if (linkedDraftId) return { id: linkedDraftId, files: [] as LocalFile[] };
    try {
      return JSON.parse(sessionStorage.getItem(wizardStorageKey(userId)) ?? 'null') as {
        id?: string;
        files?: LocalFile[];
      } | null;
    }
    catch {
      return null;
    }
  };
  const [saved] = useState(initial), [draft, setDraft] = useState<WizardDraft | null>(null), [payload, setPayload] = useState<WizardPayload>(emptyWizardPayload), [step, setStep] = useState(0), [locals, setLocals] = useState<LocalFile[]>(saved?.files ?? []), [actionBusy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [confirmed, setConfirmed] = useState(false), [result, setResult] = useState<DataOf<'CreationCommitResponse'> | null>(null), [manual, setManual] = useState<WizardTask[]>([]), [loaded, setLoaded] = useState(false);
  const previewEpoch = useRef(0), latestDraft = useRef(draft);
  latestDraft.current = draft;
  const previewRunning = draft?.previewState === 'running';
  const mediaPending = draft?.files.some(file => ['pending','uploading','processing','generating'].includes(file.mediaStatus ?? '')) ?? false;
  const previewWaiting = draft?.previewState === 'waiting_input';
  const busy = actionBusy || previewRunning || previewWaiting;
  const draftPoll = useQuery({ queryKey: ['creation-draft-preview', draft?.id, previewRunning], queryFn: async ({ signal }) => { const epoch=previewEpoch.current; const next=await api.get<'CreationDraftResponse'>(draftPath(draft!.id),undefined,signal); return { epoch, draft: next }; }, enabled: Boolean(draft?.id && (previewRunning || mediaPending) && !actionBusy), refetchInterval: query => query.state.data?.draft.previewState === 'running' || query.state.data?.draft.files.some(file => ['pending','uploading','processing','generating'].includes(file.mediaStatus ?? '')) || !query.state.data ? 3000 : false, refetchIntervalInBackground: false, retry: false });
  useEffect(() => { const snapshot = draftPoll.data; const next=snapshot?.draft; if (!next || snapshot.epoch !== previewEpoch.current || next.id !== latestDraft.current?.id || (latestDraft.current.previewState !== 'running' && !latestDraft.current.files.some(file => ['pending','uploading','processing','generating'].includes(file.mediaStatus ?? ''))) || next.revision < latestDraft.current.revision) return; const previous = latestDraft.current; setDraft(next); setPayload(current => sameWizardPayload(current, previous.payload) ? next.payload : current); if (next.revision !== previous.revision) setConfirmed(false); if (next.previewState === 'ready') { setManual(next.preview?.tasks ?? []); setManualGoal(next.preview?.goal ?? next.payload.goal ?? { title: next.payload.name, detail: '' }); setConfirmed(false); } }, [draftPoll.data]);
  const lock = useRef(false), createKey = useRef(crypto.randomUUID()), fileInput = useRef<HTMLInputElement>(null), mounted = useRef(true);
  const [manualGoal, setManualGoal] = useState<WizardGoal>({ title: '', detail: '' });
  const capabilities = useCapabilities(), queryClient = useQueryClient(), navigate = useNavigate();
  const list = useQuery({
    queryKey: ['creation-drafts', userId], queryFn: () => api.get<'CreationDraftListResponse'>('/api/v1/creation-drafts'), retry: false
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const remember = (id: string | undefined, files: LocalFile[] = locals) => {
    try {
      sessionStorage.setItem(wizardStorageKey(userId), JSON.stringify({
        id, files: files.map(({ id, name, size }) => ({
          id, name, size
        }))
      }));
    }
    catch {
      // Private server drafts remain recoverable when browser storage is unavailable.
    }
  };
  const accept = (next: WizardDraft) => {
    if (!mounted.current) {
      return;
    }
    setDraft(next);
    setPayload(next.payload);
    setManualGoal(current => current.title.trim() ? current : next.preview?.goal ?? next.payload.goal ?? { title: next.payload.name, detail: '' });
    setConfirmed(false);
    remember(next.id);
  };
  useEffect(() => {
    if (loaded) {
      return;
    }
    setLoaded(true);
    if (saved?.id) {
      void api.get<'CreationDraftResponse'>(draftPath(saved.id)).then((next: WizardDraft) => {
        if (isTemplatePayload(next.payload)) { navigate(`/app/projects/new/template/${encodeURIComponent(next.id)}`, { replace: true }); return; }
        if (!mounted.current) {
          return;
        }
        setDraft(next);
        if (next.previewState === 'waiting_input' || next.previewState === 'running') setStep(3);
        setPayload(next.payload);
        setManual(next.preview?.tasks ?? []);
        setManualGoal(next.preview?.goal ?? next.payload.goal ?? { title: next.payload.name, detail: '' });
        setLocals(items => items.filter(f => !next.files.some(done => done.id === f.id)));
      }).catch(setError);
    }
  }, [saved, loaded, navigate]);
  useEffect(() => {
    if (!actionBusy && !previewRunning) {
      return;
    }
    const leave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [actionBusy, previewRunning]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current || previewRunning) {
      return;
    }
    lock.current = true;
    previewEpoch.current++;
    setBusy(true);
    setError(null);
    try {
      await action();
    }
    catch (e) {
      if (mounted.current) {
        setError(e);
      }
    }
    finally {
      lock.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  };
  const ensure = async () => {
    if (!payload.name.trim()) {
      throw new Error('请填写项目名称');
    }
    const normalized = {
      ...payload, name: payload.name.trim(), inviteUsernames: payload.inviteUsernames.map(n => n.trim()).filter(Boolean), inviteLabels: payload.inviteLabels.map(n => n.trim()).filter(Boolean)
    };
    let next = draft;
    if (!next) {
      next = await api.post<'CreationDraftResponse'>('/api/v1/creation-drafts', normalized, {
        idempotencyKey: createKey.current
      });
    }
    else if (!sameWizardPayload(normalized, next.payload)) {
      next = await api.patch<'CreationDraftResponse'>(draftPath(next.id), {
        expectedRevision: next.revision, payload: normalized
      });
    }
    accept(next);
    return next;
  };
  const next = () => run(async () => {
    let current = await ensure();
    if (step === 1) {
      for (const file of locals) {
        if (!file.original) {
          throw new Error(`请重新选择未确认上传的原文件：${file.name}`);
        }
        try {
          current = await request<'CreationDraftResponse'>(draftPath(current.id, `/files/${file.id}`), {
            method: 'PUT', query: {
              expectedRevision: current.revision, name: file.name
            }, rawBody: file.original
          });
          accept(current);
          setLocals(items => {
            const remaining = items.filter(f => f.id !== file.id);
            remember(current.id, remaining);
            return remaining;
          });
        }
        catch (e) {
          setLocals(items => items.map(f => f.id === file.id ? {
            ...f, error: e instanceof Error ? e.message : '上传未确认'
          } : f));
          throw e;
        }
      }
    }
    setStep(s => Math.min(4, s + 1));
  });
  const select = (files: FileList | null) => {
    if (!files) {
      return;
    }
    const chosen = Array.from(files), validation = validateCreationFiles([...draft?.files.map(f => ({
        name: f.name, size: f.sizeBytes
      })) ?? [], ...chosen], capabilities.data?.limits.maxFileBytes ?? 0);
    if (validation) {
      setError(new Error(validation));
      return;
    }
    setLocals(items => {
      let remaining = [...items];
      for (const original of chosen) {
        const found = remaining.find(f => f.name === original.name && f.size === original.size);
        if (found) {
          remaining = remaining.map(f => f.id === found.id ? {
            ...f, original, error: undefined
          } : f);
        }
        else {
          remaining.push({
            id: crypto.randomUUID(), name: original.name, size: original.size, original
          });
        }
      }
      if (remaining.length + (draft?.files.length ?? 0) > 10) {
        setError(new Error('最多10个文件'));
        return items;
      }
      remember(draft?.id, remaining);
      return remaining;
    });
  };
  const preview = (mode: 'ai' | 'manual', regenerate = false) => run(async () => {
    const current = await ensure();
    const next: WizardDraft = await api.post<'CreationDraftResponse'>(draftPath(current.id, '/preview'), {
      expectedRevision: current.revision, mode, ...(mode === 'ai' ? { background: true } : {}), tasks: mode === 'manual' ? manual : [], ...(mode === 'manual' ? { goal: manualGoal.title.trim() ? manualGoal : { title: payload.name, detail: '' } } : {}), regenerate
    });
    accept(next);
    setManual(next.preview?.tasks ?? []);
    setManualGoal(next.preview?.goal ?? next.payload.goal ?? { title: next.payload.name, detail: '' });
  });
  const openDraft = (id: string) => run(async () => {
    const next: WizardDraft = await api.get<'CreationDraftResponse'>(draftPath(id));
    if (isTemplatePayload(next.payload)) { navigate(`/app/projects/new/template/${encodeURIComponent(next.id)}`); return; }
    accept(next);
    setLocals([]);
    remember(id, []);
    setManual(next.preview?.tasks ?? []);
    setManualGoal(next.preview?.goal ?? next.payload.goal ?? { title: next.payload.name, detail: '' });
    setStep(next.previewState === 'waiting_input' || next.previewState === 'running' ? 3 : 0);
    setResult(null);
  });
  const resolveClarification = async (answer?: ClarificationAnswer) => {
    if (!draft?.clarification || lock.current) return;
    lock.current = true;
    previewEpoch.current++;
    setBusy(true);
    try {
      const updated = answer
        ? await clarificationApi.answerDraft(draft.id, draft.clarification, answer)
        : await clarificationApi.cancelDraft(draft.id, draft.clarification);
      accept(updated);
      if (updated.previewState === 'ready') {
        setManual(updated.preview?.tasks ?? []);
        setManualGoal(updated.preview?.goal ?? updated.payload.goal ?? { title: updated.payload.name, detail: updated.payload.brief || updated.payload.description });
      }
      setStep(3);
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const refreshClarification = async () => {
    if (!draft) return;
    previewEpoch.current++;
    const updated = await api.get<'CreationDraftResponse'>(draftPath(draft.id));
    accept(updated);
    if (updated.previewState === 'ready') {
      setManual(updated.preview?.tasks ?? []);
      setManualGoal(updated.preview?.goal ?? updated.payload.goal ?? { title: updated.payload.name, detail: updated.payload.brief || updated.payload.description });
    }
  };
  const setField = <K extends keyof WizardPayload>(key: K, value: WizardPayload[K]) => {
    setPayload(p => ({
      ...p, [key]: value
    }));
    setConfirmed(false);
  };
  const previewCurrent = draft && !mediaPending && canConfirmDraft(draft) && sameWizardPayload(payload, draft.payload);
  if (result) {
    return <div className="page-stack narrow-page"><PageHeading title="项目已创建" detail="资料、任务和邀请已保存；再次确认会恢复同一个项目。"/><section className="card form-card"><p>{payload.name}</p>{Boolean(result.usernameInvitations?.length) && <p>已向用户名 {result.usernameInvitations?.join("、")} 发送邀请，对方可在首页接受或拒绝。</p>}<Link className="button button-primary" to={`/app/projects/${result.projectId}`}>进入项目</Link>{result.invitations.length > 0 && <><h2>分享邀请</h2><p>每个链接可使用一次，7 天有效。请将对应链接分享给组员，接受邀请后才成为成员。</p>{result.invitations.map(invite => <Field key={invite.code} label={invite.label}><input className="input" readOnly value={`${window.location.origin}/app/join?code=${encodeURIComponent(invite.code)}`}/></Field>)}</>}</section></div>;
  }
  return <div className="page-stack narrow-page"><Link className="back-link" to="/app"><ArrowLeft size={16}/>返回项目列表</Link><PageHeading eyebrow="新建项目" title="配置协作项目" detail="完成资料、组员与任务配置，最后确认后创建。"/>
 {!draft && list.data?.items.length !== 0 && <details className="card form-card"><summary>恢复已有创建草稿</summary>{list.data?.items.map(item => <button key={item.id} type="button" className="button button-quiet" disabled={busy} onClick={() => void openDraft(item.id)}>{item.payload.name} · {item.status === 'cancelled' ? '已取消，可恢复' : '配置中'}</button>)}</details>}
 <ol className="wizard-steps" aria-label="创建步骤">{wizardSteps.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
 <form className="card form-card" aria-label="分步创建项目" onSubmit={event => {
      event.preventDefault();
      if (step < 3) {
        void next();
      }
    }}>
 {draft?.status === 'cancelled' ? <section className="callout"><p>此草稿已取消，配置和文件仍保留。恢复后需重新确认任务预览。</p><button className="button button-primary" type="button" disabled={busy} onClick={() => void run(async () => accept(await api.post<'CreationDraftResponse'>(draftPath(draft.id, '/state'), {
      expectedRevision: draft.revision, status: 'active'
    })))}>恢复草稿</button></section> : draft?.status === 'committed' ? <section className="callout"><p>此草稿已经创建项目，结果可以安全恢复。</p><Link to={`/app/projects/${draft.projectId}`}>进入已创建项目</Link><button type="button" className="button button-quiet" onClick={() => void run(async () => setResult(await api.post<'CreationCommitResponse'>(draftPath(draft.id, '/commit'), {
      expectedRevision: draft.revision, confirmed: true
    })))}>恢复创建结果与邀请</button></section> : <>
 <h2>{wizardSteps[step]}</h2>
 {previewWaiting && draft?.clarification?.status === 'pending' && <AiClarificationCard question={draft.clarification} disabled={actionBusy} onAnswer={resolveClarification} onCancel={() => resolveClarification()} onRefresh={refreshClarification} />}
 {previewWaiting && !draft?.clarification && <div className="callout"><p>AI 正在等待补充信息，正在核对问题状态。</p><button type="button" className="button button-quiet" disabled={actionBusy} onClick={() => void refreshClarification().catch(setError)}>重新读取待回答问题</button></div>}
 {step === 0 && <><Field label="项目名称"><input className="input" required maxLength={100} value={payload.name} disabled={busy} onChange={e => setField('name', e.target.value)}/></Field><Field label="主目标（可选）" hint="可直接给出团队大目标；留空时使用项目名称，目标说明留空。主动生成 AI 预览时可以建议目标。"><input className="input" maxLength={200} value={payload.goal?.title ?? ''} disabled={busy} onChange={e => { const title = e.target.value; setField('goal', title.trim() ? { title, detail: payload.goal?.detail ?? '' } : undefined); setManualGoal({ title, detail: payload.goal?.detail ?? '' }); }}/></Field><Field label="项目说明（可选）"><textarea className="input textarea" maxLength={2000} rows={4} value={payload.description} disabled={busy} onChange={e => setField('description', e.target.value)}/></Field><Field label="截止日期（可选）" hint="未明确日期可留空，不会自动补时刻。"><DateInput className="input" type="date" value={payload.deadlineDate ?? ''} disabled={busy} onChange={e => {
          const date = e.target.value;
          setPayload(p => {
            const next = {
              ...p
            };
            if (date) {
              next.deadlineDate = date;
            }
            else {
              delete next.deadlineDate;
            }
            return next;
          });
          setConfirmed(false);
        }}/></Field><label className="field"><span><input type="checkbox" checked={payload.aiCollaborationEnabled} disabled={busy} onChange={e => setField('aiCollaborationEnabled', e.target.checked)}/> AI 智能协作</span><small>开启后可生成拆分预览，并启用项目 AI 分工与评价。预览可能产生现有模型用量；创建时复用已确认结果。</small></label><CreationBehaviorFields payload={payload} disabled={busy} onChange={(key, value) => setField(key, value)} />{payload.aiCollaborationEnabled && !capabilities.data?.features.aiEnabled && <div className="callout">系统 AI 当前不可用，可以手动配置任务并继续创建。</div>}</>}
 {step === 1 && <><Field label="上传项目文件（可选）" hint="最多10个文件，支持 PDF、图片、TXT、Markdown 和音视频（50 MiB）。上传只暂存到私有草稿，音视频后台生成摘要。"><input ref={fileInput} className="input" type="file" multiple accept={creationFileExtensions} disabled={busy || !capabilities.data} onChange={e => {
      select(e.target.files);
      e.target.value = '';
    }}/></Field>{draft?.files.map(file => <div className="wizard-file" key={file.id}><strong>{file.name}</strong><small>{(file.sizeBytes / 1024).toFixed(1)} KiB · 已暂存 · {file.textReady ? '已读取文本' : '尚无可读取文本'}</small>{file.mediaStatus && <p>音视频处理：{file.mediaStatus}{file.mediaSummary ? ' · AI 摘要（非逐字原文）' : ''}</p>}{file.mediaError && <p role="alert">{file.mediaError}</p>}{file.textError && <p>{file.textError}</p>}<button type="button" className="button button-quiet button-small" disabled={busy} onClick={() => void run(async () => {
      accept(await api.post<'CreationDraftResponse'>(draftPath(draft.id, `/files/${file.id}/state`), {
        expectedRevision: draft.revision, removed: true
      }));
    })}>移出本次创建</button></div>)}{Boolean(draft?.removedFiles?.length) && <details><summary>恢复移出的文件</summary>{draft?.removedFiles.map(file => <div className="wizard-file" key={file.id}><strong>{file.name}</strong><button type="button" className="button button-quiet button-small" disabled={busy || (draft?.files.length ?? 0) >= 10} onClick={() => void run(async () => accept(await api.post<'CreationDraftResponse'>(draftPath(draft.id, `/files/${file.id}/state`), {
      expectedRevision: draft.revision, removed: false
    })))}>恢复此文件</button></div>)}</details>}{locals.map(file => <div className="wizard-file" key={file.id}><strong>{file.name}</strong><small>{file.original ? '待上传，下一步会暂存' : '上传尚未确认，请重新选择原文件'}</small>{file.error && <p role="alert">{file.error}</p>}<button type="button" className="button button-quiet button-small" disabled={busy} onClick={() => {
      const remaining = locals.filter(f => f.id !== file.id);
      setLocals(remaining);
      remember(draft?.id, remaining);
    }}>移除待上传</button></div>)}</>}
 {step === 2 && <><Field label="组员总人数（含负责人）（可选）" hint="用于团队规划，可在创建后继续邀请成员；不设置项目人数上限。"><input type="number" className="input" min={1} max={100} value={payload.teamSize} disabled={busy} onChange={e => setField('teamSize', Number(e.target.value))}/></Field><Field label="邀请对象的完整登录用户名（每行一个，可留空）" hint="只按完整用户名精确匹配，不按昵称查找。正式创建后对方在首页接受或拒绝；邀请不提前占名额。"><textarea className="input textarea" rows={4} disabled={busy} value={payload.inviteUsernames.join('\n')} onChange={e => setField('inviteUsernames', e.target.value.split('\n'))} onBlur={() => setField('inviteUsernames', payload.inviteUsernames.map(n => n.trim()).filter(Boolean))}/></Field><p>正式创建成功后才发送邀请；组员接受后加入普通成员并获得项目权限。</p></>}
 {step === 3 && <>{mediaPending && <p role="status">音视频摘要正在处理，完成后可生成预览；也可移出该文件继续创建。</p>}{previewRunning && <p role="status">AI 正在后台处理文件并调查项目草稿，可刷新页面后继续等待。</p>}{draftPoll.error && <ErrorNotice error={draftPoll.error} onRetry={() => void draftPoll.refetch()} />}<Field label="主目标预览（可选）" hint="大目标独立保存，不计入下面的任务数量或工时。编辑后需保存当前预览。"><input className="input" maxLength={200} value={manualGoal.title} disabled={busy} onChange={e => { setManualGoal({ ...manualGoal, title: e.target.value }); setConfirmed(false); }}/></Field><Field label="目标说明预览（可选）"><textarea className="input" rows={3} maxLength={4000} value={manualGoal.detail} disabled={busy} onChange={e => { setManualGoal({ ...manualGoal, detail: e.target.value }); setConfirmed(false); }}/></Field><Field label="拆分要求（可选）" hint="说明具体目标、交付成果和限制；修改后旧预览失效。"><textarea className="input textarea" rows={3} maxLength={4000} disabled={busy} value={payload.brief} onChange={e => setField('brief', e.target.value)}/></Field><div className="form-actions"><button type="button" className="button button-primary" disabled={busy || mediaPending || !payload.aiCollaborationEnabled || !capabilities.data?.features.aiEnabled} onClick={() => void preview('ai', Boolean(draft?.preview))}>{draft?.preview ? '重新生成 AI 预览' : '生成 AI 拆分预览'}</button><button type="button" className="button button-quiet" disabled={busy || manual.length >= 20} onClick={() => setManual(items => [...items, {
        key: crypto.randomUUID(), dependsOn: [], title: '', detail: '', criteria: '', effortHours: 1, citations: []
      }])}>添加手动任务</button></div><p>手动预览不调用模型；可确认暂不创建任务。重新生成 AI 预览可能再次产生用量。</p>{manual.map((task, index) => <fieldset key={task.key ?? index} className="wizard-task"><legend>任务 {index + 1}</legend><Field label="标题"><input className="input" value={task.title} maxLength={200} disabled={busy} onChange={e => {
      setManual(items => items.map((t, i) => i === index ? {
        ...t, title: e.target.value
      } : t));
      setConfirmed(false);
    }}/></Field><Field label="内容"><textarea className="input" value={task.detail} maxLength={4000} disabled={busy} onChange={e => setManual(items => items.map((t, i) => i === index ? {
      ...t, detail: e.target.value
    } : t))}/></Field><Field label="验收标准"><textarea className="input" value={task.criteria} maxLength={4000} disabled={busy} onChange={e => setManual(items => items.map((t, i) => i === index ? {
      ...t, criteria: e.target.value
    } : t))}/></Field><Field label="预计工时"><input className="input" type="number" min={.25} max={200} step={.25} disabled={busy} value={task.effortHours} onChange={e => setManual(items => items.map((t, i) => i === index ? {
      ...t, effortHours: Number(e.target.value)
    } : t))}/></Field><fieldset><legend>前置任务</legend>{manual.filter((predecessor, predecessorIndex) => predecessorIndex !== index && predecessor.key).map(predecessor => <label className="collab-version" key={predecessor.key}><input type="checkbox" disabled={busy} checked={task.dependsOn?.includes(predecessor.key!) ?? false} onChange={e => { const checked = e.target.checked; setManual(items => items.map((item, current) => current === index ? { ...item, dependsOn: checked ? [...(item.dependsOn ?? []), predecessor.key!] : (item.dependsOn ?? []).filter(key => key !== predecessor.key) } : item)); setConfirmed(false); }}/>{predecessor.title || '未命名任务'}</label>)}</fieldset>{task.citations.map((cite, i) => <p key={i}>依据：{draft?.files.find(f => f.id === cite.fileId)?.name ?? '项目文件'} 第{cite.pageNumber}页 · “{cite.quote}”</p>)}<button type="button" className="button button-quiet button-small" disabled={busy} onClick={() => setManual(items => items.filter((_, i) => i !== index).map(item => ({ ...item, dependsOn: (item.dependsOn ?? []).filter(key => key !== task.key) })))}>移除任务</button></fieldset>)}<button type="button" className="button button-quiet" disabled={busy || manual.some(t => !t.title.trim() || !t.criteria.trim())} onClick={() => void preview('manual', true)}>{manual.length ? '保存当前任务预览' : '确认暂不创建任务'}</button>{draft?.previewError && <p className="notice notice-warn">{draft.previewError}</p>}{draft?.preview && !previewCurrent && <p className="notice notice-warn">配置已变化，请重新保存预览。</p>}{previewCurrent && <p role="status">预览已保存：{draft.preview?.tasks.length} 个任务。进入下一步不会再次调用模型。</p>}</>}
 {step === 4 && <><dl className="wizard-summary"><dt>项目</dt><dd>{payload.name}</dd><dt>主目标</dt><dd>{manualGoal.title || payload.goal?.title || payload.name}</dd><dt>目标说明</dt><dd>{manualGoal.detail || '未填写'}</dd><dt>说明</dt><dd>{payload.description || '未填写'}</dd><dt>截止日期</dt><dd>{payload.deadlineDate ?? '未明确'}</dd><dt>文件</dt><dd>{draft?.files.map(f => f.name).join('、') || '无'}</dd><dt>人数与邀请</dt><dd>{payload.teamSize} 人（含负责人），{payload.inviteLabels.length + payload.inviteUsernames.length} 个邀请</dd><dt>AI 协作</dt><dd>{payload.aiCollaborationEnabled ? '开启' : '关闭'}</dd>{creationBehaviors.map(([key,label]) => <Fragment key={key}><dt>{label}</dt><dd>{creationBehavior(payload,key) === 'automatic' ? '自动执行' : '负责人确认'}</dd></Fragment>)}</dl>{draft?.preview?.tasks.map((task, index) => <article key={index} className="wizard-task"><strong>{task.title}</strong><p>{task.detail}</p><p>验收：{task.criteria} · {task.effortHours} 小时</p></article>)}<label className="field"><span><input type="checkbox" disabled={busy || !previewCurrent} checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/> 我已复核项目、文件、人数、邀请与任务配置</span></label><button type="button" className="button button-primary" disabled={busy || !confirmed || !previewCurrent || locals.length > 0} onClick={() => void run(async () => {
          if (!draft) {
            return;
          }
          const reviewed=draft;
          const latest: WizardDraft = await api.get<'CreationDraftResponse'>(draftPath(reviewed.id));
          const issue=confirmationIssue(latest,reviewed);
          if (issue) {
            accept(latest);
            // Keep locally reviewed goal/tasks on a failed or unfinished preview.
            if (canConfirmDraft(latest)) { setManual(latest.preview?.tasks ?? []); setManualGoal(latest.preview?.goal ?? latest.payload.goal ?? {title:latest.payload.name,detail:''}); }
            setStep(canConfirmDraft(latest) ? 4 : 3);
            throw new Error(issue);
          }
          const committed = await api.post<'CreationCommitResponse'>(draftPath(reviewed.id, '/commit'), {
            expectedRevision: latest.revision, confirmed: true, ...(latest.previewAttemptId ? {expectedPreviewAttemptId:latest.previewAttemptId} : {})
          });
          setResult(committed);
          remember(undefined, []);
          void queryClient.invalidateQueries({
            queryKey: ['projects']
          });
        })}>确认并创建项目</button></>}
 <div className="form-actions">{step > 0 && <button type="button" className="button button-quiet" disabled={busy} onClick={() => {
      setStep(s => s - 1);
      setConfirmed(false);
    }}>上一步</button>}{step < 3 && <button type="submit" className="button button-primary" disabled={busy || !payload.name.trim()}>下一步</button>}{step === 3 && <button type="button" className="button button-primary" disabled={busy || !previewCurrent || !sameTasks(manual, draft?.preview?.tasks ?? []) || Boolean(draft?.preview?.goal && JSON.stringify(manualGoal) !== JSON.stringify(draft.preview.goal))} onClick={() => {
      setStep(4);
      setConfirmed(false);
    }}>进入创建预览</button>}<button type="button" className="button button-quiet" disabled={busy} onClick={() => void run(async () => {
        if (payload.name.trim()) {
          await ensure();
        }
        navigate('/app');
      })}>保存草稿并返回</button>{draft && <button type="button" className="button button-quiet" disabled={busy} onClick={() => void run(async () => {
      accept(await api.post<'CreationDraftResponse'>(draftPath(draft.id, '/state'), {
        expectedRevision: draft.revision, status: 'cancelled'
      }));
      void list.refetch();
    })}>取消草稿（保留资料）</button>}</div>
 </>}
 {(actionBusy || previewRunning) && <p role="status">正在保存或核对结果，请稍候…</p>}{Boolean(error) && <ErrorNotice error={error}/>}{draft && <button type="button" className="button button-quiet button-small" disabled={busy} onClick={() => void openDraft(draft.id)}>刷新草稿状态</button>}
 </form></div>;
}
function sameTasks(a: WizardTask[], b: WizardTask[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}
