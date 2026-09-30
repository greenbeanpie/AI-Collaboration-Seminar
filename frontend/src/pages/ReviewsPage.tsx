import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, RefreshCw, ShieldAlert } from 'lucide-react';
import { api, projectPath } from '../api/client';
import { useCapabilities } from '../auth';
import { useProject } from '../components/ProjectShell';
import { EmptyState, ErrorNotice, Field, PageHeading, SectionCard, Spinner, StatusPill } from '../components/ui';
import type { DataOf } from '../api/types';
import { clearPendingJob, completeIntent, formatWorkflowDate, idempotencyKeyForIntent, isRecord, jobStatusLabel, readPendingJob, retryBackendJob, useVisibleJobPoller, writePendingJob } from './aiWorkflowSupport';

type ReviewItem = DataOf<'ReviewListResponse'>['items'][number];
type MaterialItem = DataOf<'MaterialListResponse'>['items'][number];
type PendingReviewJob = { jobId: string; entityId: string; action: string };
const pendingJobKey = (projectId: string) => `ai-office:pending-review-job:${projectId}`;

export function ReviewsPage() {
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const requirementQuery = useQuery({ queryKey: ['requirementSets', projectId], queryFn: () => api.get<'RequirementSetListResponse'>(projectPath(projectId, '/requirement-sets'), { limit: 100 }) });
  const rubricQuery = useQuery({ queryKey: ['rubrics', projectId], queryFn: () => api.get<'RubricListResponse'>(projectPath(projectId, '/rubrics')) });
  const materialQuery = useQuery({ queryKey: ['materials', projectId], queryFn: () => api.get<'MaterialListResponse'>(projectPath(projectId, '/materials'), { limit: 100 }) });
  const reviewListQuery = useQuery({ queryKey: ['reviews', projectId], queryFn: () => api.get<'ReviewListResponse'>(projectPath(projectId, '/reviews')) });
  const materials = materialQuery.data?.items ?? [];
  const confirmedRequirementSets = (requirementQuery.data?.items ?? []).filter((set) => set.status === 'confirmed');
  const confirmedRubrics = (rubricQuery.data?.items ?? []).filter((rubric) => rubric.status === 'confirmed');
  const materialVersionQueries = useQueries({ queries: materials.map((material) => ({
    queryKey: ['materialVersions', projectId, material.materialId],
    queryFn: () => api.get<'MaterialVersionListResponse'>(projectPath(projectId, `/materials/${encodeURIComponent(material.materialId)}/versions`), { limit: 100 }),
    staleTime: 15_000,
  })) });

  const [requirementSetId, setRequirementSetId] = useState('');
  const [rubricVersionId, setRubricVersionId] = useState('');
  const [selectedMaterialVersionIds, setSelectedMaterialVersionIds] = useState<string[]>([]);
  const [initializedMaterialSelection, setInitializedMaterialSelection] = useState(false);
  const [selectedReviewId, setSelectedReviewId] = useState('');
  const [createError, setCreateError] = useState<unknown>(null);
  const [retryError, setRetryError] = useState<unknown>(null);
  const [retryingJob, setRetryingJob] = useState(false);
  const [pendingReviewJob, setPendingReviewJob] = useState<PendingReviewJob | null>(() => readPendingJob<PendingReviewJob>(pendingJobKey(projectId)));
  const [creating, setCreating] = useState(false);
  const job = useVisibleJobPoller(pendingReviewJob?.jobId ?? null);
  const selectedReviewQuery = useQuery({
    queryKey: ['review', projectId, selectedReviewId],
    queryFn: () => api.get<'ReviewResponse'>(projectPath(projectId, `/reviews/${encodeURIComponent(selectedReviewId)}`)),
    enabled: Boolean(selectedReviewId),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const review = selectedReviewQuery.data;
  const reviews = reviewListQuery.data?.items ?? [];
  const aiEnabled = capabilities.data?.features.aiEnabled === true;
  const hasPendingReviewJob = Boolean(pendingReviewJob && !job.isSettled);
  const currentMaterialVersions = useMemo(() => materials.flatMap((material) => material.currentVersionId ? [{
    versionId: material.currentVersionId,
    materialId: material.materialId,
    title: material.title,
    revision: material.revision,
  }] : []), [materials]);
  const historyState = useMemo(() => {
    const byVersionId = new Map<string, MaterialItem>();
    const errors: unknown[] = [];
    materialVersionQueries.forEach((query, index) => {
      const material = materials[index];
      if (query.error) errors.push(query.error);
      if (material && query.data) query.data.items.forEach((version) => byVersionId.set(version.versionId, material));
    });
    return { byVersionId, errors, loaded: materialVersionQueries.every((query) => Boolean(query.data)) };
  }, [materialVersionQueries, materials]);

  useEffect(() => {
    if (!requirementSetId && confirmedRequirementSets.length > 0) setRequirementSetId(confirmedRequirementSets[0]?.requirementSetId ?? '');
  }, [confirmedRequirementSets, requirementSetId]);
  useEffect(() => {
    if (!rubricVersionId && confirmedRubrics.length > 0) setRubricVersionId(confirmedRubrics[0]?.rubricId ?? '');
  }, [confirmedRubrics, rubricVersionId]);
  useEffect(() => {
    if (materialQuery.data && !initializedMaterialSelection) {
      setSelectedMaterialVersionIds(currentMaterialVersions.slice(0, 10).map((version) => version.versionId));
      setInitializedMaterialSelection(true);
    }
  }, [currentMaterialVersions, initializedMaterialSelection, materialQuery.data]);
  useEffect(() => {
    if (!selectedReviewId && reviews.length > 0) setSelectedReviewId(reviews[0]?.reviewId ?? '');
  }, [reviews, selectedReviewId]);
  useEffect(() => {
    if (!job.job || !job.isSettled || !pendingReviewJob || job.job.jobId !== pendingReviewJob.jobId) return;
    if (job.job.status === 'failed' || job.job.status === 'waiting_input') return;
    const clear = () => {
      clearPendingJob(pendingJobKey(projectId), pendingReviewJob.jobId);
      setPendingReviewJob((current) => current?.jobId === pendingReviewJob.jobId ? null : current);
    };
    if (job.job.status === 'succeeded') {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['reviews', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['review', projectId, pendingReviewJob.entityId] }),
      ]).then(clear, clear);
    } else {
      clear();
    }
  }, [job.job?.jobId, job.job?.status, job.isSettled, pendingReviewJob, projectId, queryClient]);

  const freshness = (materialVersionIds: string[]) => {
    let stale = false;
    let unknown = !historyState.loaded || historyState.errors.length > 0;
    for (const versionId of materialVersionIds) {
      const material = historyState.byVersionId.get(versionId);
      if (!material) { unknown = true; continue; }
      if (material.currentVersionId !== versionId) stale = true;
    }
    return stale ? 'stale' : unknown ? 'unknown' : 'current';
  };

  const handleStartReview = async (event: FormEvent) => {
    event.preventDefault();
    if (!aiEnabled || creating || hasPendingReviewJob || !requirementSetId || !rubricVersionId || selectedMaterialVersionIds.length === 0) return;
    setCreating(true);
    setCreateError(null);
    const body = { rubricVersionId, requirementSetId, materialVersionIds: [...selectedMaterialVersionIds].sort() };
    const namespace = `review-create:${projectId}`;
    try {
      const key = await idempotencyKeyForIntent(namespace, body);
      const result = await api.post<'ReviewCreateResponse'>(projectPath(projectId, '/reviews'), body, { idempotencyKey: key });
      completeIntent(namespace);
      setSelectedReviewId(result.reviewId);
      const pending = { jobId: result.jobId, entityId: result.reviewId, action: 'create' };
      writePendingJob(pendingJobKey(projectId), pending);
      setPendingReviewJob(pending);
      void queryClient.invalidateQueries({ queryKey: ['reviews', projectId] });
    } catch (error) {
      setCreateError(error);
    } finally {
      setCreating(false);
    }
  };

  const handleRetryJob = async () => {
    if (!aiEnabled || !pendingReviewJob || job.job?.status !== 'failed' || retryingJob) return;
    setRetryingJob(true);
    setRetryError(null);
    try {
      const nextJobId = await retryBackendJob(projectId, pendingReviewJob.jobId);
      const pending = { ...pendingReviewJob, jobId: nextJobId };
      writePendingJob(pendingJobKey(projectId), pending);
      setPendingReviewJob(pending);
    } catch (error) {
      setRetryError(error);
    } finally {
      setRetryingJob(false);
    }
  };

  const selectMaterialVersion = (versionId: string) => {
    setSelectedMaterialVersionIds((current) => current.includes(versionId)
      ? current.filter((id) => id !== versionId)
      : current.length < 10 ? [...current, versionId] : current);
  };
  const inputLoading = requirementQuery.isLoading || rubricQuery.isLoading || materialQuery.isLoading;

  return <div className="page-stack ai-workflow-layout">
    <PageHeading eyebrow="复核 / 预审" title="按已确认的标准检查材料" detail="每份报告会保留使用的要求集、评分标准和材料版本 ID。AI 预审意见供团队内部讨论，不构成官方评审结论。" />
    {!capabilities.data && (capabilities.isLoading ? <div className="ai-workflow-note">正在读取后端 AI 能力，状态确认前不会开始预审。</div> : capabilities.error ? <ErrorNotice error={capabilities.error} onRetry={() => void capabilities.refetch()} /> : null)}
    {capabilities.data && !aiEnabled && <div className="ai-workflow-note is-warning"><strong>后端 AI 当前未启用。</strong> 新预审不会生成模拟报告；已有后端报告仍可查看。</div>}

    <div className="ai-workflow-grid">
      <SectionCard title="发起新预审" detail="只使用负责人已确认的要求集和评分标准，并绑定当前材料版本。">
        {inputLoading ? <Spinner label="正在读取确认标准和材料" /> : <form className="ai-workflow-form-grid" onSubmit={(event) => void handleStartReview(event)}>
          <Field label="已确认要求集">
            <select className="ai-workflow-select" value={requirementSetId} onChange={(event) => setRequirementSetId(event.target.value)}>
              <option value="">选择已确认要求集</option>
              {confirmedRequirementSets.map((set) => <option key={set.requirementSetId} value={set.requirementSetId}>要求集 · {formatWorkflowDate(set.confirmedAt ?? '')} · {set.requirements.length} 条</option>)}
            </select>
          </Field>
          <Field label="已确认评分标准">
            <select className="ai-workflow-select" value={rubricVersionId} onChange={(event) => setRubricVersionId(event.target.value)}>
              <option value="">选择已确认评分标准</option>
              {confirmedRubrics.map((rubric) => <option key={rubric.rubricId} value={rubric.rubricId}>{rubric.source === 'official' ? '官方模板' : '自拟'} · v{rubric.version} · {rubric.weights.length} 个评分项</option>)}
            </select>
          </Field>
          <div className="ai-workflow-field ai-workflow-field-wide">
            <div className="field-label">当前材料版本 <small>至少选择 1 个，最多 10 个。报告会固定这些版本 ID。</small></div>
            {materialQuery.error && <ErrorNotice error={materialQuery.error} onRetry={() => void materialQuery.refetch()} />}
            {historyState.errors.map((error, index) => <ErrorNotice key={index} error={error} />)}
            <div className="ai-workflow-choice-list">
              {currentMaterialVersions.length === 0 ? <EmptyState title="没有当前材料版本" detail="先保存至少一份材料的正式版本。" /> : currentMaterialVersions.map((version) => {
                const selected = selectedMaterialVersionIds.includes(version.versionId);
                return <label className="ai-workflow-choice" key={version.versionId}>
                  <input type="checkbox" checked={selected} disabled={!selected && selectedMaterialVersionIds.length >= 10} onChange={() => selectMaterialVersion(version.versionId)} />
                  <span className="ai-workflow-choice-copy"><strong>{version.title} · 当前 v{version.revision}</strong><small>材料版本 ID {version.versionId}</small></span>
                </label>;
              })}
            </div>
          </div>
          {Boolean(createError) && <div className="ai-workflow-field ai-workflow-field-wide"><ErrorNotice error={createError} /></div>}
          {pendingReviewJob && <div className="ai-workflow-field ai-workflow-field-wide"><JobPanel jobId={pendingReviewJob.jobId} job={job.job} error={job.error} retryError={retryError} loading={job.loading} retrying={retryingJob} canRetry={aiEnabled && !capabilities.isLoading && !capabilities.error} onRetry={() => void handleRetryJob()} /></div>}
          <div className="ai-workflow-actions ai-workflow-field-wide">
            <button className="button button-primary" type="submit" disabled={!aiEnabled || capabilities.isLoading || Boolean(capabilities.error) || creating || hasPendingReviewJob || !requirementSetId || !rubricVersionId || selectedMaterialVersionIds.length === 0}><Play size={15} />{creating ? '正在创建预审' : hasPendingReviewJob ? '预审任务处理中' : '发起真实预审'}</button>
            {confirmedRequirementSets.length === 0 && <span className="muted">没有已确认要求集</span>}
            {confirmedRubrics.length === 0 && <span className="muted">没有已确认评分标准</span>}
          </div>
        </form>}
        {(requirementQuery.error || rubricQuery.error || materialQuery.error) && <div className="stack">{requirementQuery.error && <ErrorNotice error={requirementQuery.error} onRetry={() => void requirementQuery.refetch()} />}{rubricQuery.error && <ErrorNotice error={rubricQuery.error} onRetry={() => void rubricQuery.refetch()} />}{materialQuery.error && <ErrorNotice error={materialQuery.error} onRetry={() => void materialQuery.refetch()} />}</div>}
      </SectionCard>

      <SectionCard title="预审历史" detail="报告均由后端读取；版本变化时标记报告是否已过期。">
        {reviewListQuery.isLoading ? <Spinner label="正在读取预审记录" /> : reviewListQuery.error ? <ErrorNotice error={reviewListQuery.error} onRetry={() => void reviewListQuery.refetch()} /> : reviews.length === 0 ? <EmptyState title="还没有预审报告" detail="选择确认标准和材料版本后发起第一份预审。" /> : <div className="ai-workflow-report-list">
          {reviews.map((item) => {
            const state = freshness(item.materialVersionIds);
            return <button className="ai-workflow-report-button" key={item.reviewId} aria-current={selectedReviewId === item.reviewId} onClick={() => setSelectedReviewId(item.reviewId)}>
              <strong>预审 · {formatWorkflowDate(item.createdAt)}</strong>
              <small>{reviewStatusLabel(item.status)} · {item.materialVersionIds.length} 个材料版本</small>
              <FreshnessStatus state={state} />
              <small className="mono">报告 ID {item.reviewId}</small>
            </button>;
          })}
        </div>}
      </SectionCard>
    </div>

    {selectedReviewId && <SectionCard title="报告详情" detail="分数、问题和建议都来自所选预审记录。">
      {selectedReviewQuery.isLoading ? <Spinner label="正在读取预审报告" /> : selectedReviewQuery.error ? <ErrorNotice error={selectedReviewQuery.error} onRetry={() => void selectedReviewQuery.refetch()} /> : review ? <>
        <div className="ai-workflow-meta"><StatusPill tone={review.status === 'succeeded' ? 'good' : review.status === 'failed' ? 'bad' : 'blue'}>{reviewStatusLabel(review.status)}</StatusPill><span>创建于 {formatWorkflowDate(review.createdAt)}</span><span>评分版本 {review.rubricVersionId}</span><span>要求集 {review.requirementSetId}</span></div>
        <div className="ai-workflow-meta"><ShieldAlert size={15} /><span>绑定材料版本：{review.materialVersionIds.join(' · ')}</span><FreshnessStatus state={freshness(review.materialVersionIds)} /></div>
        {pendingReviewJob?.entityId === selectedReviewId && <JobPanel jobId={pendingReviewJob.jobId} job={job.job} error={job.error} retryError={retryError} loading={job.loading} retrying={retryingJob} canRetry={aiEnabled && !capabilities.isLoading && !capabilities.error} onRetry={() => void handleRetryJob()} />}
        {review.status === 'succeeded' ? <ReportView report={review.report} /> : review.status === 'failed' ? <div className="ai-workflow-note is-error">后端预审执行失败。报告未生成，请查看任务状态或发起新的预审。</div> : <div className="ai-workflow-note">后端仍在生成此报告。可刷新报告读取最新服务端状态。</div>}
      </> : null}
    </SectionCard>}

    {historyState.loaded && materials.some((material) => materialVersionQueries[materials.indexOf(material)]?.data?.nextCursor) && <div className="ai-workflow-meta"><span>版本比较使用每份材料最近 100 个版本；超过此范围的旧版本会标记为待确认。</span></div>}
  </div>;
}

