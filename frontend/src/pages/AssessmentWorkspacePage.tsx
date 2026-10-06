import { usePagedRecords } from '../features/pagination/usePagedItems';
import { LoadMore } from '../features/pagination/LoadMore';
import { VirtualList } from '../components/VirtualList';
import { AiReferenceBadge } from '../components/AiReferenceBadge';
import { RemovedSourceNotice } from './RemovedSourceNotice';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Play, RefreshCw } from 'lucide-react';
import { projectRequest, type Assessment, type AssessmentReport, type AssessmentEvidence, type ProjectGoal, type StandardVersion } from '../api/simplification';
import { projectPermission } from '../project-permissions';
import { useCapabilities, useSession } from '../auth';
import { useProject } from '../components/ProjectShell';
import { EmptyState, ErrorNotice, SectionCard, Spinner, StatusPill } from '../components/ui';
import { clearPendingJob, completeIntent, idempotencyKeyForIntent, jobStatusLabel, readPendingJob, retryBackendJob, useVisibleJobPoller, writePendingJob } from './aiWorkflowSupport';
import { StandardsEditor } from './StandardsEditor';
import { ReferencePicker } from './ReferencePicker';
import { RehearsalsPage } from './RehearsalsPage';
import './ProjectWorkspace.css';
import { ManualAssessmentEditor } from './ManualAssessmentEditor';

