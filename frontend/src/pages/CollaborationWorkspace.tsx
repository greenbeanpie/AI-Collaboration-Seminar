import { defaultTaskDraft as defaultDraft, useTaskOperations } from '../features/collaboration/useTaskOperations';
import { useCollaborationQueries } from '../features/collaboration/useCollaborationQueries';
import { LoadMore } from '../features/pagination/LoadMore';
import { VirtualList } from '../components/VirtualList';
import { lifecycleLabels, taskStateLabel, type FeedbackSnapshot } from '../features/collaboration/labels';
import { JobProgress } from '../features/collaboration/JobProgress';
import { ProposalPreview } from '../features/collaboration/ProposalPreview';
import { TaskLifecycleDetail } from '../features/collaboration/TaskLifecycleDetail';
import { AiReferenceBadge } from '../components/AiReferenceBadge';
import { canManageProjectPermissions, projectPermission } from '../project-permissions';
import { RemovedSourceNotice } from './RemovedSourceNotice';
import { TaskAiAssistance } from './TaskAiAssistance';
import { TaskAgentAction } from './TaskAgentAction';
import { TaskInquiries } from './TaskInquiries';
import { ProjectSearchOption,ProjectToolCalls } from './ProjectAiTools';
import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Plus, Sparkles, UserRound } from 'lucide-react';
import { collaborationApi, type CollaborationTask, type CollaborationProposal } from '../api/collaboration';
import { useCapabilities } from '../auth';
import { useProject } from '../components/ProjectShell';
import { EmptyState, ErrorNotice, Field, Modal, SectionCard, Spinner, StatusPill } from '../components/ui';
import { useVisibleJobPoller } from './aiWorkflowSupport';
import { ReferencePicker } from './ReferencePicker';
import './ProjectWorkspace.css';
import { projectRequest } from '../api/simplification';
import { dependencyOrder } from './task-dependencies';
import { DateInput } from '../components/DateInput';
import './CollaborationWorkspace.css';
import { taskSummarySource, taskSummaryPreview, useTaskSummaries } from './useTaskSummaries';
import { ProposalCorrection } from './ProposalCorrection';
import { AiClarificationCard } from '../components/AiClarificationCard';
import { clarificationApi, clarificationFromJob, clarificationQueryKey, type ProjectClarification, type ClarificationAnswer } from '../api/clarifications';


export function CollaborationWorkspace() {
  const { projectId } = useProject();
  return <ProjectCollaborationWorkspace key={projectId} />;
}

