import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { projectRequest, type Assessment, type AssessmentReport } from '../api/simplification';
import { assertPage } from '../api/page-contract';
import { useSession } from '../auth';
import { ErrorNotice, SectionCard, Spinner, StatusPill } from '../components/ui';
import { completeIntent, idempotencyKeyForIntent } from './aiWorkflowSupport';
import { JobAiActivity } from './JobAiActivity';
import { AiReferenceBadge } from '../components/AiReferenceBadge';
import './AssessmentFollowups.css';

export type AssessmentFollowup = {
  followupId: string; assessmentId: string; userId: string; message: string; baseRevision: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'conflict' | 'cancelled' | 'waiting_input';
  jobId: string; baseReport: AssessmentReport; proposedReport: AssessmentReport | null;
  publishedReport: AssessmentReport | null; publishedRevision: number | null;
  error: string | null; createdAt: string; updatedAt: string;
};
type FollowupPage = { items: AssessmentFollowup[]; nextCursor: string | null };
const labels: Record<AssessmentFollowup['status'], string> = { queued: '等待处理', running: '正在复核', succeeded: '复核完成', failed: '复核未完成', conflict: '评分已变化，保留建议', cancelled: '已取消', waiting_input: '等待继续' };
const active = new Set(['queued', 'running', 'waiting_input']);
function ScoreChanges({ turn }: { turn: AssessmentFollowup }) {
  const report = turn.publishedReport ?? turn.proposedReport;
  if (!report) return null;
  return <div className="assessment-followup-result">
    <strong>{turn.publishedReport ? '本次复核结果' : '尚未写入当前评分的建议'}</strong>
    <p>{report.summary} <AiReferenceBadge /></p>
    <p>总分：{turn.baseReport.weightedTotal ?? '未评分'} → {report.weightedTotal ?? '未评分'} <AiReferenceBadge /></p>
    {report.scores.map(score => {
      const before = turn.baseReport.scores.find(item => item.key === score.key);
      return <article key={score.key}><strong>{score.label}：{before?.score ?? '未评分'} → {score.score ?? '未评分'} <AiReferenceBadge /></strong><p>{score.comment} <AiReferenceBadge /></p></article>;
    })}
    {turn.proposedReport && turn.publishedReport && JSON.stringify(turn.proposedReport.scores) !== JSON.stringify(turn.publishedReport.scores) && <details><summary>查看 AI 建议与保留的人工评分</summary><p>已有人工评分保留，以下为 AI 建议。</p>{turn.proposedReport.scores.map(score => <p key={score.key}>{score.label}：{score.score ?? '未评分'} · {score.comment} <AiReferenceBadge /></p>)}</details>}
    {report.limitations.length > 0 && <ul>{report.limitations.map((item, index) => <li key={index}>{item} <AiReferenceBadge /></li>)}</ul>}
  </div>;
}
export function AssessmentFollowups({ projectId, assessment, canCorrect, aiEnabled, onChanged }: {
  projectId: string; assessment: Assessment; canCorrect: boolean; aiEnabled: boolean; onChanged: () => void | Promise<void>;
}) {
  const session = useSession();
  const client = useQueryClient();
  const draftKey = 'ai-office:assessment-followup-draft:' + (session.data?.id ?? '') + ':' + projectId + ':' + assessment.assessmentId;
  const [message, setMessage] = useState(() => { try { return sessionStorage.getItem(draftKey) ?? ''; } catch { return ''; } });
  useEffect(() => { try { if (message) sessionStorage.setItem(draftKey, message); else sessionStorage.removeItem(draftKey); } catch { /* The in-memory draft remains usable. */ } }, [draftKey, message]);
  const [submittedJob, setSubmittedJob] = useState<string | null>(null);
  const [submittedActive, setSubmittedActive] = useState(false);
  const lock = useRef(false);
  const key = ['assessment-followups', session.data?.id ?? '', projectId, assessment.assessmentId];
  const path = '/assessments/' + encodeURIComponent(assessment.assessmentId) + '/followups';
  const history = useInfiniteQuery({
    queryKey: key, initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const response = await projectRequest<FollowupPage>(projectId, path, { query: { limit: 20, cursor: pageParam }, signal, networkOnly: true });
      const page = assertPage<AssessmentFollowup>(response, { missingItems: () => new Error('追问记录分页无效，请刷新重试。') });
      if (page.nextCursor && page.nextCursor === pageParam) throw new Error('追问记录分页无效，请刷新重试。');
      return page;
    },
    getNextPageParam: page => page.nextCursor || undefined,
    refetchInterval: query => query.state.data?.pages.some(page => page.items.some(turn => active.has(turn.status))) ? 4000 : false,
    refetchIntervalInBackground: false,
  });
  const turns = useMemo(() => {
    const items = new Map<string, AssessmentFollowup>();
    for (const page of history.data?.pages ?? []) for (const turn of page.items) if (!items.has(turn.followupId)) items.set(turn.followupId, turn);
    return [...items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.followupId.localeCompare(b.followupId));
  }, [history.data]);
  const latest = turns.at(-1);
  const refresh = async () => { await client.invalidateQueries({ queryKey: key }); await onChanged(); };
  const busy = submittedActive || Boolean(latest && active.has(latest.status));
  const permitted = canCorrect && Boolean(assessment.revision && assessment.revision > 0);
  const submit = useMutation({
    mutationFn: async () => {
      if (!permitted || !aiEnabled || busy) throw new Error('当前不能发起评分复核。');
      const body = { message: message.trim(), expectedRevision: assessment.revision! };
      const namespace = 'assessment-followup:' + (session.data?.id ?? '') + ':' + projectId + ':' + assessment.assessmentId;
      const idempotencyKey = await idempotencyKeyForIntent(namespace, body);
      const result = await projectRequest<{ followupId: string; jobId: string }>(projectId, path, { method: 'POST', body, idempotencyKey, networkOnly: true });
      completeIntent(namespace);
      return result;
    },
    onSuccess: async result => { setMessage(''); setSubmittedJob(result.jobId); setSubmittedActive(true); await refresh(); },
  });
  const jobId = submittedActive ? submittedJob : latest?.jobId ?? submittedJob;
  return <SectionCard title="追加对话与评分复核" detail="可以询问评分依据、指出固定材料中的遗漏，或请求重新核对。处理期间保留当前评分。">
    <p className="form-note">追问中的新事实不能直接作为评分证据；复核只使用本轮固定成果与标准。人工修正的分数会保留。</p>
    {history.isLoading && <Spinner label="读取追问记录" />}
    {history.error && <ErrorNotice error={history.error} onRetry={() => void history.refetch()} />}
    {history.hasNextPage && <button className="button button-quiet button-small" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? '正在读取更早记录' : '加载更早的追问'}</button>}
    <ol className="assessment-followup-thread" aria-label="评分追问记录">
      {turns.map(turn => <li key={turn.followupId}>
        <div className="assessment-followup-heading"><strong>项目成员的追问</strong><time dateTime={turn.createdAt}>{new Date(turn.createdAt).toLocaleString('zh-CN')}</time></div>
        <p className="assessment-followup-message">{turn.message}</p>
        <StatusPill tone={turn.status === 'succeeded' ? 'good' : 'warn'}>{labels[turn.status]}</StatusPill>
        <small>基于评分 r{turn.baseRevision}{turn.publishedRevision ? ' · 发布为 r' + turn.publishedRevision : ''}</small>
        {turn.status === 'conflict' && <p className="notice notice-warn">当前评分已被更新，本次建议未覆盖新版本。请刷新当前评分，确认后再发起复核。</p>}
        {turn.error && <p className="notice notice-warn">{turn.error}</p>}
        <ScoreChanges turn={turn} />
      </li>)}
    </ol>
    {!history.isLoading && !history.error && !turns.length && <p className="muted">尚无追问记录。</p>}
    {jobId && <JobAiActivity projectId={projectId} jobId={jobId} canResume={permitted && aiEnabled && (submittedActive || latest?.userId === session.data?.id)} onSettled={() => { setSubmittedActive(false); void refresh(); }} onResumed={id => { setSubmittedJob(id); setSubmittedActive(true); void refresh(); }} />}
    {permitted ? <form className="stack" onSubmit={async event => {
      event.preventDefault(); if (lock.current || submit.isPending || !message.trim()) return;
      lock.current = true;
      try { await submit.mutateAsync(); } catch { /* ErrorNotice preserves the draft and explains the server refusal. */ }
      finally { lock.current = false; }
    }}>
      <label className="field"><span>对本轮评分的追问</span><textarea rows={4} maxLength={8000} value={message} disabled={submit.isPending} onChange={event => setMessage(event.target.value)} placeholder="例如：请核对成果中第二节的调查样本是否已计入这一维度。" /></label>
      {submit.error && <><ErrorNotice error={submit.error} /><button type="button" className="button button-quiet button-small" onClick={() => void refresh()}>刷新当前评分与记录</button></>}
      {!aiEnabled && <p className="notice notice-warn">AI 当前不可用，已有评分和追问记录仍可查看。</p>}
      <button className="button button-primary" disabled={!aiEnabled || busy || history.isLoading || Boolean(history.error) || submit.isPending || !message.trim()}>{submit.isPending ? '正在提交追问' : busy ? '正在处理上一条追问' : '发送追问并复核'}</button>
    </form> : <p className="form-note">{'你可以查看追问记录；发送复核需要历史评分修正权限。'}</p>}
  </SectionCard>;
}
