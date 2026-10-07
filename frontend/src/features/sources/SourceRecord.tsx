import { FileProcessingActions } from '../../pages/FileProcessingActions';
import { AiActivityStatus } from '../../components/AiActivityStatus';
import { AiReferenceBadge } from '../../components/AiReferenceBadge';
import { errorMessage } from '../../api/error-info';
import { ResourceIndexView, BrowserSourceRecovery, PageReviewActions } from '../../pages/ResourceIndexView';
import { ContributorNames } from '../../components/FileContributors';
import { SourceFullText } from '../../pages/SourceFullText';
import { SourceProcessingCard } from '../../pages/SourceProcessingCard';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { LoaderCircle, ScanText, Trash2 } from 'lucide-react';
import { api, projectPath } from '../../api/client';
import { ErrorNotice, StatusPill } from '../../components/ui';
import { useProject } from '../../components/ProjectShell';
import { sourceFileId, type TrackedSourceJob } from '../../pages/source-workflows';
import type { SourceItem, SourceVersion, Job, CapabilityData } from './types';
const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'waiting_input']);

function classifySourceError(error: unknown): string { return errorMessage(error, '操作失败，请稍后重试。'); }

function formatSourceKind(kind: SourceItem['kind']): string {
  return kind === 'file' ? '文件' : kind === 'web' ? '网页' : '粘贴文本';
}

function sourceStatus(status: SourceVersion['status']): { label: string; tone: 'neutral' | 'good' | 'warn' | 'bad' | 'blue' } {
  if (status === 'ready') return { label: '原文已提取', tone: 'good' };
  if (status === 'processing') return { label: '正在处理', tone: 'blue' };
  if (status === 'failed') return { label: '处理失败', tone: 'bad' };
  return { label: '等待解析', tone: 'neutral' };
}

function sourcePageStatus(version: SourceVersion, pageNumber: number) {
  const page = version.pages.find((item) => item.pageNumber === pageNumber);
  if (!page) return null;
  const text = page.textStatus === 'extracted' ? '有文本层' : page.textStatus === 'empty' ? '无可提取文本' : '待补页面图';
  const ocr = page.ocrStatus === 'ok' ? '已识别' : page.ocrStatus === 'failed' ? '识别失败' : page.ocrStatus === 'pending' ? '识别中' : '';
  return { text, ocr, needsReview: page.needsReview };
}

function ResultSetLink({ result }: { result: unknown }) {
  const { projectId } = useProject();
  if (!result || typeof result !== 'object') return null;
  const requirementSetId = (result as { requirementSetId?: unknown }).requirementSetId;
  if (typeof requirementSetId !== 'string') return null;
  return <Link className="button button-quiet button-small" to={`/app/projects/${projectId}/requirements?setId=${encodeURIComponent(requirementSetId)}`}>查看要求草稿</Link>;
}