function FreshnessStatus({ state }: { state: 'stale' | 'unknown' | 'current' }) {
  if (state === 'stale') return <StatusPill tone="warn">报告针对旧材料版本</StatusPill>;
  if (state === 'unknown') return <StatusPill tone="neutral">版本新旧待确认</StatusPill>;
  return <StatusPill tone="good">材料版本仍为当前版本</StatusPill>;
}

function JobPanel({ jobId, job, error, retryError, loading, retrying, canRetry, onRetry }: { jobId: string; job: DataOf<'JobResponse'> | null; error: unknown; retryError: unknown; loading: boolean; retrying: boolean; canRetry: boolean; onRetry: () => void }) {
  return <div className="ai-workflow-job"><RefreshCw className={job && (job.status === 'queued' || job.status === 'running') ? 'spin' : ''} size={16} /><div><strong>{job ? jobStatusLabel(job.status) : loading ? '正在读取任务' : '等待任务状态'}</strong><p>后端任务 ID {jobId}{job ? ` · 第 ${job.attempts} 次执行` : ''}</p>{Boolean(error) && <p>读取状态暂时失败，页面可见时会继续重试：{error instanceof Error ? error.message : '未知错误'}</p>}{job?.status === 'failed' && <><p>预审任务已失败，报告未生成。</p><button className="button button-quiet button-small" onClick={onRetry} disabled={retrying || !canRetry}><RefreshCw size={13} />{retrying ? '正在重试' : canRetry ? '重试后端任务' : '后端 AI 未启用，暂不可重试'}</button></>}{job?.status === 'waiting_input' && <p>后端任务正在等待补充输入；预审报告尚未完成。</p>}{Boolean(retryError) && <ErrorNotice error={retryError} />}</div></div>;
}

