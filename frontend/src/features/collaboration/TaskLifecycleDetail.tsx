import { useSettingsDirty } from '../../pages/settings-dirty';
import { LoadMore } from '../pagination/LoadMore';
import { useCallback, useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ApiError, api, projectPath } from '../../api/client';
import { collaborationApi, type CollaborationTask, type SubmissionDecision, type TaskSubmission } from '../../api/collaboration';
import { AiReferenceBadge } from '../../components/AiReferenceBadge';
import { ErrorNotice, Field, Spinner, StatusPill } from '../../components/ui';
import { SubmissionBody } from '../../pages/SubmissionBody';
import { TaskSettings, type SettingsCloseGuard } from '../../pages/TaskSettings';
import { TaskFileUploads } from '../../pages/TaskFileUploads';
import { listTaskFiles, taskFilesKey } from '../../pages/task-files-client';
import { useVisibleJobPoller } from '../../pages/aiWorkflowSupport';
import { AssistiveRubricScores } from '../../pages/AssistiveRubricScores';
import { RemovedSourceNotice } from '../../pages/RemovedSourceNotice';
import { decisionLabels, taskStateLabel } from './labels';
import { JobProgress } from './JobProgress';
import { readTaskSubmissionDraft, removeTaskSubmissionDraft, writeTaskSubmissionDraft, type TaskSubmissionDraft } from './task-submission-draft';

type TaskLifecycleDetailProps = { closeGuard?: SettingsCloseGuard; view: 'submit' | 'settings'; projectId: string; task: CollaborationTask; tasks: Pick<CollaborationTask, 'taskId' | 'title'>[]; graphRevision?: number; owner: boolean; meId?: string; members: { userId: string; displayName: string }[]; onChanged: () => Promise<void> };

export function TaskLifecycleDetail(props: TaskLifecycleDetailProps) {
  return <TaskLifecycleDetailContent key={JSON.stringify([props.meId, props.projectId, props.task.taskId, props.view])} {...props} />;
}

