import { projectPermission } from '../project-permissions';
import { RemovedSourceNotice } from './RemovedSourceNotice';
import { TaskAiAssistance } from './TaskAiAssistance';
import { TaskAgentAction } from './TaskAgentAction';
import { TaskInquiries } from './TaskInquiries';
import { ProjectSearchOption,ProjectToolCalls } from './ProjectAiTools';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Plus, Sparkles, UserRound } from 'lucide-react';
import { ApiError, api, listAllItems, projectPath } from '../api/client';
import { collaborationApi, type CollaborationTask, type CollaborationProposal, type SubmissionDecision, type TaskSubmission } from '../api/collaboration';
import { useCapabilities } from '../auth';
import { useProject } from '../components/ProjectShell';
import { EmptyState, ErrorNotice, Field, Modal, SectionCard, Spinner, StatusPill } from '../components/ui';
import { jobStatusLabel, useVisibleJobPoller } from './aiWorkflowSupport';
import { ReferencePicker } from './ReferencePicker';
import './ProjectWorkspace.css';
import { AssistiveRubricScores } from './AssistiveRubricScores';
import { projectRequest, type ProjectGoal } from '../api/simplification';
import { dependencyOrder } from './task-dependencies';
import { DateInput } from '../components/DateInput';
import './CollaborationWorkspace.css';
import { taskSummarySource, taskSummaryPreview, useTaskSummaries } from './useTaskSummaries';
import { ProposalCorrection } from './ProposalCorrection';
import { AiClarificationCard } from '../components/AiClarificationCard';
import { clarificationApi, clarificationFromJob, clarificationQueryKey, type ProjectClarification, type ClarificationAnswer } from '../api/clarifications';

