import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Plus, Sparkles, UserRound } from 'lucide-react';
import { api, listAllItems, projectPath } from '../api/client';
import { collaborationApi, type CollaborationTask, type SubmissionDecision, type TaskSubmission } from '../api/collaboration';
import { useCapabilities } from '../auth';
import { useProject } from '../components/ProjectShell';
import { EmptyState, ErrorNotice, Field, Modal, SectionCard, Spinner, StatusPill } from '../components/ui';
import { jobStatusLabel, useVisibleJobPoller } from './aiWorkflowSupport';
import './CollaborationWorkspace.css';

const lifecycleLabels = { open: '待认领', in_progress: '进行中', submitted: '待验收', accepted: '已通过', improve: '需改进', rework: '需重做' };
const decisionLabels = { accept: '通过', improve: '改进', rework: '重做' };
const defaultDraft = { title: '', detail: '', criteria: '', effortHours: '1', parentTaskId: '' };

export function CollaborationWorkspace() {
  const { projectId, project } = useProject();
  const client = useQueryClient();
  const owner = project.myRole === 'owner';
  const capabilities = useCapabilities();
  const aiEnabled = capabilities.data?.features.aiEnabled === true;
  const tasks = useQuery({ queryKey: ['collaboration-tasks', projectId], queryFn: () => collaborationApi.tasks(projectId) });
  const settings = useQuery({ queryKey: ['collaboration-settings', projectId], queryFn: () => collaborationApi.settings(projectId) });
  const members = useQuery({ queryKey: ['members', projectId], queryFn: () => listAllItems<'MemberListResponse'>(projectPath(projectId, '/members')) });
  const me = useQuery({ queryKey: ['member-me', projectId], queryFn: () => api.get<'MemberResponse'>(projectPath(projectId, '/members/me')) });
  const proposals = useQuery({ queryKey: ['collaboration-proposals', projectId], queryFn: () => collaborationApi.proposals(projectId), enabled: owner });
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState(defaultDraft);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('task') ?? '';
  const setSelectedId = (id: string) => { const next = new URLSearchParams(searchParams); if (id) next.set('task', id); else next.delete('task'); setSearchParams(next, { replace: true }); };
  const [brief, setBrief] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useVisibleJobPoller(jobId);
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
  const rows = tasks.data?.items ?? [];
  const selected = rows.find(row => row.taskId === selectedId);
  const invalidate = async () => { await Promise.all([client.invalidateQueries({ queryKey: ['collaboration-tasks', projectId] }), client.invalidateQueries({ queryKey: ['collaboration-proposals', projectId] }), client.invalidateQueries({ queryKey: ['tasks', projectId] })]); };
  useEffect(() => { if (job.isSettled) { void client.invalidateQueries({ queryKey: ['collaboration-tasks', projectId] }); void client.invalidateQueries({ queryKey: ['collaboration-proposals', projectId] }); void client.invalidateQueries({ queryKey: ['collaboration-submissions', projectId] }); } }, [job.isSettled, jobId, client, projectId]);
  const create = useMutation({ mutationFn: () => collaborationApi.createTask(projectId, { ...draft, title: draft.title.trim(), criteria: draft.criteria.trim(), effortHours: Number(draft.effortHours), parentTaskId: draft.parentTaskId || null }), onSuccess: async () => { setCreateOpen(false); setDraft(defaultDraft); await invalidate(); } });
  const claim = useMutation({ mutationFn: (task: CollaborationTask) => collaborationApi.claim(projectId, task), onSuccess: invalidate, onError: invalidate });
  const ai = useMutation({ mutationFn: (action: 'decompose' | 'assign') => action === 'decompose' ? collaborationApi.decompose(projectId, brief.trim()) : collaborationApi.suggestAssignments(projectId, rows.filter(row => !row.assigneeId && row.lifecycleState === 'open').slice(0, 20).map(row => row.taskId)), onSuccess: result => { setHandoffNotice(''); setJobId(result.jobId); } });
  const apply = useMutation({ mutationFn: (proposal: NonNullable<typeof proposals.data>['items'][number]) => collaborationApi.apply(projectId, proposal), onSuccess: invalidate, onError: invalidate });
  return <SectionCard title="协作任务闭环" detail="明确验收标准 → 认领或分工 → 提交固定版本成果 → 评价与负责人决定。全流程支持手动完成。">
    <div className="collab-toolbar"><div className="chip-list"><span className="chip">分工：{!settings.data ? '尚未读取' : settings.data.assignmentMode === 'automatic' ? '自动应用 AI' : '负责人确认'}</span><span className="chip">验收：{!settings.data ? '尚未读取' : settings.data.evaluationMode === 'automatic' ? '自动应用 AI' : '负责人确认'}</span></div>{owner && <button className="button button-primary" onClick={() => { create.reset(); setCreateOpen(true); }}><Plus size={16} />新建协作任务</button>}</div>
    {[tasks.error, settings.error, members.error, me.error, claim.error].filter(Boolean).map((error, index) => <ErrorNotice key={index} error={error} />)}
    {tasks.isLoading && <Spinner label="读取协作任务" />}
    {!tasks.isLoading && !tasks.error && !rows.length && <EmptyState title="把交付目标变成明确任务" detail="先写清完成标准与预计投入，再由成员认领。无需开启 AI。" />}
    <div className="collab-grid">{rows.map(task => <article className="collab-task" key={task.taskId}>
      <div className="collab-toolbar"><StatusPill tone={task.lifecycleState === 'accepted' ? 'good' : ['improve', 'rework'].includes(task.lifecycleState) ? 'warn' : 'blue'}>{lifecycleLabels[task.lifecycleState]}</StatusPill><small>{task.effortHours} 小时</small></div>
      <button className="collab-title" onClick={() => setSelectedId(task.taskId)}>{task.title}</button>
      <p className="collab-criteria">{task.criteria}</p>
      {task.parentTaskId && <small>子任务 · {rows.find(row => row.taskId === task.parentTaskId)?.title ?? task.parentTaskId}</small>}
      <div className="collab-toolbar"><span className="tm-meta-item"><UserRound size={14} />{members.data?.find(member => member.userId === task.assigneeId)?.displayName ?? (task.assigneeId ? '项目成员' : '尚未认领')}</span>{!task.assigneeId && task.lifecycleState === 'open' && <button className="button button-small" disabled={claim.isPending || !me.data} onClick={() => claim.mutate(task)}>我来认领</button>}<button className="button button-quiet button-small" onClick={() => setSelectedId(task.taskId)}>查看与提交</button></div>
    </article>)}</div>
    {owner && <details className="collab-ai"><summary><Sparkles size={16} />AI 拆解与分工</summary>
      <p className="form-note">拆解和分工遵循项目分工设置：确认模式先预览，自动模式可直接创建及分配。过期结果不会覆盖成员的新操作。</p>
      {!aiEnabled && <p className="notice notice-warn">AI 当前不可用；可以继续手动创建、分工、提交和验收，不会生成模拟结果。</p>}
      <Field label="拆解目标"><textarea className="input" rows={3} maxLength={4000} value={brief} onChange={event => setBrief(event.target.value)} placeholder="描述目标、交付范围与约束，AI 将建议可验收的子任务" /></Field>
      <div className="form-actions"><button className="button" disabled={!aiEnabled || !brief.trim() || ai.isPending || (!!jobId && !job.isSettled)} onClick={() => ai.mutate('decompose')}>生成拆解建议</button><button className="button" disabled={!aiEnabled || ai.isPending || !rows.some(row => !row.assigneeId && row.lifecycleState === 'open') || (!!jobId && !job.isSettled)} onClick={() => ai.mutate('assign')}>建议未认领任务分工（最多20项）</button></div>
      {ai.error && <ErrorNotice error={ai.error} />}
      {handoffNotice && <p className="form-note">{handoffNotice}</p>}
      <JobProgress job={job} />
      {proposals.error && <ErrorNotice error={proposals.error} />}
      {proposals.data?.items.map(proposal => <article key={proposal.proposalId} className="collab-proposal"><div className="collab-toolbar"><strong>{proposal.kind === 'decompose' ? '任务拆解建议' : '团队分工建议'}</strong><StatusPill>{proposal.status === 'applied' ? '已应用' : proposal.status === 'stale' ? '已过期' : '待确认'}</StatusPill></div><ProposalPreview payload={proposal.payload} members={members.data ?? []} tasks={rows} /><button className="button button-primary button-small" disabled={proposal.status !== 'pending' || apply.isPending} onClick={() => apply.mutate(proposal)}>确认并应用建议</button></article>)}
      {apply.error && <ErrorNotice error={apply.error} />}
    </details>}
    {createOpen && <Modal title="新建协作任务" onClose={() => setCreateOpen(false)}><form className="stack" onSubmit={event => { event.preventDefault(); create.mutate(); }}>
      <Field label="任务名称"><input className="input" required maxLength={200} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></Field>
      <Field label="任务说明"><textarea className="input" rows={3} maxLength={4000} value={draft.detail} onChange={event => setDraft({ ...draft, detail: event.target.value })} /></Field>
      <Field label="验收标准" hint="写明可核对的交付物、质量要求与完成条件。"><textarea className="input" required rows={4} maxLength={4000} value={draft.criteria} onChange={event => setDraft({ ...draft, criteria: event.target.value })} /></Field>
      <div className="form-grid-two"><Field label="预计投入（小时）"><input className="input" type="number" required min="0.25" max="200" step="0.25" value={draft.effortHours} onChange={event => setDraft({ ...draft, effortHours: event.target.value })} /></Field><Field label="父任务（选填）"><select className="input" value={draft.parentTaskId} onChange={event => setDraft({ ...draft, parentTaskId: event.target.value })}><option value="">独立任务</option>{rows.map(task => <option key={task.taskId} value={task.taskId}>{task.title}</option>)}</select></Field></div>
      {create.error && <ErrorNotice error={create.error} />}<div className="form-actions"><button type="button" className="button button-quiet" onClick={() => setCreateOpen(false)}>取消</button><button className="button button-primary" disabled={create.isPending || !draft.title.trim() || !draft.criteria.trim()}>{create.isPending ? '创建中…' : '创建协作任务'}</button></div>
    </form></Modal>}
    {selected && <Modal title={selected.title} onClose={() => setSelectedId('')}><TaskLifecycleDetail key={selected.taskId} projectId={projectId} task={selected} childrenTasks={rows.filter(row => row.parentTaskId === selected.taskId)} owner={owner} meId={me.data?.userId} members={members.data ?? []} aiEnabled={aiEnabled} onChanged={invalidate} /></Modal>}
  </SectionCard>;
}

