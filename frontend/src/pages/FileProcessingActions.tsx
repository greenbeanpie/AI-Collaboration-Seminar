import { useProject } from '../components/ProjectShell';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useCapabilities } from '../auth';
import { ErrorNotice } from '../components/ui';
import { fileProcessingKey, getFileProcessing, prepareFileScanPages, startFileProcessing } from './file-processing-client';

const labels: Record<string, string> = { pending: '尚未开始', queued: '已排队', processing: '正在处理', running: '正在处理', waiting_input: '待补充扫描页', ready: '已完成', succeeded: '已完成', failed: '失败，可重试', cancelled: '已取消', skipped: '不适用', disabled: 'AI 未启用', waiting_config: '等待模型配置', not_applicable: '不适用' };
const active = (status: string) => ['queued', 'running', 'processing'].includes(status);
export function FileProcessingActions({ projectId, fileId, disabled = false }: { projectId: string; fileId: string; disabled?: boolean }) {
  const client = useQueryClient();
  const { project } = useProject();
  const capabilities = useCapabilities();
  const [online, setOnline] = useState(navigator.onLine !== false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [progress, setProgress] = useState('');
  const lock = useRef(false);
  useEffect(() => { const update = () => setOnline(navigator.onLine !== false); window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); }; }, []);
  const query = useQuery({ queryKey: fileProcessingKey(projectId, fileId), queryFn: () => getFileProcessing(projectId, fileId), enabled: online, retry: false, refetchOnWindowFocus: 'always', refetchInterval: q => online && document.visibilityState !== 'hidden' && [q.state.data?.textStatus, q.state.data?.summaryStatus, q.state.data?.requirementsStatus].some(s => s && active(s)) ? 2500 : false });
  const state = query.data;
  const refreshedText = useRef('');
  useEffect(() => {
    if (!state?.textAvailable) return;
    const signature = `${state.sourceVersionId}:${state.textStatus}`;
    if (refreshedText.current === signature) return;
    refreshedText.current = signature;
    void Promise.all(['sources', 'sourceVersion', 'sourceProcessing', 'material', 'materials', 'materialVersions', 'resource-library', 'resource-detail', 'task-files'].map(key => client.invalidateQueries({ queryKey: [key, projectId] })));
  }, [state?.textAvailable, state?.sourceVersionId, state?.textStatus, client, projectId]);
  const running = state && [state.textStatus, state.summaryStatus, state.requirementsStatus].some(active);
  const retry = state && [state.textStatus, state.summaryStatus, state.requirementsStatus].some(s => ['failed', 'cancelled'].includes(s));
  async function run(scan = false) {
    if (lock.current || !state || !online) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      if (scan) {
        if (project?.aiCollaborationEnabled !== true || !capabilities.data?.features.aiEnabled) throw new Error('请先启用项目与服务 AI，再识别扫描页。');
        if (!capabilities.data) throw new Error('文件处理能力尚未读取，请稍后重试。');
        await prepareFileScanPages(projectId, state, capabilities.data.limits, setProgress);
      } else await startFileProcessing(projectId, fileId, state.lifecycleVersion, Boolean(retry));
      await query.refetch();
      await Promise.all(['sources', 'sourceVersion', 'sourceProcessing', 'material', 'materials', 'materialVersions', 'resource-library', 'resource-detail', 'task-files'].map(key => client.invalidateQueries({ queryKey: [key, projectId] })));
    } catch (err) { setError(err); } finally { lock.current = false; setBusy(false); }
  }
  return <section className="stack" aria-label="正文提取与文件处理">
    {state && <p role="status">正文提取：{labels[state.textStatus] ?? state.textStatus} · 文件总结：{labels[state.summaryStatus] ?? state.summaryStatus} · 要求提取：{labels[state.requirementsStatus] ?? state.requirementsStatus}</p>}
    <div className="form-actions">
      <button type="button" className="button button-quiet button-small" disabled={disabled || !online || busy || !state?.canProcess || Boolean(running)} onClick={() => void run()}>{busy ? '正在提交…' : running ? '后台处理中' : retry ? '重试处理' : state?.textAvailable ? '继续文件处理' : '提取正文'}</button>
      {state && state.needsImages > 0 && <button type="button" className="button button-primary button-small" disabled={disabled || !online || busy || !state.canProcess || !capabilities.data?.features.aiEnabled || project?.aiCollaborationEnabled !== true} onClick={() => void run(true)}>准备扫描页并识别</button>}
      <button type="button" className="button button-quiet button-small" disabled={!online || busy} onClick={() => void query.refetch()}>刷新处理状态</button>
      {state?.sourceId && <Link className="button button-quiet button-small" to={`/app/projects/${projectId}/data?resourceType=source&resourceId=${encodeURIComponent(state.sourceId)}`}>查看正文与处理记录</Link>}
    </div>
    <p className="form-note">普通文件提交后在后台处理，关闭页面仍会继续。扫描页准备时请保持页面打开；AI 总结不会替代成果正文。</p>
    {!online && <p>离线时无法提交文件处理，请联网后重试。</p>}
    {state?.error && <p className="callout warning-callout">{state.error}</p>}
    {progress && <p role="status">{progress}</p>}
    {Boolean(query.error) && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
    {Boolean(error) && <ErrorNotice error={error} />}
  </section>;
}