const lifecycleLabels = { open: '待认领', in_progress: '进行中', submitted: '待验收', accepted: '已通过', improve: '需改进', rework: '需重做' };
const decisionLabels = { accept: '通过', improve: '改进', rework: '重做' };
const taskStateLabel = (task: CollaborationTask) => task.pendingHumanReview ? '已完成（待人工审核）' : task.lifecycleState === 'accepted' && !task.currentSubmissionId ? '历史已完成' : lifecycleLabels[task.lifecycleState];
type FeedbackSnapshot = {versionId:string|null;version:number;feedback:string;actorId:string|null;createdAt:string|null};
const defaultDraft = { title: '', detail: '', criteria: '', effortHours: '1', dueDate: '', assigneeId: '' };

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
  const feedbackAdmin = project.myRole === 'owner' || project.canGrantPermissions === true;
  const feedback = useQuery({queryKey:['project-feedback',projectId],queryFn:()=>projectRequest<FeedbackSnapshot>(projectId,'/collaboration/feedback/current')});
  const feedbackHistory = useQuery({queryKey:['project-feedback-history',projectId],queryFn:()=>projectRequest<{items:FeedbackSnapshot[]}>(projectId,'/collaboration/feedback/history')});
  const capabilities = useCapabilities();
  const modelEnabled = capabilities.data?.features.aiEnabled === true;
  const tasks = useQuery({ queryKey: ['collaboration-tasks', projectId], queryFn: () => collaborationApi.tasks(projectId) });
  const goal = useQuery({ queryKey: ['project-goal', projectId], queryFn: () => projectRequest<ProjectGoal>(projectId, '/goal') });
  const settings = useQuery({ queryKey: ['collaboration-settings', projectId], queryFn: () => collaborationApi.settings(projectId) });
  const aiEnabled = modelEnabled && settings.data?.aiCollaborationEnabled === true;
  const members = useQuery({ queryKey: ['members', projectId], queryFn: () => listAllItems<'MemberListResponse'>(projectPath(projectId, '/members')) });
  const me = useQuery({ queryKey: ['member-me', projectId], queryFn: () => api.get<'MemberResponse'>(projectPath(projectId, '/members/me')) });
  const proposals = useQuery({ queryKey: ['collaboration-proposals', projectId], queryFn: () => collaborationApi.proposals(projectId) });
  const [createOpen, setCreateOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [draft, setDraft] = useState(defaultDraft);
  const [statusFilter, setStatusFilter] = useState('all');
  const [createDependencies, setCreateDependencies] = useState<string[]>([]);
  const [createGraphRevision, setCreateGraphRevision] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();
  const historyType = searchParams.get('view') === 'history' ? searchParams.get('historyType') : null;
  const historyPage = historyType === 'proposals' || historyType === 'submissions';
  const proposalHistory = historyType === 'proposals';
  const selectedId = searchParams.get('task') ?? '';
  const [lastSelectedId, setLastSelectedId] = useState(selectedId);
  const selectedAction = searchParams.get('taskAction') === 'settings' ? 'settings' : 'submit';
  const [inquiryId, setInquiryId] = useState('');
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
  const canRegenerate = rows.every(row => !row.startedAt && !row.assigneeId && !row.currentSubmissionId && row.status === 'todo' && row.lifecycleState === 'open');
  const summaries = useTaskSummaries(projectId, rows, aiEnabled);
  const selected = rows.find(row => row.taskId === (selectedId || lastSelectedId));
  const invalidate = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['collaboration-tasks', projectId] }), client.invalidateQueries({ queryKey: ['collaboration-proposals', projectId] }), client.invalidateQueries({ queryKey: ['tasks', projectId] }), client.invalidateQueries({ queryKey: ['project-goal', projectId] })]); };
  useEffect(() => { if (job.isSettled) { void client.invalidateQueries({ queryKey: ['collaboration-tasks', projectId] }); void client.invalidateQueries({ queryKey: ['collaboration-proposals', projectId] }); void client.invalidateQueries({ queryKey: ['collaboration-submissions', projectId] }); } }, [job.isSettled, jobId, client, projectId]);
  const create = useMutation({ mutationFn: () => collaborationApi.createTask(projectId, { ...draft, title: draft.title.trim(), criteria: draft.criteria.trim(), effortHours: Number(draft.effortHours), dueDate: draft.dueDate || null, assigneeId: draft.assigneeId || null, dependsOnTaskIds: createDependencies, expectedGraphRevision: createGraphRevision }), onSuccess: async () => { setCreateOpen(false); setDraft(defaultDraft); setCreateDependencies([]); await invalidate(); }, onError: invalidate });
  const claim = useMutation({ mutationFn: (task: CollaborationTask) => collaborationApi.claim(projectId, task), onSuccess: invalidate, onError: invalidate });
  const ai = useMutation({ mutationFn: async (action: 'decompose' | 'adjust' | 'assign') => { if(action === 'decompose' && !canRegenerate) throw new Error('已有任务曾开始，只能提出调整或补充建议'); if(feedbackAdmin && brief !== feedback.data?.feedback) await saveFeedback.mutateAsync(); return action === 'decompose' ? collaborationApi.decompose(projectId, '依据项目主目标与已保存的持续项目反馈生成任务拆解方案', sourceVersions,{allowSearch,searchQuery}, contextMaterialVersions) : action === 'adjust' ? collaborationApi.adjustTasks(projectId, '依据已保存的持续项目反馈提出当前任务调整方案', rows.filter(row => ['open', 'in_progress', 'improve', 'rework'].includes(row.lifecycleState)).map(row => row.taskId), sourceVersions,{allowSearch,searchQuery}, contextMaterialVersions) : collaborationApi.suggestAssignments(projectId, rows.filter(row => !row.assigneeId && row.lifecycleState === 'open').map(row => row.taskId)); }, onSuccess: result => { setHandoffNotice(''); setJobId(result.jobId); } });
  const renderProposal = (proposal: CollaborationProposal, readOnly = false) => (<article key={proposal.proposalId} className="collab-proposal"><div className="collab-toolbar"><strong>{proposal.kind === 'decompose' ? proposal.payload.updates?.length ? '任务调整建议' : '任务拆解建议' : '团队分工建议'}</strong><StatusPill>{proposal.status === 'applied' ? '已应用' : proposal.status === 'stale' ? '已过期' : '待确认'}</StatusPill></div>{!readOnly && owner && <ProposalCorrection key={proposal.proposalId} projectId={projectId} proposal={proposal} members={members.data ?? []} onChanged={invalidate} canApprove={proposal.kind !== 'decompose' || feedbackAdmin} />}<RemovedSourceNotice payload={proposal.payload} /><ProposalPreview payload={proposal.payload} members={members.data ?? []} tasks={rows} /></article>);
  return <SectionCard title={historyPage ? '任务历史' : '任务'} detail={historyPage ? '每页展示一条记录，保留提交时的内容与固定版本引用。' : '按前置依赖顺序显示。依赖仅作提示，可提前认领、执行和提交成果。'}>
    <div hidden={historyPage}><div className="collab-toolbar"><div className="chip-list"><span className="chip">共 {rows.length} 项 · 已完成 {rows.filter(task => task.lifecycleState === 'accepted').length} 项</span><span className="chip">分工：{!settings.data ? '尚未读取' : settings.data.assignmentMode === 'automatic' ? '自动应用 AI' : '负责人确认'}</span><span className="chip">验收：{!settings.data ? '尚未读取' : settings.data.evaluationMode === 'automatic' ? '自动应用 AI' : '负责人确认'}</span></div><label className="collab-filter"><span>筛选</span><select className="input" aria-label="筛选" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">全部任务</option><option value="pending_review">已完成（待人工审核）</option>{Object.entries(lifecycleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><div className="collab-toolbar-actions">{<button className="button button-quiet" aria-expanded={aiOpen} aria-controls="collab-ai-panel" onClick={() => setAiOpen(true)}><Sparkles size={16} />AI 拆解、调整与分工</button>}{owner && <button className="button button-primary" disabled={!goal.data} onClick={() => { create.reset(); setCreateGraphRevision(goal.data!.graphRevision); setCreateOpen(true); }}><Plus size={16} />新建任务</button>}</div></div>
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
      <Field label="持续项目反馈"><textarea className="input" rows={3} maxLength={12000} readOnly={!feedbackAdmin} value={brief} onChange={event => setBrief(event.target.value)} placeholder="保存项目目标、补充信息和持续调整要求；后续项目 AI 操作会使用当前保存版本" /></Field>

      {feedback.error && <ErrorNotice error={feedback.error}/>}{saveFeedback.error && <><ErrorNotice error={saveFeedback.error}/><button className="button button-quiet" onClick={async()=>{const result=await feedback.refetch();if(result.data){setBrief(result.data.feedback);setFeedbackBase(result.data.version);saveFeedback.reset();}}}>重新载入已保存反馈</button></>}
      {feedbackAdmin && <button className="button" disabled={feedbackBase===null || saveFeedback.isPending || ai.isPending || brief===feedback.data?.feedback} onClick={()=>saveFeedback.mutate()}>保存反馈</button>}
      {saveFeedback.isSuccess && <p role="status">反馈已保存</p>}
      <div className="form-actions"><button className="button" disabled={!canRegenerate || feedbackBase===null || saveFeedback.isPending || !owner || !aiEnabled || (allowSearch&&!searchQuery.trim()) || ai.isPending || waitingForAnswer || (!!jobId && !job.isSettled)} onClick={() => ai.mutate('decompose')}>重新生成整套任务建议</button><button className="button" disabled={feedbackBase===null || saveFeedback.isPending || !owner || !aiEnabled || (allowSearch&&!searchQuery.trim()) || ai.isPending || !rows.some(row => ['open', 'in_progress', 'improve', 'rework'].includes(row.lifecycleState)) || waitingForAnswer || (!!jobId && !job.isSettled)} onClick={() => ai.mutate('adjust')}>按要求调整现有任务</button><button className="button" disabled={feedbackBase===null || saveFeedback.isPending || !owner || !aiEnabled || ai.isPending || !rows.some(row => !row.assigneeId && row.lifecycleState === 'open') || waitingForAnswer || (!!jobId && !job.isSettled)} onClick={() => ai.mutate('assign')}>建议未认领任务分工</button></div>
      {ai.error && <ErrorNotice error={ai.error} />}
      {handoffNotice && <p className="form-note">{handoffNotice}</p>}
      <JobProgress job={job} />
      {(job.job as unknown as {feedbackSnapshot?:FeedbackSnapshot})?.feedbackSnapshot && <details><summary>本次使用的持续反馈版本 {(job.job as unknown as {feedbackSnapshot:FeedbackSnapshot}).feedbackSnapshot.version}</summary><p style={{whiteSpace:'pre-wrap'}}>{(job.job as unknown as {feedbackSnapshot:FeedbackSnapshot}).feedbackSnapshot.feedback || '未设置持续反馈'}</p></details>}
      {jobId&&<ProjectToolCalls projectId={projectId} jobId={jobId}/>}
      {proposals.error && <ErrorNotice error={proposals.error} />}
      {activeProposal && renderProposal(activeProposal, !owner)}
      {activeProposal && orderedProposals[0]?.proposalId !== activeProposal.proposalId && <p className="form-note">有新的 AI 建议。为保留当前修改，请通过标题栏“历史记录”选择需要处理的建议。</p>}
      </div>
      {proposalHistory && <><h3>持续反馈版本历史</h3>{feedbackHistory.error && <ErrorNotice error={feedbackHistory.error}/>}<div className="stack">{feedbackHistory.data?.items.map(item=><article className="form-note" key={item.versionId}><strong>版本 {item.version} · {item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : ''}</strong><p style={{whiteSpace:'pre-wrap'}}>{item.feedback || '已清空持续反馈'}</p></article>)}</div><h3>AI 建议历史</h3>{proposals.isLoading && <Spinner label="读取 AI 建议历史" />}{!proposals.isLoading && !proposals.error && !proposalRecord && <p className="muted">尚无 AI 建议记录。</p>}{proposalRecord && <div className="collab-history-pager"><button className="button button-small" disabled={proposalIndex === 0} onClick={() => chooseProposal(orderedProposals[proposalIndex - 1]!.proposalId)}>上一页</button><Field label="选择建议记录"><select className="input" value={proposalRecord.proposalId} onChange={event => chooseProposal(event.target.value)}>{orderedProposals.map((item, index) => <option key={item.proposalId} value={item.proposalId}>记录 {orderedProposals.length - index} · {new Date(item.createdAt).toLocaleString('zh-CN')}</option>)}</select></Field><span aria-live="polite">第 {proposalIndex + 1} / {orderedProposals.length} 页</span><button className="button button-small" disabled={proposalIndex === orderedProposals.length - 1} onClick={() => chooseProposal(orderedProposals[proposalIndex + 1]!.proposalId)}>下一页</button></div>}</>}
      {proposals.error && proposalHistory && <ErrorNotice error={proposals.error} />}
      {proposalHistory && proposalRecord && <>{renderProposal(proposalRecord, true)}<button className="button button-quiet" onClick={() => { setActiveProposalId(proposalRecord.proposalId); returnFromHistory(); }}>打开此建议进行处理</button></>}
    </section></Modal>}
    <div hidden={historyPage}>
    {[tasks.error, settings.error, members.error, me.error, claim.error].filter(Boolean).map((error, index) => <ErrorNotice key={index} error={error} />)}
    {tasks.isLoading && <Spinner label="读取协作任务" />}
    {!tasks.isLoading && !tasks.error && !rows.length && <EmptyState title="把交付目标变成明确任务" detail="先写清完成标准与预计投入，再由成员认领。无需开启 AI。" />}
    <div className="collab-grid">{rows.filter(task => statusFilter === 'all' || (statusFilter === 'pending_review' ? task.pendingHumanReview : task.lifecycleState === statusFilter && (statusFilter !== 'accepted' || !task.pendingHumanReview))).map(task => <article className="collab-task" key={task.taskId}>
      <div className="collab-toolbar"><div className="collab-task-status"><StatusPill tone={task.pendingHumanReview ? 'warn' : task.lifecycleState === 'accepted' ? 'good' : ['improve', 'rework'].includes(task.lifecycleState) ? 'warn' : 'blue'}>{taskStateLabel(task)}</StatusPill>{(task.unfinishedDependencyIds?.length ?? 0) > 0 && <span className="collab-dependency-warning" tabIndex={0} aria-label="前置任务未完成，可提前认领、执行和提交。">前置任务未完成<span role="tooltip">前置任务未完成，可提前认领、执行和提交。</span></span>}</div><small>{task.effortHours} 小时</small></div>
      <button title={task.title} className="collab-title" onClick={() => setSelectedId(task.taskId)}>{task.title}</button>
      <p className="collab-criteria">{taskSummaryPreview(task)}</p>{Array.from(taskSummarySource(task)).length > 60 && !task.summary && <small className="collab-summary-status">原文节选{summaries.errors[task.taskId] || task.summaryStatus === 'failed' ? ' · 摘要生成失败' : task.summaryStatus === 'queued' || task.summaryStatus === 'running' ? ' · AI 正在总结' : ''}{aiEnabled && (summaries.errors[task.taskId] || task.summaryStatus === 'failed') && <button className="button button-quiet button-small" disabled={summaries.retryBusy} onClick={() => summaries.retry(task)}>重试摘要</button>}</small>}
      {(task.dependsOnTaskIds?.length ?? 0) > 0 && <small className="collab-task-dependencies">前置任务：{task.dependsOnTaskIds!.map(id => rows.find(row => row.taskId === id)?.title ?? id).join('、')}</small>}
      <div className="collab-toolbar collab-task-footer"><span className="tm-meta-item"><UserRound size={14} />{members.data?.find(member => member.userId === task.assigneeId)?.displayName ?? (task.assigneeId ? '项目成员' : '尚未认领')}</span>{!task.assigneeId && task.lifecycleState === 'open' && <button className="button button-primary button-small" disabled={claim.isPending || !me.data} onClick={() => claim.mutate(task)}>我来认领</button>}<button className="button button-quiet button-small" onClick={() => setSelectedId(task.taskId)}>查看与提交</button><button className="button button-quiet button-small" onClick={() => setInquiryId(task.taskId)}>前置任务质询</button><TaskAgentAction projectId={projectId} task={task} onHandoff={() => setAgentTaskId(task.taskId)} /><button className="button button-quiet button-small" onClick={() => setSelectedId(task.taskId, 'settings')}>任务设置</button></div>
    </article>)}</div>
    {createOpen && <Modal title="新建任务" onClose={() => setCreateOpen(false)}><form className="stack" onSubmit={event => { event.preventDefault(); create.mutate(); }}>
      <Field label="任务名称"><input className="input" required maxLength={200} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></Field>
      <Field label="任务说明"><textarea className="input" rows={3} maxLength={4000} value={draft.detail} onChange={event => setDraft({ ...draft, detail: event.target.value })} /></Field>
      <Field label="任务执行人（选填）"><select className="input" value={draft.assigneeId} onChange={event => setDraft({ ...draft, assigneeId: event.target.value })}><option value="">暂不分配，由成员认领</option>{members.data?.map(member => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}</select></Field>
      <Field label="验收标准" hint="写明可核对的交付物、质量要求与完成条件。"><textarea className="input" required rows={4} maxLength={4000} value={draft.criteria} onChange={event => setDraft({ ...draft, criteria: event.target.value })} /></Field>
      <div className="form-grid-two"><Field label="预计投入（小时）"><input className="input" type="number" required min="0.25" max="200" step="0.25" value={draft.effortHours} onChange={event => setDraft({ ...draft, effortHours: event.target.value })} /></Field><Field label="截止日期（选填）"><DateInput className="input" type="date" value={draft.dueDate} onChange={event => setDraft({ ...draft, dueDate: event.target.value })} /></Field></div>
      <fieldset><legend>前置任务（可多选）</legend>{rows.map(task => <label className="collab-version" key={task.taskId}><input type="checkbox" checked={createDependencies.includes(task.taskId)} onChange={event => setCreateDependencies(ids => event.target.checked ? [...ids, task.taskId] : ids.filter(id => id !== task.taskId))} />{task.title}</label>)}</fieldset>
      {goal.data && createGraphRevision !== goal.data.graphRevision && <p className="notice notice-warn">任务依赖已变化，草稿保留。请复核前置选择后确认使用最新依赖图。<button type="button" className="button button-quiet" onClick={() => setCreateGraphRevision(goal.data!.graphRevision)}>已复核前置任务</button></p>}
      {create.error && <ErrorNotice error={create.error} />}<div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setCreateOpen(false)}>取消</button><button className="button button-primary" disabled={create.isPending || !draft.title.trim() || !draft.criteria.trim() || createGraphRevision !== goal.data?.graphRevision}>{create.isPending ? '创建中…' : '创建任务'}</button></div>
    </form></Modal>}
    </div>
    {historyPage && ((historyType === 'submissions' && !selected && !tasks.isLoading)) && <><button className="button button-quiet" onClick={returnFromHistory}>返回任务操作</button><EmptyState title="历史记录不可用" detail="该任务不在当前项目中，或你没有查看权限。" /></>}
    {inquiryId && <Modal title="前置任务质询" onClose={() => setInquiryId('')}><TaskInquiries key={inquiryId} projectId={projectId} taskId={inquiryId} meId={me.data?.userId}/></Modal>}
    {agentTaskId && rows.find(row => row.taskId === agentTaskId) && <Modal title="AI 辅助" onClose={() => setAgentTaskId('')}><TaskAiAssistance projectId={projectId} task={rows.find(row => row.taskId === agentTaskId)!} tasks={rows}/></Modal>}
    {selected && <Modal title={historyType === 'submissions' ? `${selected.title} · 提交与验收历史` : selectedAction === 'settings' ? `${selected.title} · 任务设置` : selected.title} mode={historyType === 'submissions' ? 'page' : historyPage || !selectedId ? 'hidden' : 'dialog'} onClose={historyType === 'submissions' ? returnFromHistory : () => setSelectedId('')}><TaskLifecycleDetail view={selectedAction} key={selected.taskId} projectId={projectId} task={selected} tasks={rows} graphRevision={goal.data?.graphRevision} owner={owner} meId={me.data?.userId} members={members.data ?? []} onChanged={invalidate} /></Modal>}
  </SectionCard>;
}