function ProjectCollaborationWorkspace() {
  const [allowSearch, setAllowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { projectId, project } = useProject();
  const client = useQueryClient();
  const owner = projectPermission(project,'taskManage');
  // 项目持续反馈仅负责人可修改，与后端 requireProjectAdministrator 保持一致。
  const feedbackAdmin = canManageProjectPermissions(project);
  const { feedback, feedbackHistory, graph, goal, settings, members, me, unread } = useCollaborationQueries(projectId);
  const capabilities = useCapabilities();
  const modelEnabled = capabilities.data?.features.aiEnabled === true;
  const [taskSearch, setTaskSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const taskPages = useInfiniteQuery({ queryKey: ['collaboration-tasks', projectId, 'pages', taskSearch, statusFilter], initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => collaborationApi.tasks(projectId, { networkOnly: navigator.onLine !== false, signal, cursor: pageParam, q: taskSearch, ...(statusFilter === 'pending_review' ? { pendingReview: true } : statusFilter !== 'all' ? { lifecycleState: statusFilter } : {}) }),
    getNextPageParam: page => page.nextCursor ?? undefined, placeholderData: previous => previous, refetchInterval: 30_000 });
  const tasks = { ...taskPages, data: taskPages.data ? { items: taskPages.data.pages.flatMap(page => page.items) } : undefined };
  const aiEnabled = modelEnabled && settings.data?.aiCollaborationEnabled === true;
  const proposalPages = useInfiniteQuery({ queryKey: ['collaboration-proposals', projectId, 'pages'], initialPageParam: null as string | null, queryFn: ({ pageParam }) => collaborationApi.proposals(projectId, pageParam), getNextPageParam: page => ('nextCursor' in page ? page.nextCursor as string | null : null) ?? undefined });
  const proposals = { ...proposalPages, data: proposalPages.data ? { items: proposalPages.data.pages.flatMap(page => page.items) } : undefined };
  const [createOpen, setCreateOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [draft, setDraft] = useState(defaultDraft);
  const [createDependencies, setCreateDependencies] = useState<string[]>([]);
  const [createGraphRevision, setCreateGraphRevision] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();
  const historyType = searchParams.get('view') === 'history' ? searchParams.get('historyType') : null;
  const historyPage = historyType === 'proposals' || historyType === 'submissions';
  const proposalHistory = historyType === 'proposals';
  const selectedId = searchParams.get('task') ?? '';
  const [lastSelectedId, setLastSelectedId] = useState(selectedId);
  const selectedAction = searchParams.get('taskAction') === 'settings' ? 'settings' : 'submit';
  const inquiryId = searchParams.get('taskAction') === 'inquiries' ? selectedId : '';
  const settingsClose = useRef<(() => Promise<boolean>) | null>(null);
  const setInquiryId = (id: string) => { const next = new URLSearchParams(searchParams); if (id) { next.set('task', id); next.set('taskAction', 'inquiries'); } else { next.delete('task'); next.delete('taskAction'); } setSearchParams(next, { replace: true }); };
  const [agentTaskId, setAgentTaskId] = useState('');
  const openHistory = (type: 'proposals' | 'submissions', recordId?: string) => {
    const next = new URLSearchParams(searchParams); next.set('view', 'history'); next.set('historyType', type);
    if (recordId) next.set('record', recordId); else next.delete('record'); setSearchParams(next);
  };
  const returnFromHistory = () => {
    const next = new URLSearchParams(searchParams); next.delete('view'); next.delete('historyType'); next.delete('record'); setSearchParams(next);
    if (proposalHistory) setAiOpen(true);
  };
  const orderedProposals = [...(proposals.data?.items ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.proposalId.localeCompare(a.proposalId));
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null);
  const activeProposal = activeProposalId ? orderedProposals.find(item => item.proposalId === activeProposalId) : orderedProposals[0];
  useEffect(() => { if (!activeProposalId && activeProposal) setActiveProposalId(activeProposal.proposalId); }, [activeProposalId, activeProposal]);
  const proposalRecord = orderedProposals.find(item => item.proposalId === searchParams.get('record')) ?? orderedProposals[0];
  const proposalIndex = proposalRecord ? orderedProposals.indexOf(proposalRecord) : 0;
  const chooseProposal = (id: string) => { const next = new URLSearchParams(searchParams); next.set('record', id); setSearchParams(next); };
  useEffect(() => {
    if (proposalHistory && proposalRecord && !searchParams.get('record')) {
      const next = new URLSearchParams(searchParams); next.set('record', proposalRecord.proposalId); setSearchParams(next, { replace: true });
    }
  }, [proposalHistory, proposalRecord, searchParams, setSearchParams]);
  const setSelectedId = (id: string, action: 'submit' | 'settings' = 'submit') => { const next = new URLSearchParams(searchParams); if (id) { setLastSelectedId(id); next.set('task', id); if (action === 'settings') next.set('taskAction', action); else next.delete('taskAction'); } else { next.delete('task'); next.delete('taskAction'); } setSearchParams(next, { replace: true }); };
  const [brief, setBrief] = useState('');
  const [feedbackBase,setFeedbackBase]=useState<number|null>(null);
  useEffect(()=>{if(feedback.data && feedbackBase===null){setBrief(feedback.data.feedback);setFeedbackBase(feedback.data.version);}},[feedback.data,feedbackBase]);
  const saveFeedback=useMutation({mutationFn:async()=>{if(feedbackBase===null)throw new Error('持续反馈尚未读取，请稍后重试');const result=await projectRequest<FeedbackSnapshot>(projectId,'/collaboration/feedback/current',{method:'POST',body:{feedback:brief,expectedVersion:feedbackBase}});setFeedbackBase(result.version);client.setQueryData(['project-feedback',projectId],result);await client.invalidateQueries({queryKey:['project-feedback-history',projectId]});return result;}});
  const [sourceVersions, setSourceVersions] = useState<string[]>([]);
  const [contextMaterialVersions, setContextMaterialVersions] = useState<string[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobRefresh, setJobRefresh] = useState(0);
  const job = useVisibleJobPoller(jobId, jobRefresh);
  const resolvedQuestions = useRef(new Set<string>());
  const clarifications = useQuery({
    queryKey: clarificationQueryKey(projectId),
    queryFn: ({ signal }) => clarificationApi.list(projectId, signal),
    enabled: owner,
    retry: false,
    refetchOnMount: 'always',
    refetchInterval: jobId && !job.isSettled ? 3000 : false,
    refetchIntervalInBackground: false,
  });
  const jobQuestion = job.job?.status === 'waiting_input' && jobId ? clarificationFromJob(job.job.result, jobId) : null;
  const questions = (owner ? clarifications.data?.items ?? [] : []).filter(question => question.status === 'pending' && !resolvedQuestions.current.has(question.id));
  if (jobQuestion && !resolvedQuestions.current.has(jobQuestion.id) && !questions.some(question => question.id === jobQuestion.id)) questions.push(jobQuestion);
  const waitingForAnswer = questions.length > 0 || job.job?.status === 'waiting_input';
  useEffect(() => {
    if (job.job?.status === 'waiting_input') void client.invalidateQueries({ queryKey: clarificationQueryKey(projectId) });
  }, [job.job?.status, job.job?.result, client, projectId]);
  const refreshClarifications = async () => {
    const refreshed = await clarifications.refetch();
    if (refreshed.error) throw refreshed.error;
    setJobRefresh(value => value + 1);
  };
  const resolveClarification = async (question: ProjectClarification, answer?: ClarificationAnswer) => {
    const result = answer
      ? await clarificationApi.answerProject(projectId, question, answer)
      : await clarificationApi.cancelProject(projectId, question);
    resolvedQuestions.current.add(question.id);
    client.setQueryData<{ items: ProjectClarification[] }>(clarificationQueryKey(projectId), current => ({ items: (current?.items ?? []).filter(item => item.id !== question.id) }));
    setJobId(result.jobId);
    setJobRefresh(value => value + 1);
    setHandoffNotice(answer ? '回答已提交，AI 将继续本次任务。' : '本次 AI 操作已取消。');
    void client.invalidateQueries({ queryKey: clarificationQueryKey(projectId) });
  };
  const followedJobs = useRef(new Set<string>());
  const [handoffNotice, setHandoffNotice] = useState('');
  useEffect(() => {
    const result = job.job?.result;
    if (job.job?.status !== 'succeeded' || !result || typeof result !== 'object') return;
    const output = result as Record<string, unknown>;
    if (typeof output.followupJobId === 'string' && !followedJobs.current.has(output.followupJobId)) {
      followedJobs.current.add(output.followupJobId); setHandoffNotice('任务已拆解，正在跟进服务端创建的分工任务。'); setJobId(output.followupJobId);
    }
  }, [job.job]);
  const rows = dependencyOrder(tasks.data?.items ?? []);
  const canRegenerate = graph.data?.canRegenerate === true;
  const summaries = useTaskSummaries(projectId, rows, aiEnabled);
  const detailId = selectedId || lastSelectedId;
  const taskDetail = useQuery({ queryKey: ['collaboration-task', projectId, detailId], queryFn: () => projectRequest<CollaborationTask>(projectId, `/tasks/${encodeURIComponent(detailId)}`), enabled: Boolean(detailId) && !(graph.data?.items ?? []).some(row => row.taskId === detailId) });
  const selected = rows.find(row => row.taskId === detailId) ?? taskDetail.data;
  useEffect(() => { if (job.isSettled) { void client.invalidateQueries({ queryKey: ['collaboration-tasks', projectId] }); void client.invalidateQueries({ queryKey: ['collaboration-proposals', projectId] }); void client.invalidateQueries({ queryKey: ['collaboration-submissions', projectId] }); } }, [job.isSettled, jobId, client, projectId]);
  const { create, claim, invalidate } = useTaskOperations(projectId, draft, createDependencies, createGraphRevision, () => { setCreateOpen(false); setDraft(defaultDraft); setCreateDependencies([]); });
  const ai = useMutation({ mutationFn: async (action: 'decompose' | 'adjust' | 'assign') => { if (!graph.data) throw new Error('完整依赖图尚未读取，请稍后重试'); if(action === 'decompose' && !canRegenerate) throw new Error('已有任务曾开始，只能提出调整或补充建议'); if(feedbackAdmin && brief !== feedback.data?.feedback) await saveFeedback.mutateAsync(); return action === 'decompose' ? collaborationApi.decompose(projectId, '依据项目主目标与已保存的持续项目反馈生成任务拆解方案', sourceVersions,{allowSearch,searchQuery}, contextMaterialVersions) : action === 'adjust' ? collaborationApi.adjustTasks(projectId, '依据已保存的持续项目反馈提出当前任务调整方案', (graph.data?.items ?? []).filter(row => ['open', 'in_progress', 'improve', 'rework'].includes(row.lifecycleState)).map(row => row.taskId), sourceVersions,{allowSearch,searchQuery}, contextMaterialVersions) : collaborationApi.suggestAssignments(projectId, (graph.data?.items ?? []).filter(row => !row.assigneeId && row.lifecycleState === 'open').map(row => row.taskId)); }, onSuccess: result => { setHandoffNotice(''); setJobId(result.jobId); } });
  const renderProposal = (proposal: CollaborationProposal, readOnly = false) => (<article key={proposal.proposalId} className="collab-proposal"><AiReferenceBadge /><div className="collab-toolbar"><strong>{proposal.kind === 'decompose' ? proposal.payload.updates?.length ? '任务调整建议' : '任务拆解建议' : '团队分工建议'}</strong><StatusPill>{proposal.status === 'applied' ? '已应用' : proposal.status === 'stale' ? '已过期' : '待确认'}</StatusPill></div>{!readOnly && owner && <ProposalCorrection key={proposal.proposalId} projectId={projectId} proposal={proposal} members={members.data ?? []} onChanged={invalidate} canApprove={owner} />}<RemovedSourceNotice payload={proposal.payload} /><ProposalPreview payload={proposal.payload} members={members.data ?? []} tasks={rows} /></article>);
  return <SectionCard title={historyPage ? '任务历史' : '任务'} detail={historyPage ? '每页展示一条记录，保留提交时的内容与固定版本引用。' : '按前置依赖顺序显示。依赖仅作提示，可提前认领、执行和提交成果。'}>
    <div hidden={historyPage}><div className="collab-toolbar"><div className="chip-list"><span className="chip">{graph.data ? `共 ${graph.data.totals.total} 项 · 已完成 ${graph.data.totals.done} 项` : '完整任务统计读取中'} · 当前载入 {rows.length} 项</span><span className="chip">分工：{!settings.data ? '尚未读取' : settings.data.assignmentMode === 'automatic' ? '自动应用 AI' : '负责人确认'}</span><span className="chip">验收：{!settings.data ? '尚未读取' : settings.data.evaluationMode === 'automatic' ? '自动应用 AI' : '负责人确认'}</span></div><label className="collab-filter"><span>筛选</span><select className="input" aria-label="筛选" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">全部任务</option><option value="pending_review">已完成（待人工审核）</option>{Object.entries(lifecycleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><div className="collab-toolbar-actions">{<button className="button button-quiet" aria-expanded={aiOpen} aria-controls="collab-ai-panel" onClick={() => setAiOpen(true)}><Sparkles size={16} />AI 拆解、调整与分工</button>}{owner && <button className="button button-primary" disabled={!goal.data} onClick={() => { create.reset(); setCreateGraphRevision(goal.data!.graphRevision); setCreateOpen(true); }}><Plus size={16} />新建任务</button>}</div></div>
    </div>
    {!historyPage && <>
      {owner && clarifications.error && <ErrorNotice error={clarifications.error} onRetry={() => void clarifications.refetch()} />}
      {!owner && questions.map(question => <AiClarificationCard key={question.id} question={question} onAnswer={answer => resolveClarification(question, answer)} onCancel={() => resolveClarification(question)} onRefresh={refreshClarifications} />)}
      {owner && questions.length > 0 && <div className="notice notice-warn" role="status"><span>AI 等待你的回答，本次操作已暂停。</span><button type="button" className="button button-quiet" onClick={() => setAiOpen(true)}>回答 AI 的问题（{questions.length}）</button></div>}
      {waitingForAnswer && !questions.length && <p role="status">AI 正在等待补充信息，正在核对待回答问题。</p>}
      {jobId && !aiOpen && <JobProgress job={job} />}
    </>}
    {<Modal title={proposalHistory ? 'AI 建议历史' : 'AI 拆解、调整与分工'} mode={proposalHistory ? 'page' : aiOpen && !historyPage ? 'dialog' : 'hidden'} onClose={proposalHistory ? returnFromHistory : () => setAiOpen(false)} headerActions={!proposalHistory ? <button className="button button-quiet" onClick={() => openHistory('proposals', orderedProposals[0]?.proposalId)}>历史记录</button> : undefined}>
    <section id="collab-ai-panel" className="collab-ai" aria-label="AI 拆解、调整与分工">
      <div className="stack" hidden={proposalHistory}>
      {questions.map(question => <AiClarificationCard key={question.id} question={question} onAnswer={answer => resolveClarification(question, answer)} onCancel={() => resolveClarification(question)} onRefresh={refreshClarifications} />)}
      {!aiEnabled && <p className="notice notice-warn">{!settings.data?.aiCollaborationEnabled ? '本项目 AI 智能协作已关闭，请由负责人在项目设置开启。' : 'AI 模型当前不可用。'}</p>}
      <ReferencePicker projectId={projectId} sourceVersionIds={sourceVersions} materialVersionIds={contextMaterialVersions} onChange={selection=>{setSourceVersions(selection.sourceVersionIds);setContextMaterialVersions(selection.materialVersionIds);}} disabled={!owner || ai.isPending}/>
      {aiEnabled && <ProjectSearchOption projectId={projectId} enabled={allowSearch} onChange={setAllowSearch} query={searchQuery} onQuery={setSearchQuery}/>}
      <Field aiReference label="持续项目反馈"><textarea className="input" rows={3} maxLength={12000} readOnly={!feedbackAdmin} value={brief} onChange={event => setBrief(event.target.value)} placeholder="保存项目目标、补充信息和持续调整要求；后续项目 AI 操作会使用当前保存版本" /></Field>

      {feedback.error && <ErrorNotice error={feedback.error}/>}{saveFeedback.error && <><ErrorNotice error={saveFeedback.error}/><button className="button button-quiet" onClick={async()=>{const result=await feedback.refetch();if(result.data){setBrief(result.data.feedback);setFeedbackBase(result.data.version);saveFeedback.reset();}}}>重新载入已保存反馈</button></>}
      {feedbackAdmin && <button className="button" disabled={feedbackBase===null || saveFeedback.isPending || ai.isPending || brief===feedback.data?.feedback} onClick={()=>saveFeedback.mutate()}>保存反馈</button>}
      {saveFeedback.isSuccess && <p role="status">反馈已保存</p>}
      <div className="form-actions"><button className="button" disabled={!canRegenerate || feedbackBase===null || saveFeedback.isPending || !owner || !aiEnabled || (allowSearch&&!searchQuery.trim()) || ai.isPending || waitingForAnswer || (!!jobId && !job.isSettled)} onClick={() => ai.mutate('decompose')}>重新生成整套任务建议</button><button className="button" disabled={feedbackBase===null || saveFeedback.isPending || !owner || !aiEnabled || (allowSearch&&!searchQuery.trim()) || ai.isPending || !(graph.data?.items ?? []).some(row => ['open', 'in_progress', 'improve', 'rework'].includes(row.lifecycleState)) || waitingForAnswer || (!!jobId && !job.isSettled)} onClick={() => ai.mutate('adjust')}>按要求调整现有任务</button><button className="button" disabled={feedbackBase===null || saveFeedback.isPending || !owner || !aiEnabled || ai.isPending || !(graph.data?.items ?? []).some(row => !row.assigneeId && row.lifecycleState === 'open') || waitingForAnswer || (!!jobId && !job.isSettled)} onClick={() => ai.mutate('assign')}>建议未认领任务分工</button></div>
      {ai.error && <ErrorNotice error={ai.error} />}
      {handoffNotice && <p className="form-note">{handoffNotice}</p>}
      <JobProgress job={job} />
      {(job.job as unknown as {feedbackSnapshot?:FeedbackSnapshot})?.feedbackSnapshot && <details><summary>本次使用的持续反馈版本 {(job.job as unknown as {feedbackSnapshot:FeedbackSnapshot}).feedbackSnapshot.version}</summary><p style={{whiteSpace:'pre-wrap'}}>{(job.job as unknown as {feedbackSnapshot:FeedbackSnapshot}).feedbackSnapshot.feedback || '未设置持续反馈'}</p></details>}
      {jobId&&<ProjectToolCalls projectId={projectId} jobId={jobId}/>}
      <LoadMore query={proposalPages} label="AI 建议" />
      {proposals.error && <ErrorNotice error={proposals.error} />}
      {activeProposal && renderProposal(activeProposal, !owner)}
      {activeProposal && orderedProposals[0]?.proposalId !== activeProposal.proposalId && <p className="form-note">有新的 AI 建议。为保留当前修改，请通过标题栏“历史记录”选择需要处理的建议。</p>}
      </div>
      {proposalHistory && <><h3>持续反馈版本历史</h3>{feedbackHistory.error && <ErrorNotice error={feedbackHistory.error}/>}<div className="stack">{feedbackHistory.data?.items.map(item=><article className="form-note" key={item.versionId}><AiReferenceBadge /><strong>版本 {item.version} · {item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : ''}</strong><p style={{whiteSpace:'pre-wrap'}}>{item.feedback || '已清空持续反馈'}</p></article>)}</div><h3>AI 建议历史</h3>{proposals.isLoading && <Spinner label="读取 AI 建议历史" />}{!proposals.isLoading && !proposals.error && !proposalRecord && <p className="muted">尚无 AI 建议记录。</p>}{proposalRecord && <div className="collab-history-pager"><button className="button button-small" disabled={proposalIndex === 0} onClick={() => chooseProposal(orderedProposals[proposalIndex - 1]!.proposalId)}>上一页</button><Field label="选择建议记录"><select className="input" value={proposalRecord.proposalId} onChange={event => chooseProposal(event.target.value)}>{orderedProposals.map((item, index) => <option key={item.proposalId} value={item.proposalId}>记录 {orderedProposals.length - index} · {new Date(item.createdAt).toLocaleString('zh-CN')}</option>)}</select></Field><span aria-live="polite">第 {proposalIndex + 1} / {orderedProposals.length} 页</span><button className="button button-small" disabled={proposalIndex === orderedProposals.length - 1} onClick={() => chooseProposal(orderedProposals[proposalIndex + 1]!.proposalId)}>下一页</button></div>}</>}
      {proposals.error && proposalHistory && <ErrorNotice error={proposals.error} />}
      {proposalHistory && proposalRecord && <>{renderProposal(proposalRecord, true)}<button className="button button-quiet" onClick={() => { setActiveProposalId(proposalRecord.proposalId); returnFromHistory(); }}>打开此建议进行处理</button></>}
    </section></Modal>}
    <div hidden={historyPage}>
    {[tasks.error, graph.error, taskDetail.error, settings.error, members.error, me.error, claim.error].filter(Boolean).map((error, index) => <ErrorNotice key={index} error={error} />)}
    {tasks.isLoading && <Spinner label="读取协作任务" />}
    {!tasks.isLoading && !tasks.error && !rows.length && <EmptyState title="把交付目标变成明确任务" detail="先写清完成标准与预计投入，再由成员认领。无需开启 AI。" />}
    <Field label="按名称筛选任务"><input className="input" type="search" value={taskSearch} onChange={event => setTaskSearch(event.target.value)} /></Field>
    <VirtualList label="协作任务" className="collab-grid" items={rows.filter(task => statusFilter === 'all' || (statusFilter === 'pending_review' ? task.pendingHumanReview : task.lifecycleState === statusFilter && (statusFilter !== 'accepted' || !task.pendingHumanReview)))} getKey={task => task.taskId} renderItem={task => <article className="collab-task" key={task.taskId}>
      <div className="collab-toolbar"><div className="collab-task-status"><StatusPill tone={task.pendingHumanReview ? 'warn' : task.lifecycleState === 'accepted' ? 'good' : ['improve', 'rework'].includes(task.lifecycleState) ? 'warn' : 'blue'}>{taskStateLabel(task)}</StatusPill>{(task.unfinishedDependencyIds?.length ?? 0) > 0 && <span className="collab-dependency-warning" tabIndex={0} aria-label="前置任务未完成，可提前认领、执行和提交。">前置任务未完成<span role="tooltip">前置任务未完成，可提前认领、执行和提交。</span></span>}</div><small>{task.effortHours} 小时</small></div>
      <button title={task.title} className="collab-title" onClick={() => setSelectedId(task.taskId)}>{task.title}</button><AiReferenceBadge />
      <p className="collab-criteria">{taskSummaryPreview(task)}</p>{summaries.errors[task.taskId] && <ErrorNotice error={summaries.errors[task.taskId]} />}{Array.from(taskSummarySource(task)).length > 60 && !task.summary && <small className="collab-summary-status">原文节选{summaries.errors[task.taskId] || task.summaryStatus === 'failed' ? ' · 摘要生成失败' : task.summaryStatus === 'queued' || task.summaryStatus === 'running' ? ' · AI 正在总结' : ''}{aiEnabled && (summaries.errors[task.taskId] || task.summaryStatus === 'failed') && <button className="button button-quiet button-small" disabled={summaries.retryBusy} onClick={() => summaries.retry(task)}>重试摘要</button>}</small>}
      {(task.dependsOnTaskIds?.length ?? 0) > 0 && <small className="collab-task-dependencies">前置任务：{task.dependsOnTaskIds!.map(id => rows.find(row => row.taskId === id)?.title ?? id).join('、')}</small>}
      <div className="collab-toolbar collab-task-footer"><span className="tm-meta-item"><UserRound size={14} />{members.data?.find(member => member.userId === task.assigneeId)?.displayName ?? (task.assigneeId ? '项目成员' : '尚未认领')}</span>{!task.assigneeId && task.lifecycleState === 'open' && <button className="button button-primary button-small" disabled={claim.isPending || !me.data} onClick={() => claim.mutate(task)}>我来认领</button>}<button className="button button-quiet button-small" onClick={() => setSelectedId(task.taskId)}>查看与提交</button><button className="button button-quiet button-small" onClick={() => setInquiryId(task.taskId)}>任务质询{(unread.data?.items.find(item => item.taskId === task.taskId)?.unreadCount ?? 0) > 0 && <span className="task-inquiry-unread" aria-label="有未读质询">{unread.data!.items.find(item => item.taskId === task.taskId)!.unreadCount}</span>}</button><TaskAgentAction projectId={projectId} task={task} onHandoff={() => setAgentTaskId(task.taskId)} /><button className="button button-quiet button-small" onClick={() => setSelectedId(task.taskId, 'settings')}>任务设置</button></div>
    </article>} />
    <LoadMore query={taskPages} label="任务" />
    {createOpen && <Modal title="新建任务" onClose={() => setCreateOpen(false)}><form className="stack" onSubmit={event => { event.preventDefault(); create.mutate(); }}>
      <Field aiReference label="任务名称"><input className="input" required maxLength={200} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></Field>
      <Field aiReference label="任务说明"><textarea className="input" rows={3} maxLength={4000} value={draft.detail} onChange={event => setDraft({ ...draft, detail: event.target.value })} /></Field>
      <LoadMore query={members} label="成员" /><Field aiReference label="任务执行人（选填）"><select className="input" value={draft.assigneeId} onChange={event => setDraft({ ...draft, assigneeId: event.target.value })}><option value="">暂不分配，由成员认领</option>{members.data?.map(member => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}</select></Field>
      <Field aiReference label="验收标准" hint="写明可核对的交付物、质量要求与完成条件。"><textarea className="input" required rows={4} maxLength={4000} value={draft.criteria} onChange={event => setDraft({ ...draft, criteria: event.target.value })} /></Field>
      <div className="form-grid-two"><Field aiReference label="预计投入（小时）"><input className="input" type="number" required min="0.25" max="200" step="0.25" value={draft.effortHours} onChange={event => setDraft({ ...draft, effortHours: event.target.value })} /></Field><Field aiReference label="截止日期（选填）"><DateInput className="input" type="date" value={draft.dueDate} onChange={event => setDraft({ ...draft, dueDate: event.target.value })} /></Field></div>
      <fieldset><legend>前置任务（可多选）<AiReferenceBadge ariaHidden /></legend>{(graph.data?.items ?? []).map(task => <label className="collab-version" key={task.taskId}><input type="checkbox" checked={createDependencies.includes(task.taskId)} onChange={event => setCreateDependencies(ids => event.target.checked ? [...ids, task.taskId] : ids.filter(id => id !== task.taskId))} />{task.title}</label>)}</fieldset>
      {goal.data && createGraphRevision !== goal.data.graphRevision && <p className="notice notice-warn">任务依赖已变化，草稿保留。请复核前置选择后确认使用最新依赖图。<button type="button" className="button button-quiet" onClick={() => setCreateGraphRevision(goal.data!.graphRevision)}>已复核前置任务</button></p>}
      {create.error && <ErrorNotice error={create.error} />}<div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setCreateOpen(false)}>取消</button><button className="button button-primary" disabled={create.isPending || !draft.title.trim() || !draft.criteria.trim() || createGraphRevision !== goal.data?.graphRevision}>{create.isPending ? '创建中…' : '确认新建任务'}</button></div>
    </form></Modal>}
    </div>
    {historyPage && ((historyType === 'submissions' && !selected && !tasks.isLoading)) && <><button className="button button-quiet" onClick={returnFromHistory}>返回任务操作</button><EmptyState title="历史记录不可用" detail="该任务不在当前项目中，或你没有查看权限。" /></>}
    {inquiryId && <Modal title="任务质询" onClose={() => setInquiryId('')}><TaskInquiries key={inquiryId} projectId={projectId} taskId={inquiryId} taskTitle={rows.find(row => row.taskId === inquiryId)?.title} meId={me.data?.userId} members={members.data ?? []}/></Modal>}
    {agentTaskId && rows.find(row => row.taskId === agentTaskId) && <Modal title="AI 辅助" onClose={() => setAgentTaskId('')}><TaskAiAssistance projectId={projectId} task={rows.find(row => row.taskId === agentTaskId)!} tasks={rows}/></Modal>}
    {selected && <Modal title={historyType === 'submissions' ? `${selected.title} · 提交与验收历史` : selectedAction === 'settings' ? `任务设置·${selected.title}` : selected.title} mode={historyType === 'submissions' ? 'page' : historyPage || !selectedId || !!inquiryId ? 'hidden' : 'dialog'} headerActions={selectedAction === 'submit' && historyType !== 'submissions' ? <button className="button button-quiet" onClick={() => openHistory('submissions')}>查看历史记录</button> : undefined} onClose={historyType === 'submissions' ? returnFromHistory : async () => { if (selectedAction !== 'settings' || !settingsClose.current || await settingsClose.current()) setSelectedId(''); }}><TaskLifecycleDetail closeGuard={settingsClose} view={selectedAction} key={selected.taskId} projectId={projectId} task={selected} tasks={graph.data?.items ?? rows} graphRevision={goal.data?.graphRevision} owner={owner} meId={me.data?.userId} members={members.data ?? []} onChanged={invalidate} /></Modal>}
  </SectionCard>;
}

