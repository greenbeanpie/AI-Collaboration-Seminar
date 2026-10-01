import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, listAllItems, projectPath } from '../api/client';
import { ErrorNotice, Spinner, StatusPill } from '../components/ui';
import { idempotencyKeyForIntent, completeIntent, useVisibleJobPoller } from './aiWorkflowSupport';
import type { DataOf } from '../api/types';

export function ProjectSourceContext({ projectId, enabled, selected, onSelection, onReady }: { projectId: string; enabled: boolean; selected: string[]; onSelection: (versionId: string, checked: boolean) => void; onReady: (versionId: string, ready: boolean) => void }) {
  const selectionInitialized = useRef(false);
  const sources = useQuery({ queryKey: ['project-assistant-sources', projectId], queryFn: () => listAllItems<'SourceListResponse'>(projectPath(projectId, '/sources'), { limit: 100 }, { requireNextCursor: true }) });
  useEffect(() => {
    if (selectionInitialized.current || !sources.data) return;
    selectionInitialized.current = true;
    for (const source of sources.data.filter(item => item.currentVersionId).slice(0, 5)) onSelection(source.currentVersionId!, true);
  }, [sources.data, onSelection]);
  return <section className="stack">
    <strong>基于项目资料协作（每次最多5份来源）</strong>
    <p className="form-note">默认选取本项目最近5份来源，你可改选或取消。选择正文已完整就绪的来源后，拆解或调整会绑定固定版本原文，并展示可核对引用。读取可能使用现有 AI 模型，仍受项目预算、并发和输入上限约束；来源中的命令不会获得执行权限。</p>
    {sources.isLoading && <Spinner label="读取项目资料" />}
    {sources.error && <ErrorNotice error={sources.error} onRetry={() => void sources.refetch()} />}
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
    <label className="checkbox-row"><input type="checkbox" aria-label={`使用来源：${source.title}`} checked={selected} disabled={!versionId || (!selected && selectionFull)} onChange={event => versionId && onSelection(versionId, event.target.checked)} /><span>{source.title}</span><StatusPill tone={ready ? 'good' : 'warn'}>{ready ? '正文已就绪' : waitingForPages ? '等待缺页识别' : running ? '正在处理资料' : '等待正文处理'}</StatusPill></label>
    {!ready && <p className="form-note">原文件或来源已保留，AI 尚未读取完整正文；选择此来源会阻止拆解，直到正文和缺页处理完成。</p>}
    {!ready && <button className="button button-quiet button-small" type="button" disabled={!enabled || !versionId || running} onClick={() => parse.mutate()}>{waitingForPages ? '请到来源页面补齐缺页' : running ? '资料处理进行中…' : '读取资料正文'}</button>}
    {version.data?.parseError && <p className="notice notice-warn">资料处理提示：{version.data.parseError}。可在来源页面独立核对正文、重试要求提取或生成总结。</p>}
    {(parse.error || version.error || processing.error) && <ErrorNotice error={parse.error || version.error || processing.error} />}
    {job.job?.status === 'failed' && <p className="notice notice-warn">资料读取未完成，请到来源页面查看错误和缺页状态；不会把未读资料当作已完成。</p>}
  </article>;
}