type PendingAssessment = { jobId: string; entityId: string; action: string; kind?: Assessment['kind']; previousJobId?: string };
const selectionParameters = ['assessmentId', 'reviewId', 'rehearsalId', 'review', 'rehearsal'] as const;
const activeAssessmentStatuses = ['pending', 'running', 'active', 'finishing', 'failed'];
const pendingKey = (id: string, accountId: string) => `ai-office:account:${accountId}:pending-assessment-job:${id}`;
function isScoringReport(report: Assessment['report']): report is AssessmentReport { return Boolean(report && (report.status === 'scored' || report.status === 'unscorable') && Array.isArray(report.scores)); }
export function AssessmentWorkspacePage() {
  const { projectId } = useProject();
  const [params] = useSearchParams();
  const section = params.get('section') ?? 'standards';
  return <div className="page-stack assessment-workspace">
    {section === 'standards' ? <StandardsEditor /> : <AssessmentRunner key={`${projectId}:${section}`} kind={section === 'rehearsals' ? 'rehearsal' : 'material_review'} />}
  </div>;
}
function AssessmentRunner({ kind }: { kind: Assessment['kind'] }) {
  const { projectId, project } = useProject();
  const canInitiate=projectPermission(project,'scoreInitiate');
  const client = useQueryClient();
  const capabilities = useCapabilities();
  const [params, setParams] = useSearchParams();
  const linkedId = params.get('assessmentId') ?? params.get('reviewId') ?? params.get('rehearsalId') ?? params.get('review') ?? params.get('rehearsal');
  const goal = useQuery({ queryKey: ['project-goal', projectId], queryFn: () => projectRequest<ProjectGoal>(projectId, '/goal') });
  const standards = useQuery({ queryKey: ['current-standard', projectId], queryFn: () => projectRequest<{ standard: StandardVersion | null }>(projectId, '/standards/current') });
  const history = usePagedRecords<Assessment>({ queryKey: ['assessments', projectId], path: `/api/v1/projects/${encodeURIComponent(projectId)}/assessments`, query: { kind } });
  const session = useSession();
  const draftKey = session.data?.id ? `ai-office:assessment-draft:${session.data.id}:${projectId}:${kind}` : null;
  const readDraft = () => { try { return draftKey ? JSON.parse(sessionStorage.getItem(draftKey) ?? '{}') as { materialVersions?: string[]; sourceVersions?: string[] } : {}; } catch { return {}; } };
  const [materialVersions, setMaterialVersions] = useState<string[]>(() => readDraft().materialVersions?.filter(item => typeof item === 'string') ?? []);
  const [sourceVersions, setSourceVersions] = useState<string[]>(() => readDraft().sourceVersions?.filter(item => typeof item === 'string') ?? []);
  useEffect(() => { if (draftKey) { try { sessionStorage.setItem(draftKey, JSON.stringify({ materialVersions, sourceVersions })); } catch { /* In-memory selections remain usable when storage is unavailable. */ } } }, [draftKey, materialVersions, sourceVersions]);
  const returnTo = `/app/projects/${encodeURIComponent(projectId)}/assessment?section=${kind === 'rehearsal' ? 'rehearsals' : 'reviews'}`;
  const supplement = (path: string) => `${path}${path.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(returnTo)}`;

  const [pending, setPending] = useState<PendingAssessment | null>(() => readPendingJob<PendingAssessment>(pendingKey(projectId, session.data?.id ?? 'anonymous')));
  const rows = (history.data ?? []).filter(item => item.kind === kind);
  const linkedRecord = (history.data ?? []).find(item => item.assessmentId === linkedId || item.rehearsalId === linkedId);
  const newlyCreatedId = pending?.kind === kind && pending.action === 'create' && pending.entityId === linkedId ? pending.entityId : '';
  const selectedId = linkedRecord?.kind === kind ? linkedRecord.assessmentId : newlyCreatedId || (!linkedRecord && linkedId && !history.isLoading ? linkedId : '') || rows[0]?.assessmentId || '';
  const selected = useQuery({ queryKey: ['assessment', projectId, selectedId], queryFn: () => projectRequest<Assessment>(projectId, `/assessments/${encodeURIComponent(selectedId)}`), enabled: Boolean(selectedId), refetchInterval: query => query.state.data && !query.state.data.historical && ['pending', 'running', 'active', 'finishing'].includes(query.state.data.status) ? 4000 : false, refetchIntervalInBackground: false });
  const currentStandard = standards.data?.standard;
  const select = (id: string) => { const next = new URLSearchParams(params); for (const key of selectionParameters) next.delete(key); next.set('assessmentId', id); setParams(next); };
  useEffect(() => {
    if (history.isLoading || !linkedId || linkedId === selectedId) return;
    const next = new URLSearchParams(params); for (const key of selectionParameters) next.delete(key);
    if (selectedId) next.set('assessmentId', selectedId);
    setParams(next, { replace: true });
  }, [history.isLoading, linkedId, selectedId, params, setParams]);
  const assessment = selected.data?.kind === kind && selected.data.assessmentId === selectedId ? selected.data : undefined;
  const recordActive = Boolean(assessment && !assessment.historical && activeAssessmentStatuses.includes(assessment.status));
  const matchingPending = recordActive && pending?.entityId === assessment?.assessmentId && (!pending?.kind || pending.kind === kind) && (pending?.jobId === assessment?.jobId || pending?.previousJobId === assessment?.jobId) ? pending : null;
  const activePending = recordActive && assessment ? matchingPending ?? (assessment.jobId ? { entityId: assessment.assessmentId, jobId: assessment.jobId, action: 'create', kind } : null) : null;
  const activeJobId = activePending?.jobId ?? null;
  const activeEntityId = activePending?.entityId ?? null;
  const job = useVisibleJobPoller(activeJobId);
  const canRetry = Boolean(currentStandard && assessment?.standardsVersionId === currentStandard.standardsVersionId && activePending && assessment?.assessmentId === activeEntityId && job.job?.jobId === activeJobId && job.job.status === 'failed' && (assessment.kind !== 'rehearsal' || assessment.canOperate === true));
  const create = useMutation({ mutationFn: async () => {
    if(!canInitiate)throw new Error('没有发起评分的项目权限');
    const body = { kind, materialVersionIds: [...materialVersions].sort(), sourceVersionIds: [...sourceVersions].sort(), goalRevision: goal.data?.revision };
    const namespace = `assessment-create:${projectId}:${kind}`;
    const idempotencyKey = await idempotencyKeyForIntent(namespace, body);
    const result = await projectRequest<{ assessmentId: string; jobId: string; rehearsalId?: string }>(projectId, '/assessments', { method: 'POST', body, idempotencyKey }); completeIntent(namespace); return result;
  }, onSuccess: async result => {
    if (draftKey) sessionStorage.removeItem(draftKey);
    const next = { entityId: result.assessmentId, jobId: result.jobId, action: 'create', kind }; writePendingJob(pendingKey(projectId, session.data?.id ?? 'anonymous'), next); setPending(next);
    if (result.rehearsalId) writePendingJob(`ai-office:account:${session.data?.id ?? 'anonymous'}:pending-rehearsal-job:${projectId}`, { entityId: result.rehearsalId, jobId: result.jobId, action: 'create' });
    select(result.assessmentId); await client.invalidateQueries({ queryKey: ['assessments', projectId] });
  } });
  const retry = useMutation({ mutationFn: async () => {
    if (!canRetry || !activePending || !assessment) throw new Error('当前评分记录没有可重试的失败作业。');
    const target = { ...activePending, kind, action: 'retry', previousJobId: activePending.jobId };
    const jobId = await retryBackendJob(projectId, target.jobId);
    return { ...target, jobId };
  }, onSuccess: next => {
    writePendingJob(pendingKey(projectId, session.data?.id ?? 'anonymous'), next); setPending(next);
    void client.invalidateQueries({ queryKey: ['assessments', projectId] });
    void client.invalidateQueries({ queryKey: ['assessment', projectId, next.entityId] });
  } });
  useEffect(() => {
    if (!activeEntityId || !activeJobId || job.job?.jobId !== activeJobId || job.job.status !== 'succeeded') return;
    clearPendingJob(pendingKey(projectId, session.data?.id ?? 'anonymous'), activeJobId);
    setPending(current => current?.entityId === activeEntityId && current.jobId === activeJobId ? null : current);
    void client.invalidateQueries({ queryKey: ['assessments', projectId] });
    void client.invalidateQueries({ queryKey: ['assessment', projectId, activeEntityId] });
  }, [activeEntityId, activeJobId, job.job?.jobId, job.job?.status, client, projectId]);
  const aiEnabled = capabilities.data?.features.aiEnabled === true;
  return <div className="page-stack">
    {!aiEnabled && <p className="notice notice-warn">AI 当前不可用，可以继续维护标准、人工评分及修正历史结果。</p>}
    <div className="assessment-layout">
      <SectionCard title={kind === 'rehearsal' ? '发起答辩演练评分' : '发起成果检查'} detail="依据项目标准核验成果，与自由审阅区分。固定主目标与标准；所选文件优先参考，系统发现并冻结实际成果版本。答辩评分依据本轮真实回答。">
        {[goal, standards].filter(query => query.error).map((query, index) => <ErrorNotice key={index} error={query.error} onRetry={() => void query.refetch()} />)}
        {goal.isLoading || standards.isLoading ? <Spinner label="读取目标与评分标准" /> : <form className="stack" onSubmit={event => { event.preventDefault(); if(canInitiate)create.mutate(); }}>
          <div className="callout"><strong>本轮主目标：{goal.data?.title || '尚未填写'}</strong><p>{goal.data?.detail}</p>{project.myRole === 'owner' ? <Link to={supplement(`/app/projects/${encodeURIComponent(projectId)}/settings`)}>补齐项目主目标</Link> : <span>需要项目负责人维护主目标。</span>}</div>
          {currentStandard ? <p>生效标准：{currentStandard.title} · v{currentStandard.version}</p> : <div className="notice notice-warn">先保存项目标准，再开始成果检查。{project.myRole === 'owner' ? <Link to={supplement(`/app/projects/${encodeURIComponent(projectId)}/assessment?section=standards`)}>补齐项目标准</Link> : <span>需要负责人或拥有标准管理权限的成员补齐。</span>}</div>}
          {!materialVersions.length && <p className="form-note">成果检查需要可核对的成果版本。{projectPermission(project, 'resourceManage') ? <Link to={supplement(`/app/projects/${encodeURIComponent(projectId)}/data?resourceType=material`)}>上传或编写成果后返回</Link> : <span>请联系负责人补齐成果；也可在下方选择已有成果版本。</span>}</p>}
          <ReferencePicker projectId={projectId} sourceVersionIds={sourceVersions} materialVersionIds={materialVersions} onChange={selection => { setSourceVersions(selection.sourceVersionIds); setMaterialVersions(selection.materialVersionIds); }} disabled={create.isPending} />
          {create.error && <ErrorNotice error={create.error} />}
          <button className="button button-primary" disabled={!canInitiate || !aiEnabled || !goal.data?.title.trim() || !currentStandard || create.isPending}><Play size={16} />{create.isPending ? '正在创建本轮评分' : kind === 'rehearsal' ? '开始本轮答辩演练' : '开始本轮材料检查'}</button>
        </form>}
      </SectionCard>
      <SectionCard title="独立评分记录" detail="每一轮保留自己的依据和结果。历史演练文字反馈也在此查看。">
        {history.isLoading && <Spinner label="读取评分历史" />}{history.error && <ErrorNotice error={history.error} onRetry={() => void history.refetch()} />}
        <VirtualList label="评分历史" className="assessment-history" items={rows} getKey={row => row.assessmentId} renderItem={row => <button className={`assessment-history-row ${selectedId === row.assessmentId ? 'active' : ''}`} key={row.assessmentId} onClick={() => select(row.assessmentId)}><strong>{row.historical ? '历史记录' : kind === 'rehearsal' ? '答辩演练' : '材料检查'} · {new Date(row.createdAt).toLocaleString('zh-CN')}</strong><small>{row.status}{row.historical ? ' · 原有反馈' : ` · 标准 v${row.standardsVersion ?? '—'}`}</small></button>} />
        <LoadMore query={history} label="评分记录" />
        {!history.isLoading && !history.error && !rows.length && <EmptyState title="尚无此形式的评分记录" detail="完成一轮检查或演练后，反馈会独立保存。" />}
    {(assessment && !assessment.historical && projectPermission(project,'scoreCorrect') && ['succeeded','failed'].includes(assessment.status)) && <ManualAssessmentEditor key={selectedId || 'new'} projectId={projectId} standard={currentStandard ?? undefined} assessment={assessment} goalRevision={goal.data?.revision} materialVersionIds={materialVersions} onSaved={async result => { select(result.assessmentId); await client.invalidateQueries({ queryKey: ['assessments', projectId] }); await client.invalidateQueries({ queryKey: ['assessment', projectId] }); }} />}
      </SectionCard>
    </div>

    {activePending && <div className="notice"><strong>本轮评分任务：{job.job ? jobStatusLabel(job.job.status) : '正在读取'}</strong>{canRetry && <><p>评分未完成，服务端失败状态与已有证据已保留。</p><button className="button button-quiet" disabled={retry.isPending || !aiEnabled || !canRetry} onClick={() => retry.mutate()}>重试本轮任务</button></>}{job.job?.status === 'failed' && <ErrorNotice error={job.job.error ?? new Error('评分任务失败。')} />}{Boolean(job.error) && <ErrorNotice error={job.error} />}{retry.error && <ErrorNotice error={retry.error} />}</div>}
    {selectedId && <SectionCard aiReference title="本轮评分与证据" detail="总分由服务端按本轮固定权重计算；证据不足时显示反馈与无法评分的原因。" action={<button className="button button-quiet button-small" onClick={() => void selected.refetch()}><RefreshCw size={14} />刷新结果</button>}>
      {selected.isLoading && <Spinner label="读取本轮评分" />}{selected.error && <ErrorNotice error={selected.error} onRetry={() => void selected.refetch()} />}
      {assessment && <><div className="callout">{assessment.historical ? <strong>历史反馈：本记录未绑定新版主目标与统一标准，不补造新版评分。</strong> : <><strong>{assessment.goal?.title} <AiReferenceBadge ariaHidden /></strong><p>{assessment.goal?.detail} <AiReferenceBadge /></p><small>目标 r{assessment.goalRevision} · 标准 v{assessment.standardsVersion} · 固定文档版本 {assessment.materialVersionIds.join('、')}</small></>}</div>
        {assessment.jobError && <p className="notice notice-warn">{assessment.status === 'succeeded' ? '本轮评分已保存；原作业曾失败，此历史提示不影响已保存评分。' : assessment.jobError}</p>}
        {assessment.rehearsalId && <RehearsalsPage key={assessment.rehearsalId} embedded rehearsalId={assessment.rehearsalId} />}
        {isScoringReport(assessment.report) ? <AssessmentReportView report={assessment.report} /> : assessment.report ? <div className="assessment-historical-feedback"><h3>历史文字反馈 <AiReferenceBadge ariaHidden /></h3><pre>{JSON.stringify(assessment.report, null, 2)}</pre></div> : <p className="muted">{assessment.historical ? '原有文字反馈保留在问答记录中。' : assessment.kind === 'rehearsal' ? '完成真实回答并结束本轮演练后，将依据冻结问答生成评分。' : '本轮评分尚未返回结果。'}</p>}
      </>}
    </SectionCard>}
  </div>;
}
function Evidence({ items }: { items: AssessmentEvidence[] }) { return <>{items.map((evidence, index) => <blockquote className="quote-box" key={index}><small>{evidence.type === 'answer' ? `真实回答 · 第 ${evidence.turnSequence} 回合` : `固定文档版本 ${evidence.materialVersionId}`}</small><p>{evidence.quote} <AiReferenceBadge /></p></blockquote>)}</>; }
export function AssessmentReportView({ report }: { report: AssessmentReport }) {
  return <div className="stack assessment-report"><RemovedSourceNotice payload={report} /><h3>{report.status === 'scored' && report.weightedTotal !== null ? `本轮总分：${report.weightedTotal}` : '本轮无法进行数值评分'} <AiReferenceBadge ariaHidden /></h3><p>{report.summary} <AiReferenceBadge /></p>{report.scores.map(score => <article className="standard-read-row" key={score.key}><strong>{score.label}：{score.score === null ? '未评分' : score.score} <AiReferenceBadge ariaHidden /></strong><p>{score.comment} <AiReferenceBadge /></p><Evidence items={score.evidence} /></article>)}{report.requirementChecks.length > 0 && <section><h4>要求检查 <AiReferenceBadge ariaHidden /></h4>{report.requirementChecks.map(check => <article key={check.requirementId}><StatusPill tone={check.status === 'met' ? 'good' : 'warn'}>{check.status === 'met' ? '已满足' : check.status === 'unmet' ? '未满足' : '证据待核验'}</StatusPill><p>{check.comment} <AiReferenceBadge /></p><Evidence items={check.evidence} /></article>)}</section>}{report.limitations.length > 0 && <div className="notice notice-warn"><strong>限制与待核验 <AiReferenceBadge ariaHidden /></strong><ul>{report.limitations.map((limitation, index) => <li key={index}>{limitation} <AiReferenceBadge /></li>)}</ul></div>}</div>;
}
