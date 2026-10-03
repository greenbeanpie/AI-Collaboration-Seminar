import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { collaborationApi, type TaskSubmission } from '../api/collaboration';
import { ErrorNotice, Field } from '../components/ui';
import { projectRequest, type StandardVersion } from '../api/simplification';

export function AssistiveRubricScores({ projectId, submission, owner, onChanged }: { projectId: string; submission: TaskSubmission; owner: boolean; onChanged: () => Promise<void> }) {
  const scoring = submission.aiReport?.rubricScoring;
  if (!scoring) return null;
  if (scoring.status === 'unavailable') return <p className="form-note">辅助评分不可用：{scoring.reason}</p>;
  return <section className="callout stack">
    <strong>成果辅助评分 · 标准版本 {scoring.rubricVersion}</strong>

    <p>AI 辅助总分：{scoring.weightedTotal.toFixed(2)} / 100</p>
    <ul>{scoring.scores.map(score => <li key={score.key}>
      <strong>{scoring.weights.find(weight => weight.key === score.key)?.label ?? score.key}：{score.score} / 100</strong>
      <small> · 权重 {scoring.weights.find(weight => weight.key === score.key)?.weight} · 置信度 {Math.round(score.confidence * 100)}%</small>
      <p className="collab-preserve">{score.comment}</p>
      <details><summary>本项原文依据</summary>{score.evidence.map((evidence, index) => <div key={index}><small>固定材料版本 {evidence.materialVersionId}</small><p className="collab-preserve">{evidence.quote}</p></div>)}</details>
    </li>)}</ul>
    {submission.humanScoreOverride && <div className="notice notice-info"><div>
      <strong>负责人复核辅助总分：{submission.humanScoreOverride.weightedTotal.toFixed(2)} / 100</strong>
      <ul>{submission.humanScoreOverride.scores.map(score => <li key={score.key}>{scoring.weights.find(weight => weight.key === score.key)?.label ?? score.key}：{score.score}</li>)}</ul>
      <p className="collab-preserve">复核理由：{submission.humanScoreOverride.reason}</p>
      <small>原 AI 分数与证据仍保留</small>
    </div></div>}
    {owner && <ScoreOverrideForm key={submission.submissionId} projectId={projectId} submission={submission} onChanged={onChanged} />}
  </section>;
}

function ScoreOverrideForm({ projectId, submission, onChanged }: { projectId: string; submission: TaskSubmission; onChanged: () => Promise<void> }) {
  const scoring = submission.aiReport!.rubricScoring!;
  const current = useQuery({ queryKey: ['current-standard', projectId], queryFn: () => projectRequest<{ standard: StandardVersion | null }>(projectId, '/standards/current') });
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [conflicted, setConflicted] = useState(false);
  const [baseRevision, setBaseRevision] = useState(submission.revision);
  const outdated = conflicted || baseRevision !== submission.revision;
  const [scores, setScores] = useState(() => scoring.status === 'scored' ? scoring.scores.map(score => ({ key: score.key, score: String(submission.humanScoreOverride?.scores.find(item => item.key === score.key)?.score ?? score.score) })) : []);
  const save = useMutation({
    mutationFn: () => collaborationApi.overrideScores(projectId, { ...submission, revision: baseRevision }, scores.map(score => ({ key: score.key, score: Number(score.score) })), reason.trim()),
    onSuccess: async updated => { setBaseRevision(updated.revision); setReason(''); setOpen(false); await onChanged(); },
    onError: async error => { if (error instanceof ApiError && error.status === 409) setConflicted(true); await onChanged(); },
  });
  if (scoring.status !== 'scored') return null;
  if (current.isPending) return <p role="status">正在核对生效标准</p>;
  if (current.error) return <ErrorNotice error={current.error} onRetry={() => void current.refetch()} />;
  if (!current.data?.standard || current.data.standard.standardsVersionId !== scoring.standardsVersionId) return <p className="notice notice-warn">本轮评分依据的标准已失效，保留为历史记录。请按生效标准重新提交成果。</p>;
  const valid = reason.trim() && scores.every(score => score.score.trim() && Number.isFinite(Number(score.score)) && Number(score.score) >= 0 && Number(score.score) <= 100);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>负责人复核或调整辅助分数</summary>
    <form className="stack" onSubmit={event => { event.preventDefault(); if (valid && !outdated) save.mutate(); }}>
      {scores.map((score, index) => <Field key={score.key} label={`复核${scoring.weights.find(weight => weight.key === score.key)?.label ?? score.key}分数`}><input className="input" type="number" min="0" max="100" step="0.01" required value={score.score} disabled={save.isPending || outdated} onChange={event => setScores(items => items.map((item, itemIndex) => itemIndex === index ? { ...item, score: event.target.value } : item))} /></Field>)}
      <Field label="辅助分数复核理由"><textarea className="input" required maxLength={2000} rows={3} value={reason} disabled={save.isPending || outdated} onChange={event => setReason(event.target.value)} placeholder="说明核对依据与调整原因" /></Field>
      {outdated && <p className="notice notice-warn">评分记录已变化，请读取最新记录并重新核对后再提交</p>}
      {outdated && <button type="button" className="button button-quiet" onClick={() => { setBaseRevision(submission.revision); setConflicted(false); setReason(''); setScores(scoring.scores.map(score => ({ key: score.key, score: String(submission.humanScoreOverride?.scores.find(item => item.key === score.key)?.score ?? score.score) }))); save.reset(); }}>重新核对最新辅助评分</button>}
      {save.error && <ErrorNotice error={save.error} />}
      <button className="button button-primary" disabled={!valid || outdated || save.isPending}>{save.isPending ? '记录中…' : '保存辅助分数复核'}</button>
    </form>
  </details>;
}