function SourceJobProgress({
  projectId,
  tracked,
  capability,
  onUpdate,
  onRetryJob,
  onScan,
  scanning,
}: {
  projectId: string;
  tracked: TrackedSourceJob;
  capability?: CapabilityData;
  onUpdate: (jobId: string, status: Job['status']) => void;
  onRetryJob: (tracked: TrackedSourceJob) => Promise<void> | void;
  onScan: (tracked: TrackedSourceJob) => void;
  scanning: boolean;
}) {
  const queryClient = useQueryClient();
  const { project } = useProject();
  const aiEnabled = capability?.features.aiEnabled === true && project?.aiCollaborationEnabled === true;
  const [resuming, setResuming] = useState(false);
  const resumeLock = useRef(false);
  const resume = async () => {
    if (resumeLock.current) return;
    resumeLock.current = true; setResuming(true);
    try { await onRetryJob(tracked); } finally { resumeLock.current = false; setResuming(false); }
  };
  const [pollInterval, setPollInterval] = useState(2_000);
  const lastUpdatedAt = useRef(0);
  const notifiedStatus = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ['job', tracked.jobId],
    queryFn: () => api.get<'JobResponse'>(`/api/v1/jobs/${encodeURIComponent(tracked.jobId)}`),
    refetchInterval: (current) => document.visibilityState === 'hidden' || terminalStatuses.has(current.state.data?.status ?? '') ? false : pollInterval,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  const job = query.data;

  useEffect(() => {
    if (!job) return;
    if (lastUpdatedAt.current && query.dataUpdatedAt !== lastUpdatedAt.current && !terminalStatuses.has(job.status)) {
      setPollInterval((current) => Math.min(current + 2_000, 10_000));
    }
    lastUpdatedAt.current = query.dataUpdatedAt;
    onUpdate(job.jobId, job.status);
    if (terminalStatuses.has(job.status) && notifiedStatus.current !== job.status) {
      notifiedStatus.current = job.status;
      void queryClient.invalidateQueries({ queryKey: ['requirementSets', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['sources', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['sourceVersion', projectId, tracked.sourceId, tracked.sourceVersionId] });
      void queryClient.invalidateQueries({ queryKey: ['sourceProcessing', projectId, tracked.sourceId, tracked.sourceVersionId] });
    }
  }, [job, query.dataUpdatedAt, onUpdate, projectId, queryClient, tracked.sourceId, tracked.sourceVersionId]);

  const result = job?.result && typeof job.result === 'object' ? job.result as Record<string, unknown> : {};
  const needsImages = typeof result.needsImages === 'number' ? result.needsImages : 0;
  const remaining = typeof result.stillMissing === 'number' ? result.stillMissing : needsImages;
  const pagesToRender = Math.max(needsImages, remaining);
  const error = job?.error;
  const progress = job?.status === 'waiting_input'
    ? remaining > 0 ? `有 ${remaining} 页需要补充页面图。` : '等待补充资料。'
    : job?.status === 'succeeded' ? result.count === 0 ? '正文处理完成，未发现明确的项目要求。文件总结可在下方单独查看。' : '处理完成，已生成要求草稿。'
    : job?.status === 'failed' ? errorMessage(error, '来源处理失败。')
        : job?.status === 'cancelled' ? '任务已取消。' : '正在解析来源并生成要求草稿。';

  return <div className="sources-job" aria-live="polite">
    <AiActivityStatus job={job ?? null} jobId={tracked.jobId} loading={query.isLoading} readError={query.error} onRefresh={() => void query.refetch()} onResume={capability?.features.aiEnabled ? resume : undefined} resuming={resuming} />
    <div className="sources-job-head">
      <div><strong>{query.isLoading ? '正在读取解析任务' : job ? `解析任务：${job.status}` : '解析任务状态暂不可用'}</strong><p style={{whiteSpace:'pre-wrap'}}>{query.error ? classifySourceError(query.error) : progress}</p></div>
      <div className="sources-record-actions">
        {job?.status === 'waiting_input' && pagesToRender > 0 && (
          <button className="button button-primary button-small" type="button" disabled={scanning || !aiEnabled} onClick={() => onScan(tracked)}>
            {scanning ? <><LoaderCircle className="spin" size={14} /> 正在处理页面</> : <><ScanText size={14} /> 准备扫描页并识别</>}
          </button>
        )}

        {job?.status === 'succeeded' && <ResultSetLink result={job.result} />}
        {query.error && <button className="button button-quiet button-small" type="button" onClick={() => void query.refetch()}>重新查询</button>}
      </div>
    </div>
    {job?.status === 'waiting_input' && pagesToRender > 0 && !aiEnabled && <div className="callout warning-callout">当前服务能力显示 AI 未启用。扫描页 OCR 和要求提取暂不可用，页面不会用模拟结果替代。</div>}

    {scanning && <div className="sources-scan-progress">正在读取待渲染页码、用 PDF.js 生成页面图片并按服务端限制上传。{scanning ? '请保持此页打开。' : ''}</div>}
    {query.error && <div className="sources-error"><ErrorNotice error={query.error} onRetry={() => void query.refetch()} /></div>}
  </div>;
}

export function SourceRecord({
  source,
  version,
  projectId,
  highlighted,
  highlightedPageNumber,
  jobs,
  capability,
  parsingSourceId,
  scanJobId,
  scanProgress,
  onParse,
  onRetryJob,
  onScan,
  onJobUpdate,
  onRemove,
  lifecycleBusy = false,
  hideTitle = false,
}: {
  source: SourceItem;
  version?: SourceVersion;
  projectId: string;
  highlighted: boolean;
  highlightedPageNumber: number | null;
  jobs: TrackedSourceJob[];
  capability?: CapabilityData;
  parsingSourceId: string | null;
  scanJobId: string | null;
  scanProgress: string;
  onParse: (source: SourceItem, sourceVersionId: string) => void;
  onRetryJob: (tracked: TrackedSourceJob) => Promise<void> | void;
  onScan: (tracked: TrackedSourceJob) => void;
  onJobUpdate: (jobId: string, status: Job['status']) => void;
  onRemove?: (source: SourceItem) => void;
  lifecycleBusy?: boolean;
  hideTitle?: boolean;
}) {
  const isBusy = parsingSourceId === source.sourceId;
  const serverJob = version?.processingJob;
  const localJob = jobs[0];
  const serverTracked = serverJob && version ? { jobId:serverJob.jobId, status:serverJob.status, sourceId:source.sourceId, sourceVersionId:version.sourceVersionId, sourceTitle:source.title, fileId:version.fileId } : undefined;
  const latestJob = serverTracked && ['queued','running'].includes(serverTracked.status) ? serverTracked
    : localJob?.status && ['queued','running'].includes(localJob.status) ? localJob : serverTracked ?? localJob;
  const activeJob = latestJob?.status && ['queued', 'running'].includes(latestJob.status) ? latestJob : undefined;
  const waitingForImages = latestJob?.status === 'waiting_input' || Boolean(version?.pages.some(page => page.textStatus === 'none' && page.ocrStatus !== 'ok'));
  const displayedJob = latestJob;
  const currentFileId = version?.fileId ?? (source.currentVersionId ? sourceFileId(projectId, source.currentVersionId) : null);
  const versionBadge = version ? sourceStatus(version.status) : null;
  return <article id={`source-${source.sourceId}`} className={`sources-record${highlighted ? ' sources-record-target' : ''}`}>
    <div className="sources-record-heading">
      <div>
        <div className="source-status"><AiReferenceBadge />
          <StatusPill tone={source.kind === 'file' ? 'blue' : 'neutral'}>{formatSourceKind(source.kind)}</StatusPill>
          {versionBadge && <StatusPill tone={versionBadge.tone}>{versionBadge.label}</StatusPill>}
        </div>
        {!hideTitle && <h3>{source.title}</h3>}
        {source.kind === 'file' && <ContributorNames contributors={source.contributors} />}
        <p>创建于 {new Date(source.createdAt).toLocaleString('zh-CN')}</p>
      </div>
      <div className="sources-record-actions">
        {currentFileId && <a className="button button-quiet button-small" href={projectPath(projectId, `/files/${encodeURIComponent(currentFileId)}/content`)} target="_blank" rel="noopener noreferrer">查看原文件</a>}
        <button className="button button-quiet button-small" type="button" disabled={!source.currentVersionId || !capability?.features.aiEnabled || isBusy || Boolean(activeJob)} onClick={() => source.currentVersionId && onParse(source, source.currentVersionId)}>
          {isBusy ? <><LoaderCircle className="spin" size={14} /> 正在发起</> : activeJob ? '已有任务处理中' : !capability?.features.aiEnabled ? 'AI 未启用' : waitingForImages ? '重新读取文本层并提取要求' : version?.status === 'ready' ? '重新解析' : '开始解析'}
        </button>
        {source.kind !== 'file' && !source.fileId && source.canDelete && onRemove && <button className="button button-danger button-small" type="button" disabled={lifecycleBusy} aria-label={`移入回收站：${source.title}`} onClick={() => onRemove(source)}><Trash2 size={14} />移入回收站</button>}
      </div>
    </div>
    {currentFileId && <FileProcessingActions projectId={projectId} fileId={currentFileId} />}
    {waitingForImages && <p className="muted">若此 PDF 本来有文本层，可重新读取服务器保留的原文件，无需重复上传；文本完整后会继续使用当前任务模型配置提取要求，可能产生 AI 用量。</p>}
    <div className="sources-record-meta">
      {version ? <span>来源版本 {version.revision}</span> : source.currentVersionId ? <span>正在读取来源版本</span> : <span>暂无可解析版本</span>}
      {version?.pageCount !== null && version?.pageCount !== undefined && <span>{version.pageCount} 页</span>}
      {version?.charCount !== null && version?.charCount !== undefined && <span>{version.charCount.toLocaleString()} 字符</span>}
      {currentFileId && <span>已关联原文件，可下载核对</span>}
    </div>
    <section className="source-relationship" aria-label="文件、来源与引用关系">
      <p>{currentFileId ? '原文件 → 来源版本 → 解析正文 → 项目标准引用' : `${formatSourceKind(source.kind)} → 来源版本 → 解析正文 → 项目标准引用`}</p>
      <p className="sources-inline-note">来源版本保存本次原文；解析状态对应此版本。项目标准中的引用指向来源版本和原句，方便核对。</p>
      <Link className="button button-quiet button-small" to={`/app/projects/${projectId}/requirements`}>查看项目标准与引用</Link>
    </section>
    <details className="source-technical-details">
      <summary>技术详情</summary>
      <dl>
        <dt>来源编号</dt><dd>{source.sourceId}</dd>
        <dt>来源版本编号</dt><dd>{version?.sourceVersionId ?? source.currentVersionId ?? '尚未创建'}</dd>
        {currentFileId && <><dt>原文件编号</dt><dd>{currentFileId}</dd></>}
      </dl>
    </details>
    {version?.extractionCoverage === 'partial' && <p className="callout warning-callout">正文覆盖部分资料，请核对未读取对象与原文件。</p>}
    {Boolean(version?.extractionWarnings?.length) && <ul>{version?.extractionWarnings?.map((warning,i)=><li key={i}>{warning}</li>)}</ul>}
    {version?.parseError && <div className="callout danger-callout">{version.parseError}</div>}
    {version?.pages.length ? <div className="sources-pages" aria-label="逐页处理状态">{version.pages.map((page) => {
      const status = sourcePageStatus(version, page.pageNumber);
      if (!status) return null;
      return <span id={`source-page-${source.sourceId}-${page.pageNumber}`} className={`sources-page-chip${highlightedPageNumber === page.pageNumber ? ' sources-page-chip-target' : ''}`} key={page.pageNumber}>第 {page.pageNumber} 页 · {status.text}{status.ocr ? ` · ${status.ocr}` : ''}{status.needsReview ? ' · 待人工复核' : ''}</span>;
    })}</div> : null}
    {displayedJob && <SourceJobProgress projectId={projectId} tracked={displayedJob} capability={capability} onUpdate={onJobUpdate} onRetryJob={onRetryJob} onScan={onScan} scanning={scanJobId === displayedJob.jobId} />}
    {displayedJob && scanProgress && <p className="sources-inline-note">{scanProgress}</p>}
    {version && <ResourceIndexView projectId={projectId} resourceType="source" versionId={version.sourceVersionId} fileId={currentFileId} />}
    {version && currentFileId && version.pageCount !== null && <PageReviewActions projectId={projectId} sourceId={source.sourceId} versionId={version.sourceVersionId} fileId={currentFileId} aiEnabled={Boolean(capability?.features.aiEnabled)} />}
    {version && currentFileId && <BrowserSourceRecovery projectId={projectId} versionId={version.sourceVersionId} fileId={currentFileId} />}
    {version && <SourceFullText sourceId={source.sourceId} sourceVersionId={version.sourceVersionId} />}
    {version && <SourceProcessingCard projectId={projectId} sourceId={source.sourceId} versionId={version.sourceVersionId} aiEnabled={Boolean(capability?.features.aiEnabled)} active={Boolean(activeJob)} />}
    {version?.status === 'ready' && <p className="sources-inline-note">要求草稿和引用请到“评分”的项目标准查看。引用展示原句与页码，可展开下方全文片段核对原文件。</p>}
  </article>;
}

