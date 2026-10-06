import { accountStorageKey } from '../features/pagination/account-storage-key';
import { VirtualList } from '../components/VirtualList';
import { usePagedItems } from '../features/pagination/usePagedItems';
import { LoadMore } from '../features/pagination/LoadMore';
import { AiReferenceBadge } from '../components/AiReferenceBadge';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Ban, Check, MessageSquareText, Play, RefreshCw, Send } from 'lucide-react';
import { RehearsalVoicePanel } from './RehearsalVoicePanel';
import { ReferencePicker } from './ReferencePicker';
import { api, projectPath } from '../api/client';
import { projectPermission } from '../project-permissions';
import { useCapabilities } from '../auth';
import { useProject } from '../components/ProjectShell';
import { EmptyState, ErrorNotice, Field, PageHeading, SectionCard, Spinner, StatusPill } from '../components/ui';
import type { DataOf } from '../api/types';
import { clearPendingJob, completeIntent, formatWorkflowDate, idempotencyKeyForIntent, jobStatusLabel, readPendingJob, readRecentIds, retryBackendJob, useVisibleJobPoller, writePendingJob, writeRecentId } from './aiWorkflowSupport';

type Rehearsal = DataOf<'RehearsalResponse'> & {initiatorId:string;respondentId:string;canOperate:boolean;processingJobId:string|null;processingStatus:string|null;turns:Array<DataOf<'RehearsalResponse'>['turns'][number]&{authorId?:string|null}>};
type PendingRehearsalJob = { jobId: string; entityId: string; action: 'create' | 'answer' | 'finish' | string };
const recentIdsKey = (projectId: string) => accountStorageKey(`recent-rehearsals:${projectId}`);
const pendingJobKey = (projectId: string) => accountStorageKey(`pending-rehearsal-job:${projectId}`);