function JobProgress({ job }: { job: ReturnType<typeof useVisibleJobPoller> }) {
  const result = job.job?.result && typeof job.job.result === 'object' ? job.job.result as Record<string, unknown> : null;
  const reasons = Array.isArray(result?.manualReviewReasons) ? result.manualReviewReasons.filter((value): value is string => typeof value === 'string') : [];
  const error = job.job?.error;
  const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '执行失败，未生成有效建议。可重新发起。';
  return <>{job.loading && <Spinner label="读取 AI 任务进度" />}{job.error && <ErrorNotice error={job.error} />}{job.job && <div className={`notice ${job.job.status === 'failed' ? 'notice-error' : ''}`}>AI 任务：{jobStatusLabel(job.job.status)}{job.job.status === 'failed' && <span> · {message}</span>}{job.job.status === 'succeeded' && typeof result?.autoApplied === 'boolean' && <span> · {result.autoApplied ? '已按自动模式应用' : '未自动应用，请负责人核验并确认'}</span>}</div>}{typeof result?.followupError === 'string' && <p className="notice notice-warn">任务已拆解，但自动分工未启动：{result.followupError}。可手动认领或安排分工。</p>}{typeof result?.applyError === 'string' && <p className="notice notice-warn">未应用原因：{result.applyError}</p>}{reasons.length > 0 && <div className="callout"><strong>需要人工核验</strong><ul>{reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>}</>;
}

function ProposalPreview({ payload, members, tasks }: { payload: Record<string, unknown>; members: { userId: string; displayName: string }[]; tasks: CollaborationTask[] }) {
  const entries = Array.isArray(payload.tasks) ? payload.tasks : Array.isArray(payload.assignments) ? payload.assignments : [];
  return <ul>{entries.map((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object') return null;
    const row = entry as Record<string, unknown>;
    return <li key={index}><strong>{typeof row.title === 'string' ? row.title : tasks.find(task => task.taskId === row.taskId)?.title ?? String(row.taskId ?? '任务')}</strong>{typeof row.criteria === 'string' && <p>{row.criteria}</p>}{typeof row.effortHours === 'number' && <small>预计 {row.effortHours} 小时 · </small>}{typeof row.assigneeId === 'string' && <span>{members.find(member => member.userId === row.assigneeId)?.displayName ?? row.assigneeId}</span>}{typeof row.reason === 'string' && <p>{row.reason}</p>}</li>;
  })}</ul>;
}

function TaskLifecycleDetail({ projectId, task, childrenTasks, owner, meId, members, aiEnabled, onChanged }: { projectId: string; task: CollaborationTask; childrenTasks: CollaborationTask[]; owner: boolean; meId?: string; members: { userId: string; displayName: string }[]; aiEnabled: boolean; onChanged: () => Promise<void> }) {
  const client = useQueryClient();
  const [editDraft, setEditDraft] = useState({ title: task.title, detail: task.detail, criteria: task.criteria, effortHours: String(task.effortHours) });
  const [editSaved, setEditSaved] = useState(false);
  const [assigneeId, setAssigneeId] = useState(task.assigneeId ?? '');
  const [reason, setReason] = useState('');
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
  const edit = useMutation({ mutationFn: () => collaborationApi.updateTask(projectId, task, { title: editDraft.title.trim(), detail: editDraft.detail.trim(), criteria: editDraft.criteria.trim(), effortHours: Number(editDraft.effortHours) }), onSuccess: async () => { setEditSaved(true); await refresh(); }, onError: refresh });
  const assign = useMutation({ mutationFn: () => collaborationApi.assign(projectId, task, assigneeId, reason.trim()), onSuccess: refresh, onError: refresh });
  const submit = useMutation({ mutationFn: () => collaborationApi.submit(projectId, task, body.trim(), versions.map(version => version.id)), onSuccess: async result => { setBody(''); setVersions([]); setEvaluationNotice(result.evaluationError ?? ''); if (result.evaluationJobId) setJobId(result.evaluationJobId); await refresh(); }, onError: refresh });
  const evaluate = useMutation({ mutationFn: (submissionId: string) => collaborationApi.evaluate(projectId, submissionId), onSuccess: result => setJobId(result.jobId) });
  const current = history.data?.items.find(submission => submission.submissionId === task.currentSubmissionId);
  useEffect(() => { if (!jobId && current?.evaluationJobId && !current.decision) setJobId(current.evaluationJobId); }, [current?.evaluationJobId, current?.decision, jobId]);
  const canSubmit = task.assigneeId === meId && ['in_progress', 'improve', 'rework'].includes(task.lifecycleState);
  return <div className="stack collab-detail">
    <div className="collab-toolbar"><StatusPill>{lifecycleLabels[task.lifecycleState]}</StatusPill><span>预计 {task.effortHours} 小时 · r{task.revision}</span></div>
    {!owner && task.assigneeId !== meId && <p className="form-note">仅任务执行人可提交成果；负责人可安排分工与验收。</p>}
    <p>{task.detail}</p><div className="callout"><strong>验收标准</strong><p className="collab-preserve">{task.criteria}</p></div>
    {childrenTasks.length > 0 && <div className="callout"><strong>子任务进度</strong><ul>{childrenTasks.map(child => <li key={child.taskId}>{child.title} · {lifecycleLabels[child.lifecycleState]}</li>)}</ul><p className="form-note">父任务的整体交付需要负责人最终验收；即使开启自动评价，也不会自动通过父任务。</p></div>}
    {owner && ['open', 'in_progress', 'improve', 'rework'].includes(task.lifecycleState) && <details><summary>调整任务与验收标准</summary><form className="stack" onSubmit={event => { event.preventDefault(); edit.mutate(); }}>
      <p className="form-note">用于修正任务拆解结果。新标准仅用于后续提交，历史轮次保留当时标准；待验收及已通过任务不可直接修改。</p>
      <Field label="调整任务名称"><input className="input" required maxLength={200} value={editDraft.title} onChange={event => { setEditSaved(false); setEditDraft({ ...editDraft, title: event.target.value }); }} /></Field>
      <Field label="调整任务说明"><textarea className="input" rows={3} maxLength={4000} value={editDraft.detail} onChange={event => { setEditSaved(false); setEditDraft({ ...editDraft, detail: event.target.value }); }} /></Field>
      <Field label="调整验收标准"><textarea className="input" required rows={4} maxLength={4000} value={editDraft.criteria} onChange={event => { setEditSaved(false); setEditDraft({ ...editDraft, criteria: event.target.value }); }} /></Field>
      <Field label="调整预计投入（小时）"><input className="input" required type="number" min="0.25" max="200" step="0.25" value={editDraft.effortHours} onChange={event => { setEditSaved(false); setEditDraft({ ...editDraft, effortHours: event.target.value }); }} /></Field>
      {edit.error && <ErrorNotice error={edit.error} />}{editSaved && <p role="status">任务调整已保存</p>}<button className="button" disabled={edit.isPending || !editDraft.title.trim() || !editDraft.criteria.trim()}>{edit.isPending ? '保存中…' : '保存任务调整'}</button>
    </form></details>}
    {owner && ['open', 'in_progress', 'submitted', 'improve', 'rework'].includes(task.lifecycleState) && <details><summary>负责人分工</summary><form className="stack" onSubmit={event => { event.preventDefault(); assign.mutate(); }}>
      {task.lifecycleState === 'submitted' && <p className="notice notice-warn">重新分配会撤回当前提交并使待处理评价失效，历史保留。请确认后填写调整理由。</p>}
      <Field label="任务执行人"><select className="input" required value={assigneeId} onChange={event => setAssigneeId(event.target.value)}><option value="">选择成员</option>{members.map(member => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}</select></Field>
      <Field label="分工理由"><textarea className="input" required maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} placeholder="说明匹配的技能、投入时间及调整原因" /></Field>
      {assign.error && <ErrorNotice error={assign.error} />}<button className="button" disabled={assign.isPending || !reason.trim() || !assigneeId}>确认分工</button>
    </form></details>}
    {canSubmit && <section className="collab-submit"><h3>{task.currentSubmissionId ? '提交新一轮成果' : '提交成果'}</h3><form className="stack" onSubmit={event => { event.preventDefault(); submit.mutate(); }}>
      <Field label="成果说明"><textarea className="input" required rows={4} maxLength={12000} value={body} onChange={event => setBody(event.target.value)} placeholder="逐项说明验收标准如何达成、待解决问题以及材料位置" /></Field>
      <Field label="绑定材料版本" hint="选择已保存的固定版本；之后编辑材料不会改变本轮提交。可跨材料选择，最多 10 个版本。"><select className="input" value={materialId} onChange={event => setMaterialId(event.target.value)}><option value="">选择材料</option>{materials.data?.map(material => <option key={material.materialId} value={material.materialId}>{material.title}</option>)}</select></Field>
      {materials.error && <ErrorNotice error={materials.error} />}{materialVersions.isLoading && <Spinner label="读取固定版本" />}{materialVersions.error && <ErrorNotice error={materialVersions.error} />}
      {materialId && materialVersions.data?.length === 0 && <p className="form-note">该材料还没有已保存版本，请先到材料中心保存。</p>}
      <div className="collab-version-list">{materialVersions.data?.map(version => <label key={version.versionId} className="collab-version"><input type="checkbox" disabled={versions.length >= 10 && !versions.some(item => item.id === version.versionId)} checked={versions.some(item => item.id === version.versionId)} onChange={event => setVersions(currentVersions => event.target.checked ? [...currentVersions, { id: version.versionId, label: `${materials.data?.find(material => material.materialId === materialId)?.title ?? '材料'} · r${version.revision}` }] : currentVersions.filter(item => item.id !== version.versionId))} /><span>r{version.revision} · {new Date(version.createdAt).toLocaleString('zh-CN')}{version.attachments.length > 0 && <small>含 {version.attachments.length} 个附件，仅供人工参考</small>}</span></label>)}</div>
      {versions.length > 0 && <div className="chip-list">{versions.map(version => <button type="button" className="chip" key={version.id} onClick={() => setVersions(items => items.filter(item => item.id !== version.id))}>{version.label} ×</button>)}</div>}
      <p className="form-note">AI 仅依据提交说明和材料文本评价。图片、音视频及附件内容不视为已读取，请负责人另行核验。</p>
      {submit.error && <ErrorNotice error={submit.error} />}<button className="button button-primary" disabled={submit.isPending || !body.trim()}>{submit.isPending ? '提交中…' : '提交本轮成果'}</button>
    </form></section>}
    {!task.assigneeId && <p className="form-note">请先认领任务或由负责人分工，再提交成果。</p>}
    {evaluationNotice && <div className="notice notice-warn">成果已保存，AI 评价未启动：{evaluationNotice}。可由负责人手动验收。</div>}
    <h3>提交与验收历史</h3>
    {history.isLoading && <Spinner label="读取提交历史" />}{history.error && <ErrorNotice error={history.error} onRetry={() => void history.refetch()} />}
    {history.data?.items.length === 0 && <p className="muted">尚未提交成果。</p>}
    {history.data?.items.map(submission => <article className="collab-history" key={submission.submissionId}>
      <div className="collab-toolbar"><strong>第 {submission.round} 轮</strong><small>{new Date(submission.createdAt).toLocaleString('zh-CN')} · {members.find(member => member.userId === submission.submittedBy)?.displayName ?? '项目成员'}</small><StatusPill>{submission.decision ? decisionLabels[submission.decision] : submission.aiDecision ? 'AI 已评价，待确认' : '待评价'}</StatusPill></div>
      <p className="collab-preserve">{submission.body}</p><details><summary>本轮验收标准与绑定版本</summary><p className="collab-preserve">{submission.criteria}</p>{submission.materialVersionIds.length ? <ul>{submission.materialVersionIds.map(id => <li key={id}>{submission.materialVersions?.find(version => version.versionId === id) ? <BoundMaterialVersion projectId={projectId} version={submission.materialVersions.find(version => version.versionId === id)!} /> : <>材料固定版本：{id}</>}</li>)}</ul> : <p>未绑定材料版本</p>}</details>
      {submission.aiReport && <div className="callout"><strong>证据覆盖：{submission.aiReport.coverage === 'complete' ? '模型认为文本证据完整' : '需要人工核验'}</strong><ul>{submission.aiReport.evidence.map((evidence, index) => <li key={index}><span>固定版本 {evidence.materialVersionId}</span><p className="collab-preserve">{evidence.quote}</p></li>)}</ul>{submission.aiReport.manualReviewReason && <p className="notice notice-warn">{submission.aiReport.manualReviewReason}</p>}{submission.aiReport.limitations.length > 0 && <><strong>限制与待核验项</strong><ul>{submission.aiReport.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></>}</div>}
      {submission.aiDecision && <div className="callout"><strong>AI 建议：{decisionLabels[submission.aiDecision]}</strong><p className="collab-preserve">{submission.aiFeedback}</p><p className="form-note">仅供协作评价，不是能力评定；未读取的附件需人工核验。</p></div>}
      {submission.decision && <div className="callout"><strong>验收决定：{decisionLabels[submission.decision]}</strong><p className="collab-preserve">{submission.feedback}</p></div>}
      {current?.submissionId === submission.submissionId && !submission.decision && (owner || submission.submittedBy === meId) && <><button className="button button-small" disabled={!aiEnabled || submission.status !== 'pending' || submission.evaluationAttempts >= 3 || evaluate.isPending || (!!jobId && !job.isSettled)} onClick={() => evaluate.mutate(submission.submissionId)}><Sparkles size={14} />请求 AI 评价</button>{!aiEnabled && <p className="form-note">AI 未启用，负责人仍可直接验收。</p>}{submission.evaluationAttempts >= 3 && <p className="form-note">本轮 AI 评价已达 3 次上限，请负责人手动核验。</p>}{owner && <SubmissionDecisionForm projectId={projectId} submission={submission} onChanged={refresh} />}</>}
    </article>)}
    {evaluate.error && <ErrorNotice error={evaluate.error} />}<JobProgress job={job} />
  </div>;
}
function SubmissionDecisionForm({ projectId, submission, onChanged }: { projectId: string; submission: TaskSubmission; onChanged: () => Promise<void> }) {
  const [decision, setDecision] = useState<SubmissionDecision>('accept');
  const [feedback, setFeedback] = useState('');
  const decide = useMutation({ mutationFn: () => collaborationApi.decide(projectId, submission, decision, feedback.trim()), onSuccess: onChanged, onError: onChanged });
  return <form className="stack collab-decision" onSubmit={event => { event.preventDefault(); decide.mutate(); }}><h4>负责人明确验收</h4><Field label={`第 ${submission.round} 轮验收结论`}><select className="input" value={decision} onChange={event => setDecision(event.target.value as SubmissionDecision)}>{Object.entries(decisionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label={`第 ${submission.round} 轮验收理由`}><textarea className="input" required rows={3} maxLength={4000} value={feedback} onChange={event => setFeedback(event.target.value)} placeholder="逐项说明通过依据，或列出下轮需要改进、重做的内容" /></Field>{decide.error && <ErrorNotice error={decide.error} />}<button className="button button-primary" disabled={decide.isPending || !feedback.trim()}>{decide.isPending ? '记录中…' : '确认验收决定'}</button></form>;
}

function BoundMaterialVersion({ projectId, version }: { projectId: string; version: NonNullable<TaskSubmission['materialVersions']>[number] }) {
  const [open, setOpen] = useState(false);
  const query = useQuery({ queryKey: ['materialVersion', projectId, version.materialId, version.versionId], queryFn: () => api.get<'MaterialVersionResponse'>(projectPath(projectId, `/materials/${encodeURIComponent(version.materialId)}/versions/${encodeURIComponent(version.versionId)}`)), enabled: open });
  return <details onToggle={event => setOpen(event.currentTarget.open)}><summary>{version.title} · 固定版本 r{version.revision}</summary>{query.isLoading && <Spinner label="读取已绑定成果" />}{query.error && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}{query.data && <><p className="collab-preserve">{query.data.markdown || '此版本无文本正文'}</p>{query.data.attachments.length > 0 && <><p className="form-note">以下附件仅供人工核验，AI 未读取其内容。</p><ul>{query.data.attachments.map(attachment => <li key={attachment.fileId}><a href={projectPath(projectId, `/files/${encodeURIComponent(attachment.fileId)}/content`)} download={attachment.name}>{attachment.name}</a></li>)}</ul></>}</>}</details>;
}
