import { AiReferenceBadge } from '../components/AiReferenceBadge';
import { AudioPipelineStatus } from './AudioPipelineStatus';
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, projectPath } from '../api/client';
import { ErrorNotice, StatusPill } from '../components/ui';
import { createIntentKey } from './source-workflows';

const names: Record<string,string> = { pending: '尚未开始', processing: '正在处理', waiting_input: '等待缺页识别', ready: '已完成', failed: '失败，可重试', queued: '已排队', running: '正在生成', cancelled: '已取消' };

export function SourceProcessingCard({ projectId, sourceId, versionId, aiEnabled, active }: { projectId: string; sourceId: string; versionId: string; aiEnabled: boolean; active: boolean }) {
  const path = projectPath(projectId, `/sources/${sourceId}/versions/${versionId}/processing`);
  const [error,setError] = useState<unknown>(null); const [submitting,setSubmitting] = useState(false);
  const action = useRef(false); const intent = useRef<{key:string;revision:number}|null>(null);
  const query = useQuery({ queryKey: ['sourceProcessing',projectId,sourceId,versionId], queryFn: () => api.get<'SourceProcessingResponse'>(path), retry: false,
    refetchInterval: q => active || ['queued','running'].includes(q.state.data?.summaryStatus ?? '') || q.state.data?.textStatus === 'processing' || q.state.data?.requirementsStatus === 'processing' || (q.state.data?.media?.audio?.phase !== 'waiting_config' && ['pending','uploading','processing','generating'].includes(q.state.data?.media?.stage ?? '')) ? 2500 : false,
    refetchIntervalInBackground: false,
  });
  const state = query.data;
  const start = async () => {
    if (action.current || !state) return; action.current = true; setSubmitting(true); setError(null);
    try {
      if (!intent.current || intent.current.revision !== state.summaryRevision) intent.current = { key:createIntentKey(), revision:state.summaryRevision };
      await api.post<'SourceSummaryStartResponse'>(`${path}/summary`, { expectedSummaryRevision: intent.current.revision }, { idempotencyKey: intent.current.key });
      intent.current = null; await query.refetch();
    } catch (err) { setError(err); } finally { action.current = false; setSubmitting(false); }
  };
  const resume = async () => {
    if (action.current || !state?.media?.jobId) return;
    action.current = true; setSubmitting(true); setError(null);
    try { await api.post<'AudioFallbackResumeResponse'>(`${path}/media-resume`, { jobId: state.media.jobId }); await query.refetch(); }
    catch (err) { setError(err); }
    finally { action.current = false; setSubmitting(false); }
  };
  return <section className="sources-processing" aria-label="文件处理与总结">
    <h4>文件总结</h4>
    {query.isLoading && <p>正在读取处理状态…</p>}
    {query.error && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
    {state && <>
      <p>正文提取：{state.media?.audio?.phase === 'waiting_config' ? '等待回退配置' : names[state.textStatus]} · 要求提取：{names[state.requirementsStatus]} · 文件总结：<StatusPill tone={state.summaryStatus === 'ready' ? 'good' : state.summaryStatus === 'failed' ? 'bad' : 'neutral'}>{names[state.summaryStatus]}</StatusPill></p>
      <AudioPipelineStatus audio={state.media?.audio} disabled={submitting} onResume={() => void resume()} onRefresh={() => void query.refetch()} />
      {state.media && <div className="callout"><strong>音视频 AI 摘要（非逐字原文）<AiReferenceBadge ariaHidden /></strong><p>处理阶段：{({pending:'排队',uploading:'上传',processing:'处理文件',generating:'生成摘要',ready:'完成',failed:'失败'} as Record<string,string>)[state.media.stage] ?? state.media.stage} · 已完成 {state.media.completedWindows} 个时间窗口</p>{state.media.error && <p role="alert" style={{whiteSpace:'pre-wrap'}}>{state.media.error}</p>}{state.media.summary && !state.media.summary.complete && <><p>部分摘要，尚未完整覆盖：</p><p style={{whiteSpace:'pre-wrap'}}>{state.media.summary.summary}</p></>}{state.media.summary?.timestamps.map((point,index) => <p key={index}>[{point.seconds}s] {point.description}</p>)}</div>}
      {state.requirementsError && <p className="callout warning-callout" style={{whiteSpace:'pre-wrap'}}>{state.requirementsError}</p>}
      {state.summaryStatus === 'failed' && <p className="callout warning-callout" style={{whiteSpace:'pre-wrap'}}>{state.summaryError ?? '总结失败，原文件和正文已保留。'}</p>}
      {state.summaryStatus === 'ready' && state.summary && <div>
        <strong>{state.summary.title}<AiReferenceBadge ariaHidden /></strong><p style={{whiteSpace:'pre-wrap'}}>{state.summary.summary}</p>
        <ul>{state.summary.keyPoints.map((point,index) => <li key={index}>{point}</li>)}</ul>
        {state.coveredChars !== null && state.totalChars !== null && state.coveredChars < state.totalChars && <p className="callout warning-callout">本次总结仅覆盖 {state.coveredChars}/{state.totalChars} 个正文字符，请结合原文查看其余内容。</p>}
        {state.summary.caveats.map((note,index) => <p key={index}>注意：{note}</p>)}
        <details><summary>{state.media ? '查看摘要依据说明' : '核对总结原文引用'}</summary>{state.summary.citations.map((cite,index) => <p key={index}><AiReferenceBadge />{cite.pageNumber ? `第 ${cite.pageNumber} 页` : '正文'}：{cite.quote}</p>)}</details>
        <p className="sources-inline-note">AI 总结需人工核对，不会替代原文件或要求确认。</p>
      </div>}
      {state.summaryStatus !== 'ready' && !['queued','running'].includes(state.summaryStatus) && <button type="button" className="button button-quiet button-small" disabled={submitting || state.textStatus !== 'ready' || !aiEnabled} onClick={() => void start()}>{submitting ? '正在提交…' : state.summaryStatus === 'failed' || state.summaryStatus === 'cancelled' ? '单独重试文件总结' : '生成文件总结'}</button>}
      {state.summaryStatus !== 'ready' && <p className="sources-inline-note">正文完整后，单独生成或重试总结会冻结当前已启用的模型配置，可能产生 AI 用量；不会重复解析正文或要求，失败后保留原文件。</p>}
    </>}
    {Boolean(error) && <ErrorNotice error={error} />}
  </section>;
}
