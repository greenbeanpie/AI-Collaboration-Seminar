import { usePagedItems } from '../features/pagination/usePagedItems';
import { LoadMore } from '../features/pagination/LoadMore';
import { AiReferenceBadge } from '../components/AiReferenceBadge';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, projectPath } from '../api/client';
import { ErrorNotice, Spinner, StatusPill } from '../components/ui';
import { idempotencyKeyForIntent, completeIntent, useVisibleJobPoller } from './aiWorkflowSupport';
import type { DataOf } from '../api/types';

export function ProjectSourceContext({ projectId, enabled, selected, onSelection, onReady }: { projectId: string; enabled: boolean; selected: string[]; onSelection: (versionId: string, checked: boolean) => void; onReady: (versionId: string, ready: boolean) => void }) {
  const sources = usePagedItems<'SourceListResponse'>({ searchable: true, queryKey: ['project-assistant-sources', projectId], path: projectPath(projectId, '/sources'), query: { limit: 100 } });
  useEffect(() => {
    // Only a complete, unfiltered list can prove a formerly current source is gone.
    if (!sources.data || sources.hasNextPage || sources.search?.trim()) return;
    const activeVersions = new Set(sources.data.map(source => source.currentVersionId).filter(Boolean));
    for (const versionId of selected) if (!activeVersions.has(versionId)) {
      onSelection(versionId, false);
      onReady(versionId, false);
    }
  }, [sources.data, sources.hasNextPage, sources.search, selected, onSelection, onReady]);
  return <section className="stack">
    <strong>优先参考来源（可选固定版本）</strong>

    {sources.isLoading && <Spinner label="读取项目资料" />}
    {sources.error && <ErrorNotice error={sources.error} onRetry={() => void sources.refetch()} />}<LoadMore query={sources} />
    {sources.data?.length === 0 && <p className="form-note">尚无项目来源；可先上传资料，也可仅按你填写的目标发起拆解。</p>}
    {sources.data?.map(source => <SourceContextRow key={source.sourceId} projectId={projectId} source={source} enabled={enabled} selected={source.currentVersionId ? selected.includes(source.currentVersionId) : false} selectionFull={selected.length >= 5} onSelection={onSelection} onReady={onReady} />)}
    <Link className="button button-quiet button-small" to={`/app/projects/${projectId}/sources`}>查看原文件、缺页处理与文件总结</Link>
  </section>;
}

function SourceContextRow({ projectId, source, enabled, selected, selectionFull, onSelection, onReady }: { projectId: string; source: DataOf<'SourceListResponse'>['items'][number]; enabled: boolean; selected: boolean; selectionFull: boolean; onSelection: (versionId: string, checked: boolean) => void; onReady: (versionId: string, ready: boolean) => void }) {
  const client = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useVisibleJobPoller(jobId);
  const versionId = source.currentVersionId;
  const queryKey = ['project-assistant-source-version', projectId, source.sourceId, versionId];
  const version = useQuery({ queryKey, queryFn: () => api.get<'SourceVersionResponse'>(projectPath(projectId, `/sources/${source.sourceId}/versions/${versionId}`)), enabled: Boolean(versionId), refetchInterval: query => jobId && !job.isSettled || query.state.data?.processingJob ? 2500 : false, refetchIntervalInBackground: false });
  const serverJob = version.data?.processingJob;
  const processing = useQuery({ queryKey: ['project-assistant-source-processing', projectId, source.sourceId, versionId], queryFn: () => api.get<'SourceProcessingResponse'>(projectPath(projectId, `/sources/${source.sourceId}/versions/${versionId}/processing`)), enabled: Boolean(versionId), refetchInterval: query => serverJob || jobId && !job.isSettled || ['pending', 'processing', 'waiting_input'].includes(query.state.data?.textStatus ?? '') && Boolean(jobId) ? 2500 : false, refetchIntervalInBackground: false });
  const ready = Boolean(processing.data?.textStatus === 'ready' && version.data?.charCount && version.data.pages.every(page => page.textStatus !== 'none' || page.ocrStatus === 'ok'));
  useEffect(() => { if (serverJob && (!jobId || job.isSettled && jobId !== serverJob.jobId)) setJobId(serverJob.jobId); }, [serverJob, jobId, job.isSettled]);
  useEffect(() => { if (versionId) onReady(versionId, ready); }, [versionId, ready, onReady]);
  useEffect(() => { if (job.isSettled) { void client.invalidateQueries({ queryKey: ['project-assistant-source-version', projectId, source.sourceId, versionId] }); void client.invalidateQueries({ queryKey: ['project-assistant-source-processing', projectId, source.sourceId, versionId] }); } }, [job.isSettled, client, projectId, source.sourceId, versionId]);
  const parse = useMutation({ mutationFn: async () => {
    const namespace = `project-assistant:parse:${projectId}:${versionId}`;
    const body = { sourceVersionId: versionId };
    const key = await idempotencyKeyForIntent(namespace, body);
    const result = await api.post<'SourceParseResponse'>(projectPath(projectId, `/sources/${source.sourceId}/parse`), body, { idempotencyKey: key });
    completeIntent(namespace);
    return result;
  }, onSuccess: result => { setJobId(result.jobId); void version.refetch(); void processing.refetch(); } });
  const waitingForPages = serverJob?.status === 'waiting_input' || processing.data?.textStatus === 'waiting_input';
  const running = parse.isPending || Boolean(serverJob || jobId && !job.isSettled);
  return <article className="collab-proposal stack">
    <label className="checkbox-row"><input type="checkbox" aria-label={`使用来源：${source.title}`} checked={selected} disabled={!versionId || (!selected && selectionFull)} onChange={event => versionId && onSelection(versionId, event.target.checked)} /><span>{source.title}</span><AiReferenceBadge ariaHidden /><StatusPill tone={ready ? 'good' : 'warn'}>{ready ? '正文已就绪' : waitingForPages ? '等待缺页识别' : running ? '正在处理资料' : '等待正文处理'}</StatusPill></label>
    {!ready && <p className="form-note">原文件或来源已保留，此来源尚未完整读取。AI会说明信息缺口，可在来源页面补齐识别后继续。</p>}
    {!ready && <button className="button button-quiet button-small" type="button" disabled={!enabled || !versionId || running} onClick={() => parse.mutate()}>{waitingForPages ? '请到来源页面补齐缺页' : running ? '资料处理进行中…' : '读取资料正文'}</button>}
    {version.data?.parseError && <p className="notice notice-warn">资料处理提示：{version.data.parseError}。可在来源页面独立核对正文、重试要求提取或生成总结。</p>}
    {(parse.error || version.error || processing.error) && <ErrorNotice error={parse.error || version.error || processing.error} />}
    {job.job?.status === 'failed' && <ErrorNotice error={job.job.error ?? new Error('资料读取未完成。')} />}
  </article>;
}