function DependencyEditor({ projectId, task, tasks, graphRevision, owner, onChanged }: { projectId: string; task: CollaborationTask; tasks: CollaborationTask[]; graphRevision?: number; owner: boolean; onChanged: () => Promise<void> }) {
  const [selected, setSelected] = useState(task.dependsOnTaskIds ?? []);
  const [base, setBase] = useState(graphRevision);
  const [conflicted, setConflicted] = useState(false);
  const [editing, setEditing] = useState(false);
  const stale = conflicted || base !== graphRevision;
  const save = useMutation({ mutationFn: () => projectRequest<{ graphRevision: number }>(projectId, `/tasks/${encodeURIComponent(task.taskId)}/dependencies`, { method: 'PUT', body: { expectedGraphRevision: base, dependsOnTaskIds: selected } }), onSuccess: async result => { setBase(result.graphRevision); setConflicted(false); await onChanged(); }, onError: async error => { if (error instanceof ApiError && error.status === 409) setConflicted(true); await onChanged(); } });
  return <section className="stack collab-dependencies">
    <div className="collab-dependency-heading">{owner && <button className="button button-quiet button-small" aria-expanded={editing} aria-controls="task-dependency-editor" onClick={() => setEditing(open => !open)}>调整前置任务</button>}<h3>前置依赖</h3></div>
    <p>{(task.dependsOnTaskIds ?? []).map(id => tasks.find(item => item.taskId === id)?.title ?? id).join('、') || '无前置任务'}</p>
    {(task.unfinishedDependencyIds?.length ?? 0) > 0 && <p className="notice notice-warn">尚未完成：{task.unfinishedDependencyIds!.map(id => tasks.find(item => item.taskId === id)?.title ?? id).join('、')}。你可以提前认领、执行和提交。</p>}
    {owner && <div id="task-dependency-editor" hidden={!editing}><form className="stack" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <fieldset><legend>选择前置任务</legend>{tasks.filter(item => item.taskId !== task.taskId).map(item => <label key={item.taskId} className="collab-version"><input type="checkbox" checked={selected.includes(item.taskId)} onChange={event => setSelected(ids => event.target.checked ? [...ids, item.taskId] : ids.filter(id => id !== item.taskId))} />{item.title}</label>)}</fieldset>
      {stale && <p className="notice notice-warn">依赖图已变化，当前选择保留。请对照最新前置任务，再重新选择。<button className="button button-quiet" type="button" onClick={() => { setSelected(task.dependsOnTaskIds ?? []); setBase(graphRevision); setConflicted(false); save.reset(); }}>载入最新依赖</button></p>}
      {save.error && <ErrorNotice error={save.error} />}<button className="button button-primary" disabled={save.isPending || stale || base === undefined}>保存前置依赖</button>
    </form></div>}
  </section>;
}