function reviewStatusLabel(status: ReviewItem['status']): string {
  switch (status) {
    case 'pending': return '排队中';
    case 'running': return '生成中';
    case 'succeeded': return '已完成';
    case 'failed': return '执行失败';
  }
}

function ReportView({ report }: { report: unknown }) {
  if (!isRecord(report)) return <EmptyState title="后端尚未返回报告内容" detail="此条记录没有 report 字段，页面不会补造评分或意见。" />;
  const scores = Array.isArray(report.scores) ? report.scores.filter(isRecord) : [];
  const overall = isRecord(report.overall) ? report.overall : null;
  if (scores.length === 0 && !overall) return <pre className="ai-workflow-turn-body">{JSON.stringify(report, null, 2)}</pre>;
  return <div className="ai-workflow-report">
    {overall && <div className="ai-workflow-note"><strong>AI 预审总分：{typeof overall.score === 'number' ? overall.score : '—'}</strong>{typeof overall.summary === 'string' && <span> · {overall.summary}</span>}</div>}
    {scores.length > 0 && <div className="ai-workflow-score-list">{scores.map((score, index) => <div className="ai-workflow-score" key={`${String(score.key ?? index)}-${index}`}>
      <strong>{typeof score.key === 'string' ? score.key : `评分项 ${index + 1}`}</strong>
      <span>{typeof score.score === 'number' ? score.score : '—'}</span>
      {typeof score.comment === 'string' && <p>{score.comment}</p>}
      {Array.isArray(score.suggestions) && score.suggestions.length > 0 && <p>建议：{score.suggestions.filter((item): item is string => typeof item === 'string').join('；')}</p>}
    </div>)}</div>}
    <div className="ai-workflow-meta">如果标准权重不完整，页面仅展示后端返回的定性意见；不会推算或补齐官方评分。</div>
  </div>;
}