function TaskLifecycleDetailContent({ closeGuard, view, projectId, task, tasks, graphRevision, owner, meId, members, onChanged }: TaskLifecycleDetailProps) {
  const client = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const historyPage = searchParams.get('view') === 'history' && searchParams.get('historyType') === 'submissions';
  const historyId = searchParams.get('record') ?? '';
  const setHistoryId = (id: string) => { const next = new URLSearchParams(searchParams); next.set('record', id); setSearchParams(next); };
  const [draft, setDraft] = useState(() => {
    const restored = meId ? readTaskSubmissionDraft(meId, projectId, task.taskId) : { draft: null, failed: false };
    return { body: restored.draft?.body ?? '', baseRevision: restored.draft?.baseRevision ?? task.revision, conflict: restored.draft?.conflict ?? false, persisted: !restored.failed, restored: Boolean(restored.draft), readFailed: restored.failed, cleanupFailed: false };
  });
  const { body, baseRevision: submissionBase, conflict: submissionConflict } = draft;
  const submissionOutdated = submissionConflict || submissionBase !== task.revision;
  const persistDraft = (next: TaskSubmissionDraft) => {
    // Save inside the input event, so reload/closing immediately after typing cannot lose a debounced edit.
    const persisted = Boolean(meId && writeTaskSubmissionDraft(meId, projectId, task.taskId, next));
    setDraft(current => ({ ...current, ...next, persisted, restored: false, readFailed: false, cleanupFailed: false }));
  };
  useEffect(() => {
    if ((!body && !submissionConflict) || draft.persisted) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [body, submissionConflict, draft.persisted]);
  const [filesBusy, setFilesBusy] = useState(false);
  const [filesBlockedReason, setFilesBlockedReason] = useState('');
  const updateFilesStatus = useCallback((busy: boolean, reason = '') => { setFilesBusy(busy); setFilesBlockedReason(reason); }, []);
  const [jobId, setJobId] = useState<string | null>(null);
  const [evaluationNotice, setEvaluationNotice] = useState('');
  const job = useVisibleJobPoller(jobId);
  const historyPages = useInfiniteQuery({ queryKey: ['collaboration-submissions', projectId, task.taskId, 'pages'], initialPageParam: null as string | null, queryFn: ({ pageParam }) => collaborationApi.submissions(projectId, task.taskId, pageParam), getNextPageParam: page => ('nextCursor' in page ? page.nextCursor as string | null : null) ?? undefined });
  const history = { ...historyPages, data: historyPages.data ? { items: historyPages.data.pages.flatMap(page => page.items) } : undefined };
  const refresh = async () => { await onChanged(); await client.invalidateQueries({ queryKey: ['collaboration-submissions', projectId, task.taskId] }); };
  useEffect(() => { if (job.isSettled) { void client.invalidateQueries({ queryKey: ['collaboration-tasks', projectId] }); void client.invalidateQueries({ queryKey: ['collaboration-submissions', projectId, task.taskId] }); } }, [job.isSettled, jobId, projectId, task.taskId, client]);
  const submit = useMutation({ mutationFn: async (submitted: TaskSubmissionDraft) => { if (submissionOutdated) throw new Error('任务或验收标准已变化，请重新载入并核对。'); if (filesBusy) throw new Error('请等待文件上传或处理失败项。'); persistDraft(submitted); const files = await client.fetchQuery({ queryKey: taskFilesKey(projectId, task.taskId), queryFn: () => listTaskFiles(projectId, task.taskId), staleTime: 0 }); const active = files.filter(file => !file.archivedAt && !file.materialArchivedAt && !file.deletedAt); if (active.length > 10) throw new Error('每轮最多提交 10 个文件，请归档不参与本轮的文件。'); return collaborationApi.submit(projectId, { ...task, revision: submitted.baseRevision }, submitted.body.trim(), active.map(file => file.versionId)); }, onSuccess: async (result, submitted) => {
    // API success includes the offline queue's durable write; failed requests keep the draft.
    const cleared = Boolean(meId && removeTaskSubmissionDraft(meId, projectId, task.taskId, submitted));
    setDraft(current => ({ ...current, body: '', conflict: false, restored: false, persisted: true, cleanupFailed: !cleared }));
    setEvaluationNotice(result.evaluationError ?? ''); if (result.evaluationJobId) setJobId(result.evaluationJobId); await refresh();
  }, onError: async error => { if (error instanceof ApiError && error.status === 409) persistDraft({ body, baseRevision: submissionBase, conflict: true }); await refresh(); } });
  useSettingsDirty(submit.isPending || (Boolean(body || submissionConflict) && !draft.persisted));
  useEffect(() => {
    if (!body && !submissionConflict && !submit.isPending) setDraft(current => current.baseRevision === task.revision ? current : { ...current, baseRevision: task.revision });
  }, [body, submissionConflict, submit.isPending, task.revision]);
  const submitBlockedReason = submissionOutdated ? '任务或验收标准已更新，请先核对。' : filesBusy ? filesBlockedReason || '请等待文件上传或处理失败项。' : !body.trim() ? '请填写成果说明。' : '';
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
      <SubmissionBody body={submission.body}/><details><summary>本轮验收标准与成果文件<AiReferenceBadge ariaHidden /></summary><p className="collab-preserve">{submission.criteria}<AiReferenceBadge /></p>{submission.materialVersionIds.length ? <ul>{submission.materialVersionIds.map(id => <li key={id}>{submission.materialVersions?.find(version => version.versionId === id) ? <BoundMaterialVersion projectId={projectId} version={submission.materialVersions.find(version => version.versionId === id)!} /> : <>材料固定版本：{id}</>}</li>)}</ul> : <p>本轮为纯文字成果</p>}</details>
      {submission.aiReport && <div className="callout"><AiReferenceBadge /><RemovedSourceNotice payload={submission.aiReport} /><strong>{submission.aiReport.humanReview?.status === 'resolved' ? '原 AI 证据覆盖：' : 'AI 证据覆盖：'}{submission.aiReport.coverage === 'complete' ? '模型认为文本证据完整' : '需要人工核验'}</strong><ul>{submission.aiReport.evidence.map((evidence, index) => <li key={index}><span>固定版本 {evidence.materialVersionId}</span><p className="collab-preserve">{evidence.quote}</p></li>)}</ul>{submission.aiReport.manualReviewReason && <p className="notice notice-warn">{submission.aiReport.humanReview?.status === 'resolved' ? '原 AI 待审核原因：' : '待人工审核原因：'}{submission.aiReport.manualReviewReason}</p>}{submission.aiReport.limitations.length > 0 && <><strong>限制与待核验项</strong><ul>{submission.aiReport.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></>}</div>}
      <AssistiveRubricScores projectId={projectId} submission={submission} owner={owner && !readOnly} onChanged={refresh} />
      {submission.aiDecision && <div className="callout"><strong>AI 建议：{decisionLabels[submission.aiDecision]}<AiReferenceBadge ariaHidden /></strong><p className="collab-preserve">{submission.aiFeedback}</p></div>}
      {submission.decision && <div className="callout"><strong>{submission.pendingHumanReview ? '已完成（待人工审核）' : `验收决定：${decisionLabels[submission.decision]}`}</strong><p className="collab-preserve"><AiReferenceBadge />{submission.feedback}</p></div>}
      {!readOnly && current?.submissionId === submission.submissionId && owner && <SubmissionDecisionForm projectId={projectId} submission={submission} onChanged={refresh} />}
    </article>);
  if (view === 'settings') return <TaskSettings projectId={projectId} task={task} tasks={tasks} graphRevision={graphRevision} canManage={owner} meId={meId} members={members} onChanged={onChanged} closeGuard={closeGuard} stateLabel={taskStateLabel(task)} statusContent={<TaskLifecycleDetail view="submit" projectId={projectId} task={task} tasks={tasks} graphRevision={graphRevision} owner={owner} meId={meId} members={members} onChanged={onChanged} />} />;
  return <div className="stack collab-detail">
    <div hidden={historyPage}>
    <section aria-label="查看与提交" hidden={view !== 'submit'} className="stack">
    {!!task.unfinishedDependencyIds?.length && <p className="notice notice-warn">尚未完成：{task.unfinishedDependencyIds.map(id => tasks.find(item => item.taskId === id)?.title ?? id).join('、')}。你可以提前认领、执行和提交。</p>}
    {draft.cleanupFailed && <p className="notice notice-warn" role="status">成果已保存，但浏览器未能清理旧本机草稿。刷新后若再次恢复，请先核对提交历史。</p>}
    {canSubmit && <section className="collab-submit"><h3>{task.currentSubmissionId ? '提交新一轮成果' : '提交成果'}</h3><form className="stack" onSubmit={event => { event.preventDefault(); submit.mutate({ body, baseRevision: submissionBase, conflict: submissionConflict }); }}>
      {submissionOutdated && <div className="notice notice-warn">任务或验收标准已更新。请先核对任务设置中的最新标准，再选择保留草稿继续提交或重新填写；当前草稿尚未提交。</div>}
      {submissionOutdated && <div className="collab-toolbar"><button type="button" className="button button-quiet" disabled={submit.isPending} onClick={() => { persistDraft({ body, baseRevision: task.revision, conflict: false }); submit.reset(); }}>已核对标准，保留草稿继续提交</button><button type="button" className="button button-quiet" disabled={submit.isPending} onClick={() => { persistDraft({ body: '', baseRevision: task.revision, conflict: false }); submit.reset(); }}>已核对标准，重新填写本轮提交</button></div>}
      <Field aiReference label="成果说明"><textarea className="input" required rows={4} maxLength={12000} disabled={submit.isPending} value={body} onChange={event => persistDraft({ body: event.target.value, baseRevision: !body && !submissionConflict && !submit.isPending ? task.revision : submissionBase, conflict: submissionConflict })} placeholder="逐项说明验收标准如何达成、待解决问题以及材料位置" /></Field>
      {draft.persisted && Boolean(body || submissionConflict) && <p className="form-note" role="status">{draft.restored ? '已恢复本机成果草稿' : '成果说明已保存到本机草稿'}，尚未提交。切换页面或关闭后可继续填写。</p>}
      {!draft.persisted && Boolean(body || submissionConflict) && <p className="notice notice-warn" role="alert">浏览器无法保存本机成果草稿；当前文字仅留在此页面内存，切换页面或关闭后会丢失。请复制备份，或连接服务后提交。</p>}
      {draft.readFailed && <p className="notice notice-warn" role="alert">浏览器无法读取本机成果草稿，请检查存储权限或备份。当前页面不会自动覆盖无法读取的草稿。</p>}
      <TaskFileUploads projectId={projectId} taskId={task.taskId} disabled={submit.isPending} onBusy={updateFilesStatus} />
      {submitBlockedReason && <p className="form-note" role="status">{submitBlockedReason}</p>}
      {submit.error && <ErrorNotice error={submit.error} />}<button className="button button-primary" title={submitBlockedReason || undefined} disabled={submit.isPending || submissionOutdated || filesBusy || !body.trim()}>{submit.isPending ? '提交中…' : '提交本轮成果'}</button>
    </form></section>}
    {!task.assigneeId && <p className="form-note">请先认领任务或由安排分工，再提交成果。</p>}
    {evaluationNotice && <div className="notice notice-warn">成果已保存，AI 评价未启动：{evaluationNotice}。可由项目负责人或拥有任务管理权限的成员手动验收。</div>}
    {history.isLoading && <Spinner label="读取提交历史" />}{history.error && <ErrorNotice error={history.error} onRetry={() => void history.refetch()} />}
    {history.data?.items.length === 0 && <p className="muted">{task.lifecycleState === 'accepted' && !task.currentSubmissionId ? '历史完成状态已保留，未补造提交与验收记录。' : '尚未提交成果。'}</p>}
    {current && renderSubmission(current)}
    </section>
    </div>
    {historyPage && <section className="stack" aria-label="提交与验收历史"><h3>提交与验收历史<AiReferenceBadge ariaHidden /></h3>
    {history.isLoading && <Spinner label="读取提交历史" />}{history.error && <ErrorNotice error={history.error} onRetry={() => void history.refetch()} />}
    {history.data?.items.length === 0 && <p className="muted">{task.lifecycleState === 'accepted' && !task.currentSubmissionId ? '历史完成状态已保留，未补造提交与验收记录。' : '尚未提交成果。'}</p>}
    {selectedHistory && <><div className="collab-history-pager"><button className="button button-small" disabled={historyIndex === 0} onClick={() => setHistoryId(orderedHistory[historyIndex - 1]!.submissionId)}>上一页</button><Field label="选择提交轮次"><select className="input" value={selectedHistory.submissionId} onChange={event => setHistoryId(event.target.value)}>{orderedHistory.map(item => <option key={item.submissionId} value={item.submissionId}>第 {item.round} 轮</option>)}</select></Field><span aria-live="polite">第 {historyIndex + 1} / {orderedHistory.length} 页</span><button className="button button-small" disabled={historyIndex === orderedHistory.length - 1} onClick={() => setHistoryId(orderedHistory[historyIndex + 1]!.submissionId)}>下一页</button></div>{renderSubmission(selectedHistory, true)}</>}
    </section>}
    <LoadMore query={historyPages} label="提交历史" />
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
  return <form className="stack collab-decision" onSubmit={event => { event.preventDefault(); decide.mutate(); }}><h4>{submission.pendingHumanReview ? '人工审核' : '人工验收'}</h4><Field aiReference label={`第 ${submission.round} 轮验收结论`}><select className="input" value={decision} onChange={event => setDecision(event.target.value as SubmissionDecision)}>{Object.entries(decisionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field aiReference label={`第 ${submission.round} 轮验收理由`}><textarea className="input" required rows={3} maxLength={4000} value={feedback} onChange={event => setFeedback(event.target.value)} placeholder="逐项说明通过依据，或列出下轮需要改进、重做的内容" /></Field>{decisionOutdated && <div className="notice notice-warn">本轮评价已更新，请核对新记录后重新填写验收决定。</div>}{decisionOutdated && <button type="button" className="button button-quiet" onClick={() => { setDecisionBase(submission.revision); setDecisionConflict(false); setFeedback(''); setDecision('accept'); decide.reset(); }}>已核对最新评价，重新填写决定</button>}{decide.error && <ErrorNotice error={decide.error} />}<button className="button button-primary" disabled={decide.isPending || decisionOutdated || !feedback.trim()}>{decide.isPending ? '记录中…' : submission.pendingHumanReview ? '确认人工审核' : '确认验收决定'}</button></form>;
}

function BoundMaterialVersion({ projectId, version }: { projectId: string; version: NonNullable<TaskSubmission['materialVersions']>[number] }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ['materialVersion', projectId, version.materialId, version.versionId], queryFn: () => api.get<'MaterialVersionResponse'>(projectPath(projectId, `/materials/${encodeURIComponent(version.materialId)}/versions/${encodeURIComponent(version.versionId)}`)), enabled: open });
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{version.title} · 固定版本 r{version.revision}<AiReferenceBadge ariaHidden /></summary>{query.isLoading && <Spinner label="读取已绑定成果" />}{query.error && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}{query.data && <><p className="collab-preserve">{query.data.markdown || '此版本无文本正文'}</p>{query.data.attachments.length > 0 && <><ul>{query.data.attachments.map(attachment => <li key={attachment.fileId}><a href={projectPath(projectId, `/files/${encodeURIComponent(attachment.fileId)}/content`)} download={attachment.name}>{attachment.name}</a><AiReferenceBadge /></li>)}</ul></>}</>}</details>;
}