function JobProgress({ job }: { job: ReturnType<typeof useVisibleJobPoller> }) {
  const result = job.job?.result && typeof job.job.result === 'object' ? job.job.result as Record<string, unknown> : null;
  const reasons = Array.isArray(result?.manualReviewReasons) ? result.manualReviewReasons.filter((value): value is string => typeof value === 'string') : [];
  const error = job.job?.error;
  const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '执行失败，未生成有效建议。可重新发起。';
  return <>{job.loading && <Spinner label="读取 AI 任务进度" />}{job.error && <ErrorNotice error={job.error} />}{job.job && <div className={`notice ${job.job.status === 'failed' ? 'notice-error' : ''}`}>AI 任务：{jobStatusLabel(job.job.status)}{job.job.status === 'failed' && <span> · {message}</span>}{job.job.status === 'succeeded' && typeof result?.autoApplied === 'boolean' && <span> · {result.autoApplied ? '已按自动模式应用' : '未自动应用，请负责人核验并确认'}</span>}</div>}{typeof result?.followupError === 'string' && <p className="notice notice-warn">任务已拆解，但自动分工未启动：{result.followupError}。可手动认领或安排分工。</p>}{typeof result?.applyError === 'string' && <p className="notice notice-warn">未应用原因：{result.applyError}</p>}{reasons.length > 0 && <div className="callout"><strong>需要人工核验</strong><ul>{reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>}</>;
}

function ProposalPreview({ payload, members, tasks }: { payload: Record<string, unknown>; members: { userId: string; displayName: string }[]; tasks: CollaborationTask[] }) {
  const entries = [...(Array.isArray(payload.tasks) ? payload.tasks : []), ...(Array.isArray(payload.updates) ? payload.updates : []), ...(Array.isArray(payload.assignments) ? payload.assignments : [])];
  const goal = payload.goal && typeof payload.goal === 'object' ? payload.goal as { title?: string; detail?: string } : null;
  return <>{goal && <div className="callout"><strong>建议主目标：{goal.title}</strong><p>{goal.detail}</p></div>}<ul>{entries.map((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object') return null;
    const row = entry as Record<string, unknown>;
    return <li key={index}><strong>{typeof row.title === 'string' ? row.title : tasks.find(task => task.taskId === row.taskId)?.title ?? String(row.taskId ?? '任务')}</strong>{typeof row.criteria === 'string' && <p>{row.criteria}</p>}{Array.isArray(row.dependsOn) && row.dependsOn.length > 0 && <p>前置：{row.dependsOn.map(key => { const predecessor = entries.find(item => item && typeof item === 'object' && 'key' in item && item.key === key) as { title?: string } | undefined; return predecessor?.title ?? tasks.find(task => task.taskId === key)?.title ?? String(key); }).join('、')}</p>}{typeof row.effortHours === 'number' && <small>预计 {row.effortHours} 小时 · </small>}{typeof row.assigneeId === 'string' && <span>{members.find(member => member.userId === row.assigneeId)?.displayName ?? row.assigneeId}</span>}{typeof row.reason === 'string' && <p>{row.reason}</p>}{Array.isArray(row.citations) && row.citations.length > 0 && <details><summary>任务来源原文依据</summary>{row.citations.map((citation: unknown, citeIndex: number) => { const cite = citation as { sourceVersionId?: string; pageNumber?: number | null; quote?: string; availability?: 'unavailable'; deletedAt?: string | null }; return <p className="collab-preserve" key={citeIndex}>固定来源 {cite.sourceVersionId}{cite.pageNumber ? ` · 第${cite.pageNumber}页` : ''}：{cite.quote}{cite.availability === 'unavailable' && <small> · 原始来源不可用{cite.deletedAt ? '（已移入回收站）' : ''}，历史引文保留</small>}</p>; })}</details>}</li>;
  })}</ul></>;
}

function TaskLifecycleDetail({ view, projectId, task, tasks, graphRevision, owner, meId, members, onChanged }: { view: 'submit' | 'settings'; projectId: string; task: CollaborationTask; tasks: CollaborationTask[]; graphRevision?: number; owner: boolean; meId?: string; members: { userId: string; displayName: string }[]; onChanged: () => Promise<void> }) {
  const client = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const historyPage = searchParams.get('view') === 'history' && searchParams.get('historyType') === 'submissions';
  const historyId = searchParams.get('record') ?? '';
  const setHistoryId = (id: string) => { const next = new URLSearchParams(searchParams); next.set('record', id); setSearchParams(next); };
  const openHistory = () => { const next = new URLSearchParams(searchParams); next.set('view', 'history'); next.set('historyType', 'submissions'); if (selectedHistory) next.set('record', selectedHistory.submissionId); setSearchParams(next); };
  const [editDraft, setEditDraft] = useState({ title: task.title, detail: task.detail, criteria: task.criteria, effortHours: String(task.effortHours) });
  const [editBaseRevision, setEditBaseRevision] = useState(task.revision);
  const [editConflicted, setEditConflicted] = useState(false);
  const editOutdated = editConflicted || editBaseRevision !== task.revision;
  const [editSaved, setEditSaved] = useState(false);
  const [assigneeId, setAssigneeId] = useState(task.assigneeId ?? '');
  const [reason, setReason] = useState('');
  const [assignmentBase, setAssignmentBase] = useState(task.revision);
  const [assignmentConflict, setAssignmentConflict] = useState(false);
  const assignmentOutdated = assignmentConflict || assignmentBase !== task.revision;
  const [submissionBase, setSubmissionBase] = useState(task.revision);
  const [submissionConflict, setSubmissionConflict] = useState(false);
  const submissionOutdated = submissionConflict || submissionBase !== task.revision;
  const [body, setBody] = useState('');
  const [materialId, setMaterialId] = useState('');
  const [versions, setVersions] = useState<{ id: string; label: string }[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [evaluationNotice, setEvaluationNotice] = useState('');
  const job = useVisibleJobPoller(jobId);
  const history = useQuery({ queryKey: ['collaboration-submissions', projectId, task.taskId], queryFn: () => collaborationApi.submissions(projectId, task.taskId) });
  const materials = useQuery({ queryKey: ['materials', projectId], queryFn: () => listAllItems<'MaterialListResponse'>(projectPath(projectId, '/materials')) });
  const materialVersions = useQuery({ queryKey: ['materialVersions', projectId, materialId], queryFn: () => listAllItems<'MaterialVersionListResponse'>(projectPath(projectId, `/materials/${encodeURIComponent(materialId)}/versions`)), enabled: !!materialId });
  const refresh = async () => { await onChanged(); await client.invalidateQueries({ queryKey: ['collaboration-submissions', projectId, task.taskId] }); };
  useEffect(() => { if (job.isSettled) { void client.invalidateQueries({ queryKey: ['collaboration-tasks', projectId] }); void client.invalidateQueries({ queryKey: ['collaboration-submissions', projectId, task.taskId] }); } }, [job.isSettled, jobId, projectId, task.taskId, client]);
  const edit = useMutation({
    mutationFn: () => {
      if (editOutdated) throw new Error('任务版本已变化，请先明确重新载入最新任务，再编辑保存。');
      return collaborationApi.updateTask(projectId, { ...task, revision: editBaseRevision }, { title: editDraft.title.trim(), detail: editDraft.detail.trim(), criteria: editDraft.criteria.trim(), effortHours: Number(editDraft.effortHours) });
    },
    onSuccess: async updated => { setEditBaseRevision(updated.revision); setEditSaved(true); setEditConflicted(false); await refresh(); },
    onError: async error => { if (error instanceof ApiError && error.status === 409) setEditConflicted(true); await refresh(); },
  });

  const assign = useMutation({ mutationFn: () => { if (assignmentOutdated) throw new Error('分工依据已变化，请重新载入并核对。'); return collaborationApi.assign(projectId, { ...task, revision: assignmentBase }, assigneeId || null, reason.trim()); }, onSuccess: async updated => { setAssignmentBase(updated.revision); setAssignmentConflict(false); setReason(''); await refresh(); }, onError: async error => { if (error instanceof ApiError && error.status === 409) setAssignmentConflict(true); await refresh(); } });
  const submit = useMutation({ mutationFn: () => { if (submissionOutdated) throw new Error('任务或验收标准已变化，请重新载入并核对。'); return collaborationApi.submit(projectId, { ...task, revision: submissionBase }, body.trim(), versions.map(version => version.id)); }, onSuccess: async result => { setBody(''); setVersions([]); setEvaluationNotice(result.evaluationError ?? ''); if (result.evaluationJobId) setJobId(result.evaluationJobId); await refresh(); }, onError: async error => { if (error instanceof ApiError && error.status === 409) setSubmissionConflict(true); await refresh(); } });
  const reopen = useMutation({ mutationFn: () => projectRequest(projectId, '/collaboration/tasks/'+encodeURIComponent(task.taskId)+'/reopen', { method: 'POST', body: { expectedRevision: task.revision, feedback: reason.trim() } }), onSuccess: refresh });
  const current = history.data?.items.find(submission => submission.submissionId === task.currentSubmissionId);
  useEffect(() => { if (!jobId && current?.evaluationJobId && !current.decision) setJobId(current.evaluationJobId); }, [current?.evaluationJobId, current?.decision, jobId]);
  const canSubmit = task.assigneeId === meId && ['in_progress', 'improve', 'rework'].includes(task.lifecycleState);
  const orderedHistory = [...(history.data?.items ?? [])].sort((a, b) => b.round - a.round);
  const selectedHistory = orderedHistory.find(item => item.submissionId === historyId) ?? orderedHistory[0];
  const historyIndex = selectedHistory ? orderedHistory.indexOf(selectedHistory) : 0;
  useEffect(() => {
    if (historyPage && selectedHistory && !historyId) {
      const next = new URLSearchParams(searchParams); next.set('record', selectedHistory.submissionId); setSearchParams(next, { replace: true });
    }
  }, [historyPage, selectedHistory, historyId, searchParams, setSearchParams]);
  const renderSubmission = (submission: TaskSubmission, readOnly = false) => (<article className="collab-history" key={submission.submissionId}>
      <div className="collab-toolbar"><strong>第 {submission.round} 轮</strong><small>{new Date(submission.createdAt).toLocaleString('zh-CN')} · {members.find(member => member.userId === submission.submittedBy)?.displayName ?? '项目成员'}</small><StatusPill tone={submission.pendingHumanReview ? 'warn' : 'neutral'}>{submission.pendingHumanReview ? '已完成（待人工审核）' : submission.decision ? decisionLabels[submission.decision] : submission.aiDecision ? 'AI 已评价，待确认' : '待验收'}</StatusPill></div>
      <p className="collab-preserve">{submission.body}</p><details><summary>本轮验收标准与绑定版本</summary><p className="collab-preserve">{submission.criteria}</p>{submission.materialVersionIds.length ? <ul>{submission.materialVersionIds.map(id => <li key={id}>{submission.materialVersions?.find(version => version.versionId === id) ? <BoundMaterialVersion projectId={projectId} version={submission.materialVersions.find(version => version.versionId === id)!} /> : <>材料固定版本：{id}</>}</li>)}</ul> : <p>未绑定材料版本</p>}</details>
      {submission.aiReport && <div className="callout"><RemovedSourceNotice payload={submission.aiReport} /><strong>{submission.aiReport.humanReview?.status === 'resolved' ? '原 AI 证据覆盖：' : 'AI 证据覆盖：'}{submission.aiReport.coverage === 'complete' ? '模型认为文本证据完整' : '需要人工核验'}</strong><ul>{submission.aiReport.evidence.map((evidence, index) => <li key={index}><span>固定版本 {evidence.materialVersionId}</span><p className="collab-preserve">{evidence.quote}</p></li>)}</ul>{submission.aiReport.manualReviewReason && <p className="notice notice-warn">{submission.aiReport.humanReview?.status === 'resolved' ? '原 AI 待审核原因：' : '待人工审核原因：'}{submission.aiReport.manualReviewReason}</p>}{submission.aiReport.limitations.length > 0 && <><strong>限制与待核验项</strong><ul>{submission.aiReport.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></>}</div>}
      <AssistiveRubricScores projectId={projectId} submission={submission} owner={owner && !readOnly} onChanged={refresh} />
      {submission.aiDecision && <div className="callout"><strong>AI 建议：{decisionLabels[submission.aiDecision]}</strong><p className="collab-preserve">{submission.aiFeedback}</p></div>}
      {submission.decision && <div className="callout"><strong>{submission.pendingHumanReview ? '已完成（待人工审核）' : `验收决定：${decisionLabels[submission.decision]}`}</strong><p className="collab-preserve">{submission.feedback}</p></div>}
      {!readOnly && current?.submissionId === submission.submissionId && owner && <SubmissionDecisionForm projectId={projectId} submission={submission} onChanged={refresh} />}
    </article>);
  return <div className="stack collab-detail">
    <div hidden={historyPage}>
    <div className="collab-toolbar"><StatusPill tone={task.pendingHumanReview ? 'warn' : 'neutral'}>{taskStateLabel(task)}</StatusPill><span>预计 {task.effortHours} 小时 · r{task.revision}</span>{view === 'submit' && <button className="button button-quiet" onClick={openHistory}>查看历史记录</button>}</div>
    {!owner && task.assigneeId !== meId && <p className="form-note">仅任务执行人可提交成果；负责人可安排分工与验收。</p>}
    <section aria-label="任务设置" hidden={view !== 'settings'} className="stack">
    <DependencyEditor projectId={projectId} task={task} tasks={tasks} graphRevision={graphRevision} owner={owner} onChanged={onChanged} />
    <h3>任务介绍</h3><p className="collab-preserve">{task.detail || '暂无任务介绍'}</p><div className="callout"><strong>验收标准</strong><p className="collab-preserve">{task.criteria}</p></div>
    {owner && <details><summary>调整任务与验收标准</summary><form className="stack" onSubmit={event => { event.preventDefault(); edit.mutate(); }}>

      <Field label="调整任务名称"><input className="input" required maxLength={200} value={editDraft.title} onChange={event => { setEditSaved(false); setEditDraft({ ...editDraft, title: event.target.value }); }} /></Field>
      <Field label="调整任务说明"><textarea className="input" rows={3} maxLength={4000} value={editDraft.detail} onChange={event => { setEditSaved(false); setEditDraft({ ...editDraft, detail: event.target.value }); }} /></Field>
      <Field label="调整验收标准"><textarea className="input" required rows={4} maxLength={4000} value={editDraft.criteria} onChange={event => { setEditSaved(false); setEditDraft({ ...editDraft, criteria: event.target.value }); }} /></Field>
      <Field label="调整预计投入（小时）"><input className="input" required type="number" min="0.25" max="200" step="0.25" value={editDraft.effortHours} onChange={event => { setEditSaved(false); setEditDraft({ ...editDraft, effortHours: event.target.value }); }} /></Field>
      <p className="form-note">本地修改基于 r{editBaseRevision} · 当前任务 r{task.revision}</p>
      {editOutdated && <div className="notice notice-warn">任务已被更新，本地修改仍保留。为避免覆盖新内容，请先重新载入最新任务（将替换此处未保存的修改），再重新编辑。</div>}
      {editOutdated && <button type="button" className="button button-quiet" onClick={() => { setEditDraft({ title: task.title, detail: task.detail, criteria: task.criteria, effortHours: String(task.effortHours) }); setEditBaseRevision(task.revision); setEditConflicted(false); setEditSaved(false); edit.reset(); }}>重新载入最新任务</button>}
      {edit.error && <ErrorNotice error={edit.error} />}{editSaved && <p role="status">任务调整已保存</p>}<button className="button" disabled={edit.isPending || editOutdated || !editDraft.title.trim() || !editDraft.criteria.trim()}>{edit.isPending ? '保存中…' : '保存任务调整'}</button>
    </form></details>}
    {owner && <details><summary>负责人分工</summary><form className="stack" onSubmit={event => { event.preventDefault(); assign.mutate(); }}>
      {task.lifecycleState === 'submitted' && <p className="notice notice-warn">重新分配会撤回当前提交并使待处理评价失效，历史保留。请确认后填写调整理由。</p>}
      <Field label="任务执行人"><select className="input" value={assigneeId} onChange={event => setAssigneeId(event.target.value)}><option value="">暂不分配</option>{members.map(member => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}</select></Field>
      <Field label="分工理由"><textarea className="input" required maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} placeholder="说明匹配的技能、投入时间及调整原因" /></Field>
      {assignmentOutdated && <div className="notice notice-warn">任务分工已变化，不能用旧表单覆盖当前执行人。请重新载入并填写理由。</div>}
      {assignmentOutdated && <button type="button" className="button button-quiet" onClick={() => { setAssigneeId(task.assigneeId ?? ''); setReason(''); setAssignmentBase(task.revision); setAssignmentConflict(false); assign.reset(); }}>重新载入当前分工</button>}
      {assign.error && <ErrorNotice error={assign.error} />}<button className="button" disabled={assign.isPending || assignmentOutdated || !reason.trim()}>确认分工</button>
    </form></details>}
    {owner && task.lifecycleState === 'accepted' && <section><Field label="重新打开任务的反馈"><textarea className="input" value={reason} onChange={event=>setReason(event.target.value)} /></Field><button className="button" disabled={!reason.trim() || reopen.isPending} onClick={()=>reopen.mutate()}>重新打开任务</button>{reopen.error && <ErrorNotice error={reopen.error}/>}</section>}
    {task.citations && task.citations.length > 0 && <details><summary>任务来源原文依据</summary>{task.citations.map((cite, index) => <p className="collab-preserve" key={index}>固定来源 {cite.sourceVersionId}{cite.pageNumber ? ` · 第${cite.pageNumber}页` : ''}：{cite.quote}{cite.availability === 'unavailable' && <small> · 原始来源不可用{cite.deletedAt ? '（已移入回收站）' : ''}，历史引文保留</small>}</p>)}</details>}
    </section>
    <section aria-label="查看与提交" hidden={view !== 'submit'} className="stack">
    {canSubmit && <section className="collab-submit"><h3>{task.currentSubmissionId ? '提交新一轮成果' : '提交成果'}</h3><form className="stack" onSubmit={event => { event.preventDefault(); submit.mutate(); }}>
      {submissionOutdated && <div className="notice notice-warn">任务或验收标准已更新。请到任务设置核对最新标准，再重新填写成果说明与绑定版本；当前草稿尚未提交。</div>}
      {submissionOutdated && <button type="button" className="button button-quiet" onClick={() => { setBody(''); setVersions([]); setSubmissionBase(task.revision); setSubmissionConflict(false); submit.reset(); }}>已核对标准，重新填写本轮提交</button>}
      <Field label="成果说明"><textarea className="input" required rows={4} maxLength={12000} value={body} onChange={event => setBody(event.target.value)} placeholder="逐项说明验收标准如何达成、待解决问题以及材料位置" /></Field>
      <Field label="绑定材料版本" hint="选择已保存的固定版本；之后编辑材料不会改变本轮提交。可跨材料选择，最多 10 个版本。"><select className="input" value={materialId} onChange={event => setMaterialId(event.target.value)}><option value="">选择材料</option>{materials.data?.map(material => <option key={material.materialId} value={material.materialId}>{material.title}</option>)}</select></Field>
      {materials.error && <ErrorNotice error={materials.error} />}{materialVersions.isLoading && <Spinner label="读取固定版本" />}{materialVersions.error && <ErrorNotice error={materialVersions.error} />}
      {materialId && materialVersions.data?.length === 0 && <p className="form-note">该材料还没有已保存版本，请先到材料中心保存。</p>}
      <div className="collab-version-list">{materialVersions.data?.map(version => <label key={version.versionId} className="collab-version"><input type="checkbox" disabled={versions.length >= 10 && !versions.some(item => item.id === version.versionId)} checked={versions.some(item => item.id === version.versionId)} onChange={event => setVersions(currentVersions => event.target.checked ? [...currentVersions, { id: version.versionId, label: `${materials.data?.find(material => material.materialId === materialId)?.title ?? '材料'} · r${version.revision}` }] : currentVersions.filter(item => item.id !== version.versionId))} /><span>r{version.revision} · {new Date(version.createdAt).toLocaleString('zh-CN')}{version.attachments.length > 0 && <small>含 {version.attachments.length} 个附件，仅供人工参考</small>}</span></label>)}</div>
      {versions.length > 0 && <div className="chip-list">{versions.map(version => <button type="button" className="chip" key={version.id} onClick={() => setVersions(items => items.filter(item => item.id !== version.id))}>{version.label} ×</button>)}</div>}

      {submit.error && <ErrorNotice error={submit.error} />}<button className="button button-primary" disabled={submit.isPending || submissionOutdated || !body.trim()}>{submit.isPending ? '提交中…' : '提交本轮成果'}</button>
    </form></section>}
    {!task.assigneeId && <p className="form-note">请先认领任务或由负责人分工，再提交成果。</p>}
    {evaluationNotice && <div className="notice notice-warn">成果已保存，AI 评价未启动：{evaluationNotice}。可由负责人手动验收。</div>}
    {history.isLoading && <Spinner label="读取提交历史" />}{history.error && <ErrorNotice error={history.error} onRetry={() => void history.refetch()} />}
    {history.data?.items.length === 0 && <p className="muted">{task.lifecycleState === 'accepted' && !task.currentSubmissionId ? '历史完成状态已保留，未补造提交与验收记录。' : '尚未提交成果。'}</p>}
    {current && renderSubmission(current)}
    </section>
    </div>
    {historyPage && <section className="stack" aria-label="提交与验收历史"><h3>提交与验收历史</h3>
    {history.isLoading && <Spinner label="读取提交历史" />}{history.error && <ErrorNotice error={history.error} onRetry={() => void history.refetch()} />}
    {history.data?.items.length === 0 && <p className="muted">{task.lifecycleState === 'accepted' && !task.currentSubmissionId ? '历史完成状态已保留，未补造提交与验收记录。' : '尚未提交成果。'}</p>}
    {selectedHistory && <><div className="collab-history-pager"><button className="button button-small" disabled={historyIndex === 0} onClick={() => setHistoryId(orderedHistory[historyIndex - 1]!.submissionId)}>上一页</button><Field label="选择提交轮次"><select className="input" value={selectedHistory.submissionId} onChange={event => setHistoryId(event.target.value)}>{orderedHistory.map(item => <option key={item.submissionId} value={item.submissionId}>第 {item.round} 轮</option>)}</select></Field><span aria-live="polite">第 {historyIndex + 1} / {orderedHistory.length} 页</span><button className="button button-small" disabled={historyIndex === orderedHistory.length - 1} onClick={() => setHistoryId(orderedHistory[historyIndex + 1]!.submissionId)}>下一页</button></div>{renderSubmission(selectedHistory, true)}</>}
    </section>}
    <JobProgress job={job} />
  </div>;
}
function SubmissionDecisionForm({ projectId, submission, onChanged }: { projectId: string; submission: TaskSubmission; onChanged: () => Promise<void> }) {
  const [decision, setDecision] = useState<SubmissionDecision>('accept');
  const [feedback, setFeedback] = useState('');
  const [decisionBase, setDecisionBase] = useState(submission.revision);
  const [decisionConflict, setDecisionConflict] = useState(false);
  const decisionOutdated = decisionConflict || decisionBase !== submission.revision;
  const decide = useMutation({ mutationFn: () => { if (decisionOutdated) throw new Error('评价记录已变化，请先重新核对。'); return collaborationApi.decide(projectId, { ...submission, revision: decisionBase }, decision, feedback.trim()); }, onSuccess: onChanged, onError: async error => { if (error instanceof ApiError && error.status === 409) setDecisionConflict(true); await onChanged(); } });
  return <form className="stack collab-decision" onSubmit={event => { event.preventDefault(); decide.mutate(); }}><h4>{submission.pendingHumanReview ? '人工审核' : '负责人明确验收'}</h4><Field label={`第 ${submission.round} 轮验收结论`}><select className="input" value={decision} onChange={event => setDecision(event.target.value as SubmissionDecision)}>{Object.entries(decisionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label={`第 ${submission.round} 轮验收理由`}><textarea className="input" required rows={3} maxLength={4000} value={feedback} onChange={event => setFeedback(event.target.value)} placeholder="逐项说明通过依据，或列出下轮需要改进、重做的内容" /></Field>{decisionOutdated && <div className="notice notice-warn">本轮评价已更新，请核对新记录后重新填写验收决定。</div>}{decisionOutdated && <button type="button" className="button button-quiet" onClick={() => { setDecisionBase(submission.revision); setDecisionConflict(false); setFeedback(''); setDecision('accept'); decide.reset(); }}>已核对最新评价，重新填写决定</button>}{decide.error && <ErrorNotice error={decide.error} />}<button className="button button-primary" disabled={decide.isPending || decisionOutdated || !feedback.trim()}>{decide.isPending ? '记录中…' : submission.pendingHumanReview ? '确认人工审核' : '确认验收决定'}</button></form>;
}

function BoundMaterialVersion({ projectId, version }: { projectId: string; version: NonNullable<TaskSubmission['materialVersions']>[number] }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ['materialVersion', projectId, version.materialId, version.versionId], queryFn: () => api.get<'MaterialVersionResponse'>(projectPath(projectId, `/materials/${encodeURIComponent(version.materialId)}/versions/${encodeURIComponent(version.versionId)}`)), enabled: open });
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{version.title} · 固定版本 r{version.revision}</summary>{query.isLoading && <Spinner label="读取已绑定成果" />}{query.error && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}{query.data && <><p className="collab-preserve">{query.data.markdown || '此版本无文本正文'}</p>{query.data.attachments.length > 0 && <><ul>{query.data.attachments.map(attachment => <li key={attachment.fileId}><a href={projectPath(projectId, `/files/${encodeURIComponent(attachment.fileId)}/content`)} download={attachment.name}>{attachment.name}</a></li>)}</ul></>}</>}</details>;
}