export function RehearsalsPage({ rehearsalId: requestedId, embedded = false }: { rehearsalId?: string; embedded?: boolean }) {
  const { projectId, project } = useProject();
  const canInitiate=projectPermission(project,'scoreInitiate');
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const linkedId = requestedId ?? params.get('rehearsalId') ?? params.get('rehearsal') ?? '';
  const capabilities = useCapabilities();
  const materialQuery = usePagedItems<'MaterialListResponse'>({ searchable: true, queryKey: ['materials', projectId], path: projectPath(projectId, '/materials'), query: { limit: 100 } });
  const memberQuery = usePagedItems<'MemberListResponse'>({ searchable: true, queryKey: ['members', projectId], path: projectPath(projectId, '/members') });

  const members = useMemo(() => memberQuery.data ?? [], [memberQuery.data]);


  const [scope, setScope] = useState<'all' | 'member'>('all');
  const [memberId, setMemberId] = useState('');
  const [selectedMaterialVersionIds, setSelectedMaterialVersionIds] = useState<string[]>([]);
  const [selectedSourceVersionIds, setSelectedSourceVersionIds] = useState<string[]>([]);
  const historyQuery = usePagedItems<'RehearsalListResponse'>({ searchable: true, queryKey: ['rehearsals', projectId], path: projectPath(projectId, '/rehearsals') });
  const [localRecentIds, setRecentIds] = useState(() => readRecentIds(recentIdsKey(projectId)));
  const recentIds = Array.from(new Set([...(linkedId ? [linkedId] : []), ...(historyQuery.data ?? []).map(r => r.rehearsalId), ...localRecentIds]));
  const [selectedRehearsalId, setSelectedRehearsalId] = useState(() => linkedId || readRecentIds(recentIdsKey(projectId))[0] || '');
  const [pendingRehearsalJob, setPendingRehearsalJob] = useState<PendingRehearsalJob | null>(() => readPendingJob<PendingRehearsalJob>(pendingJobKey(projectId)));
  const [answerText, setAnswerText] = useState('');
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  useEffect(() => { setVoiceMode(false); }, [selectedRehearsalId]);
  const [createError, setCreateError] = useState<unknown>(null);
  const [answerError, setAnswerError] = useState<unknown>(null);
  const [finishError, setFinishError] = useState<unknown>(null);
  const [retryError, setRetryError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [sendingAnswer, setSendingAnswer] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [retryingJob, setRetryingJob] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<unknown>(null);
  const aiEnabled = capabilities.data?.features.aiEnabled === true;

  const rehearsalQuery = useQuery({
    queryKey: ['rehearsal', projectId, selectedRehearsalId],
    queryFn: () => api.get<'RehearsalResponse'>(projectPath(projectId, `/rehearsals/${encodeURIComponent(selectedRehearsalId)}`)),
    enabled: Boolean(selectedRehearsalId),
    staleTime: 0,
    refetchInterval: query => query.state.data?.status === 'active' ? 3000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const rehearsal = rehearsalQuery.data as Rehearsal | undefined;
  const serverPending = rehearsal?.processingJobId ? {jobId:rehearsal.processingJobId,entityId:rehearsal.rehearsalId,action:rehearsal.turns.length===0 ? 'create' : rehearsal.turns.at(-1)?.kind==='answer' ? 'answer' : 'finish'} : null;
  const visiblePending = rehearsal ? serverPending : (pendingRehearsalJob?.entityId===selectedRehearsalId ? pendingRehearsalJob : null);
  const job = useVisibleJobPoller(visiblePending?.jobId ?? null);
  const hasPendingJob = Boolean(serverPending || (visiblePending && !job.isSettled));
  const isFinishPending = visiblePending?.action === 'finish' && !job.isSettled;
  const answerJobFailed = visiblePending?.action === 'answer' && job.job?.status === 'failed';
  const latestTurn = rehearsal?.turns.at(-1);
  const canAnswer = rehearsal?.canOperate === true && rehearsal?.status === 'active' && !hasPendingJob && !isFinishPending && !answerJobFailed && (latestTurn?.kind === 'question' || latestTurn?.kind === 'followup');
  useEffect(() => { if (linkedId) setSelectedRehearsalId(linkedId); }, [linkedId]);

  useEffect(() => {
    if (memberId || members.length === 0) return;
    setMemberId(members[0]?.userId ?? '');
  }, [memberId, members]);
  useEffect(() => {
    if (!job.job || !job.isSettled || !pendingRehearsalJob || job.job.jobId !== pendingRehearsalJob.jobId) return;
    if (job.job.status === 'failed' || job.job.status === 'waiting_input') return;
    const clear = () => {
      clearPendingJob(pendingJobKey(projectId), pendingRehearsalJob.jobId);
      setPendingRehearsalJob((current) => current?.jobId === pendingRehearsalJob.jobId ? null : current);
    };
    if (job.job.status === 'succeeded') {
      void Promise.all([queryClient.invalidateQueries({ queryKey: ['rehearsal', projectId, pendingRehearsalJob.entityId] }), queryClient.invalidateQueries({ queryKey: ['assessments', projectId] }), queryClient.invalidateQueries({ queryKey: ['assessment', projectId] })]).then(clear, clear);
    } else clear();
  }, [job.job, job.isSettled, pendingRehearsalJob, projectId, queryClient]);

  const savePending = (rehearsalId: string, jobId: string, action: PendingRehearsalJob['action']) => {
    const pending = { jobId, entityId: rehearsalId, action };
    writePendingJob(pendingJobKey(projectId), pending);
    setPendingRehearsalJob(pending);
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!canInitiate || !aiEnabled || creating || (scope === 'member' && !memberId)) return;
    setCreating(true);
    setCreateError(null);
    const body = { scope, memberId: scope === 'member' ? memberId : null, materialVersionIds: [...selectedMaterialVersionIds].sort(), sourceVersionIds: [...selectedSourceVersionIds].sort() };
    const namespace = `rehearsal-create:${projectId}`;
    try {
      const key = await idempotencyKeyForIntent(namespace, body);
      const result = await api.post<'RehearsalCreateResponse'>(projectPath(projectId, '/rehearsals'), body, { idempotencyKey: key });
      completeIntent(namespace);
      const nextRecent = writeRecentId(recentIdsKey(projectId), result.rehearsalId);
      setRecentIds(nextRecent);
      setSelectedRehearsalId(result.rehearsalId);
      savePending(result.rehearsalId, result.jobId, 'create');
      setAnswerText('');
      void queryClient.invalidateQueries({ queryKey: ['rehearsals', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['rehearsal', projectId, result.rehearsalId] });
    } catch (error) {
      setCreateError(error);
    } finally {
      setCreating(false);
    }
  };

  const handleAnswer = async (event: FormEvent) => {
    event.preventDefault();
    if (!rehearsal || !canAnswer || !aiEnabled || sendingAnswer || !answerText.trim() || voiceBusy) return;
    const body = { content: answerText.trim() };
    const namespace = `rehearsal-answer:${projectId}:${rehearsal.rehearsalId}`;
    setSendingAnswer(true);
    setAnswerError(null);
    try {
      const key = await idempotencyKeyForIntent(namespace, body);
      const result = await api.post<'RehearsalAnswerResponse'>(projectPath(projectId, `/rehearsals/${encodeURIComponent(rehearsal.rehearsalId)}/answers`), body, { idempotencyKey: key });
      completeIntent(namespace);
      setAnswerText('');
      savePending(rehearsal.rehearsalId, result.jobId, 'answer');
      void queryClient.invalidateQueries({ queryKey: ['rehearsal', projectId, rehearsal.rehearsalId] });
    } catch (error) {
      setAnswerError(error);
      if (error instanceof Error && 'status' in error && (error as { status?: number }).status === 409) void rehearsalQuery.refetch();
    } finally {
      setSendingAnswer(false);
    }
  };

  const handleFinish = async () => {
    if (!rehearsal || !rehearsal.canOperate || rehearsal.status !== 'active' || hasPendingJob || voiceBusy || !aiEnabled || finishing || rehearsal.turns.length === 0) return;
    setFinishing(true);
    setFinishError(null);
    const namespace = `rehearsal-finish:${projectId}:${rehearsal.rehearsalId}`;
    try {
      const key = await idempotencyKeyForIntent(namespace, { rehearsalId: rehearsal.rehearsalId, action: 'finish' });
      const result = await api.post<'RehearsalFinishResponse'>(projectPath(projectId, `/rehearsals/${encodeURIComponent(rehearsal.rehearsalId)}/finish`), undefined, { idempotencyKey: key });
      completeIntent(namespace);
      savePending(rehearsal.rehearsalId, result.jobId, 'finish');
      void queryClient.invalidateQueries({ queryKey: ['rehearsal', projectId, rehearsal.rehearsalId] });
    } catch (error) {
      setFinishError(error);
      if (error instanceof Error && 'status' in error && (error as { status?: number }).status === 409) void rehearsalQuery.refetch();
    } finally {
      setFinishing(false);
    }
  };

  const handleCancel = async () => {
    if (!rehearsal || !rehearsal.canOperate || rehearsal.status !== 'active' || cancelling) return;
    if (!window.confirm('取消并删除本场答辩演练？本场问答和未完成评分不会保存，取消后无法恢复。')) return;
    setCancelling(true);
    setCancelError(null);
    try {
      await api.delete<'RehearsalCancelResponse'>(projectPath(projectId, `/rehearsals/${encodeURIComponent(rehearsal.rehearsalId)}`));
      if (pendingRehearsalJob?.entityId === rehearsal.rehearsalId) {
        clearPendingJob(pendingJobKey(projectId), pendingRehearsalJob.jobId);
        setPendingRehearsalJob(null);
      }
      const nextRecent = recentIds.filter(id => id !== rehearsal.rehearsalId);
      setRecentIds(nextRecent);
      try { localStorage.setItem(recentIdsKey(projectId), JSON.stringify(nextRecent)); } catch { /* The server has already deleted this rehearsal. */ }
      setSelectedRehearsalId(nextRecent[0] ?? '');
      setAnswerText('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['rehearsals', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['assessments', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['assessment', projectId] }),
        queryClient.removeQueries({ queryKey: ['rehearsal', projectId, rehearsal.rehearsalId] }),
      ]);
    } catch (error) {
      setCancelError(error);
      if (error instanceof Error && 'status' in error && (error as { status?: number }).status === 409) void rehearsalQuery.refetch();
    } finally {
      setCancelling(false);
    }
  };

  const handleRetryJob = async () => {
    if (!aiEnabled || !rehearsal?.canOperate || !visiblePending || job.job?.status !== 'failed' || retryingJob) return;
    setRetryingJob(true);
    setRetryError(null);
    try {
      const nextJobId = await retryBackendJob(projectId, visiblePending.jobId);
      savePending(visiblePending.entityId, nextJobId, visiblePending.action);
      void rehearsalQuery.refetch();
    } catch (error) {
      setRetryError(error);
    } finally {
      setRetryingJob(false);
    }
  };

  const removeRecent = () => {
    const next = recentIds.filter((id) => id !== selectedRehearsalId);
    setRecentIds(next);
    try { localStorage.setItem(recentIdsKey(projectId), JSON.stringify(next)); } catch { /* Keep the updated selection for this page visit. */ }
    setSelectedRehearsalId(next[0] ?? '');
  };

  const createDisabled = !canInitiate || !aiEnabled || capabilities.isLoading || Boolean(capabilities.error) || creating || (scope === 'member' && !memberId);

  return <div className="page-stack ai-workflow-layout">
    <LoadMore query={memberQuery} label="成员" />
    <LoadMore query={materialQuery} label="文档" />
    {!embedded && <PageHeading eyebrow="练习 / 答辩演练" title="围绕项目真实材料进行答辩练习" detail="按项目或成员负责部分开始文字演练。每轮问答由后端保存；结束后由后端生成总结。" />}
    {!capabilities.data && (capabilities.isLoading ? <div className="ai-workflow-note">正在读取后端 AI 能力，状态确认前不会发起演练。</div> : capabilities.error ? <ErrorNotice error={capabilities.error} onRetry={() => void capabilities.refetch()} /> : null)}
    {capabilities.data && !aiEnabled && <div className="ai-workflow-note is-warning"><strong>后端 AI 当前未启用。</strong> 不会创建模拟问题、追问或总结；已有真实演练可继续查看。</div>}

    <div className={embedded ? 'page-stack' : 'ai-workflow-grid'}>
      {!embedded && <SectionCard title="开始一场新演练" detail="选择演练范围和优先参考文件；本轮实际成果与真实问答会保留为固定依据。">
        {materialQuery.isLoading || memberQuery.isLoading ? <Spinner label="正在读取项目成员和材料" /> : <form className="ai-workflow-form-grid" onSubmit={(event) => void handleCreate(event)}>
          <Field aiReference label="演练范围">
            <select className="ai-workflow-select" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
              <option value="all">全项目答辩</option>
              <option value="member">按成员负责部分</option>
            </select>
          </Field>
          {scope === 'member' && <Field aiReference label="练习成员">
            <select className="ai-workflow-select" value={memberId} onChange={(event) => setMemberId(event.target.value)}>
              <option value="">选择项目成员</option>
              {members.map((member) => <option key={member.userId} value={member.userId}>{member.displayName} · {member.role === 'owner' ? '负责人' : '成员'}</option>)}
            </select>
          </Field>}
          <ReferencePicker projectId={projectId} sourceVersionIds={selectedSourceVersionIds} materialVersionIds={selectedMaterialVersionIds} onChange={selection => { setSelectedSourceVersionIds(selection.sourceVersionIds); setSelectedMaterialVersionIds(selection.materialVersionIds); }} disabled={creating} />
          {memberQuery.error && <div className="ai-workflow-field ai-workflow-field-wide"><ErrorNotice error={memberQuery.error} onRetry={() => void memberQuery.refetch()} /></div>}
          {Boolean(createError) && <div className="ai-workflow-field ai-workflow-field-wide"><ErrorNotice error={createError} /></div>}
          <div className="ai-workflow-actions ai-workflow-field-wide"><button className="button button-primary" type="submit" disabled={createDisabled}><Play size={15} />{creating ? '正在创建演练' : hasPendingJob ? '当前演练任务处理中' : '开始真实答辩演练'}</button>{scope === 'member' && !memberId && <span className="muted">请选择项目成员</span>}</div>
        </form>}
      </SectionCard>}

      <SectionCard title={embedded ? '答辩问答与反馈' : '最近的真实演练'} detail="问答由后端保存，结束后冻结本轮证据。">
        {historyQuery.error && <ErrorNotice error={historyQuery.error} onRetry={() => void historyQuery.refetch()} />}<LoadMore query={historyQuery} label="演练记录" />
        {recentIds.length > 0 ? <div className="stack">
          {!embedded && <div className="ai-workflow-session-picker">
            <select className="ai-workflow-select" aria-label="选择最近的答辩演练" value={selectedRehearsalId} onChange={(event) => setSelectedRehearsalId(event.target.value)}>
              <option value="">选择历史演练</option>{recentIds.map((id) => <option key={id} value={id}>演练 {id.slice(0, 8)} · {id}</option>)}
            </select>
            <button className="button button-quiet button-small" onClick={() => void rehearsalQuery.refetch()} disabled={!selectedRehearsalId || rehearsalQuery.isFetching}><RefreshCw size={14} />重新读取</button>
            <button className="button button-quiet button-small" onClick={removeRecent} disabled={!selectedRehearsalId}>从本机最近列表移除</button>
          </div>}
          {rehearsalQuery.isLoading ? <Spinner label="正在恢复答辩演练" /> : rehearsalQuery.error ? <ErrorNotice error={rehearsalQuery.error} onRetry={() => void rehearsalQuery.refetch()} /> : rehearsal ? <>
            <div className="ai-workflow-meta"><StatusPill tone={rehearsal.status === 'active' ? 'blue' : 'good'}>{rehearsal.status === 'active' ? '演练进行中' : '演练已结束'}</StatusPill><AiReferenceBadge /><span>{rehearsal.scope === 'all' ? '全项目' : `成员：${members.find((member) => member.userId === rehearsal.memberId)?.displayName ?? rehearsal.memberId ?? '未知'}`}</span><span>发起及答辩：{members.find(member=>member.userId===rehearsal.initiatorId)?.displayName ?? rehearsal.initiatorId}</span><span>开始于 {formatWorkflowDate(rehearsal.createdAt)}</span><span className="mono">ID {rehearsal.rehearsalId}</span></div>
            {visiblePending && <JobPanel jobId={visiblePending.jobId} job={job.job} error={job.error} retryError={retryError} loading={job.loading} retrying={retryingJob} canRetry={rehearsal.canOperate && aiEnabled && !capabilities.isLoading && Boolean(!capabilities.error)} action={visiblePending.action} onRetry={() => void handleRetryJob()} />}
            {job.job?.status === 'waiting_input' && <div className="ai-workflow-note is-warning">后端任务正在等待补充信息，当前页面不会补造问题或回答。</div>}
            {rehearsal.turns.length === 0 && <div className="ai-workflow-note">第一问由后端生成中。问题到达后会出现在下方对话记录中。</div>}
            {rehearsal.turns.length > 0 && <VirtualList className="ai-workflow-transcript" label="演练对话" items={rehearsal.turns} getKey={turn => String(turn.sequence)} renderItem={turn => <article className={`ai-workflow-transcript-turn ${turn.role === 'user' ? 'is-user' : ''} ${turn.kind === 'summary' ? 'is-summary' : ''}`} key={`${rehearsal.rehearsalId}-${turn.sequence}`}>
              <header><strong>{turn.role === 'user' ? '答辩人回答' : turn.kind === 'summary' ? '后端演练总结' : turn.kind === 'followup' ? '评委追问' : '评委问题'}</strong><AiReferenceBadge /><span>{formatWorkflowDate(turn.createdAt)}</span></header>
              <p>{turn.content}</p>
            </article>} />}
            {rehearsal.status === 'finished' && <div className="ai-workflow-note"><strong>演练结果已保存。</strong> 下方总结来自后端已保存的 summary 回合。</div>}
            {!rehearsal.canOperate && <div className="notice">本轮由 {members.find(m=>m.userId===rehearsal.initiatorId)?.displayName ?? rehearsal.initiatorId} 发起并答辩，其他成员只读，进展会自动刷新。</div>}
            {rehearsal.status === 'active' && rehearsal.canOperate && <form className="stack" onSubmit={(event) => void handleAnswer(event)}>
              <RehearsalVoicePanel key={`${rehearsal.rehearsalId}:${latestTurn?.sequence}:${rehearsal.respondentId}`} projectId={projectId} rehearsalId={rehearsal.rehearsalId} sequence={latestTurn?.sequence ?? 1} questionText={latestTurn?.content ?? ''} enabled={canAnswer && aiEnabled && !sendingAnswer && !finishing} initialVoiceMode={voiceMode} onModeChange={setVoiceMode} onBusyChange={setVoiceBusy} onTranscriptFinal={text => setAnswerText(current => `${current}${current ? '\n' : ''}${text}`.slice(0, 8000))} />
              <Field aiReference label="回答当前问题" hint={answerJobFailed ? '上一轮回答已保存，但后端处理失败。请重试任务后再提交下一轮。' : '每次提交会保存一轮回答，并等待后端生成追问或反馈。'}>
                <textarea className="input textarea ai-workflow-textarea" maxLength={8000} value={answerText} onChange={(event) => setAnswerText(event.target.value)} placeholder={canAnswer ? '围绕项目方案、证据和实施细节作答。' : '等待后端生成下一道问题后才能作答。'} disabled={!canAnswer || !aiEnabled || sendingAnswer || isFinishPending} />
              </Field>
              {Boolean(answerError) && <ErrorNotice error={answerError} onRetry={() => void rehearsalQuery.refetch()} />}
              {Boolean(finishError) && <ErrorNotice error={finishError} onRetry={() => void rehearsalQuery.refetch()} />}
              {Boolean(cancelError) && <ErrorNotice error={cancelError} onRetry={() => void rehearsalQuery.refetch()} />}
              <div className="ai-workflow-actions"><button className="button button-primary" type="submit" disabled={!canAnswer || !aiEnabled || sendingAnswer || voiceBusy || !answerText.trim()}><Send size={15} />{sendingAnswer ? '正在提交回答' : '提交回答'}</button><button className="button button-quiet" type="button" onClick={() => void handleFinish()} disabled={!aiEnabled || hasPendingJob || voiceBusy || finishing || isFinishPending || rehearsal.turns.length === 0}><Check size={15} />{finishing || isFinishPending ? '正在生成总结' : '结束并生成总结'}</button><button className="button button-quiet" type="button" onClick={() => void handleCancel()} disabled={cancelling}><Ban size={15} />{cancelling ? '正在取消' : '取消本场演练（不保存）'}</button>{!canAnswer && rehearsal.status === 'active' && <span className="muted">等候后端保存的问题后再提交回答。</span>}</div>
            </form>}
          </> : <EmptyState title="选择一场最近的演练" detail="演练记录只从真实服务端按其 ID 恢复。" />}
        </div> : <EmptyState title="还没有答辩演练" detail="创建演练后，可在此处和其他设备恢复。" />}
      </SectionCard>
    </div>
    {!capabilities.data?.features.aiEnabled && <div className="ai-workflow-meta"><MessageSquareText size={15} /><span>答辩问题、追问和总结均要求真实后端 AI 能力。AI 未启用时，只能查看已有真实演练。</span></div>}
  </div>;
}

function JobPanel({ jobId, job, error, retryError, loading, retrying, canRetry, action, onRetry }: { jobId: string; job: DataOf<'JobResponse'> | null; error: unknown; retryError: unknown; loading: boolean; retrying: boolean; canRetry: boolean; action: string; onRetry: () => void }) {
  const detail = action === 'create' ? '后端正在生成第一道问题。' : action === 'answer' ? '后端正在处理回答并生成下一轮。' : action === 'finish' ? '后端正在生成总结；此期间不会接受新的回答。' : '';
  return <div className="ai-workflow-job"><RefreshCw className={job && (job.status === 'queued' || job.status === 'running') ? 'spin' : ''} size={16} /><div><strong>{job ? jobStatusLabel(job.status) : loading ? '正在读取任务' : '等待任务状态'}</strong><p>{detail} 后端任务 ID {jobId}{job ? ` · 第 ${job.attempts} 次执行` : ''}</p>{Boolean(error) && <ErrorNotice error={error} />}{job?.status === 'failed' && <><ErrorNotice error={job.error ?? new Error('任务执行失败。')} /><button className="button button-quiet button-small" onClick={onRetry} disabled={retrying || !canRetry}><RefreshCw size={13} />{retrying ? '正在重试' : canRetry ? '重试后端任务' : '后端 AI 未启用，暂不可重试'}</button></>}{Boolean(retryError) && <ErrorNotice error={retryError} />}</div></div>;
}
