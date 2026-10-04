import { ResourceIndexView,BrowserSourceRecovery,PageReviewActions } from './ResourceIndexView';
import { importBrowserFile,documentRequest } from './document-import-client';
import { ContributorNames, FileContributorPicker } from '../components/FileContributors';
import { SourceFullText } from './SourceFullText';
import { SourceProcessingCard } from './SourceProcessingCard';
import { ProjectFileLibrary } from './ProjectFileLibrary';
import { useSourceLifecycle, type LifecycleChange } from './source-lifecycle';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { FilePlus2, FileText, Globe2, LoaderCircle, ScanText, Send, Trash2, Type } from 'lucide-react';
import { ApiError, api, projectPath } from '../api/client';
import type { DataOf } from '../api/types';
import { EmptyState, ErrorNotice, Field, PageHeading, SectionCard, Spinner, StatusPill } from '../components/ui';
import { useProject } from '../components/ProjectShell';
import {
  createIntentKey,
  downloadSourcePdf,
  listAllProjectItems,
  readTrackedSourceJobs,
  rememberSourceFile,
  sourceFileId,
  uploadProjectFile,
  writeTrackedSourceJobs,
  type TrackedSourceJob,
} from './source-workflows';
import './SourcesPage.css';

type SourceItem = DataOf<'SourceListResponse'>['items'][number];
type SourceVersion = DataOf<'SourceVersionResponse'>;
type Job = DataOf<'JobResponse'>;
type CapabilityData = DataOf<'CapabilitiesResponse'>;
type IntakeKind = 'paste' | 'web' | 'file';
type PendingUpload = { fileId: string; file: File };
type PageImagesBody = { sourceVersionId: string; images: Array<{ pageNumber: number; fileId: string }> };
type PendingPageImagesSubmission = { body: PageImagesBody; idempotencyKey: string };

const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'waiting_input']);

function classifySourceError(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : '操作失败，请稍后重试。';
  if (error.code === 'FILE_TOO_LARGE') return '文件超过当前服务端限制，请选择更小的文件。';
  if (error.code === 'UNSUPPORTED_MEDIA_TYPE') return '文件内容与扩展名不匹配，服务端拒绝了上传。';
  if (error.code === 'SOURCE_PARSE_FAILED') return error.message;
  if (error.code === 'AI_UNAVAILABLE') return 'AI 能力当前不可用。来源已保留；请稍后重试，系统不会改用模拟结果。';
  if (error.code === 'PERMISSION_DENIED') return '当前账户没有此项目的操作权限。';
  return `${error.message}（${error.code}）`;
}

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
  onRetryJob: (tracked: TrackedSourceJob) => void;
  onScan: (tracked: TrackedSourceJob) => void;
  scanning: boolean;
}) {
  const queryClient = useQueryClient();
  const [pollInterval, setPollInterval] = useState(2_000);
  const lastUpdatedAt = useRef(0);
  const notifiedStatus = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ['job', tracked.jobId],
    queryFn: () => api.get<'JobResponse'>(`/api/v1/jobs/${encodeURIComponent(tracked.jobId)}`),
    refetchInterval: (current) => terminalStatuses.has(current.state.data?.status ?? '') ? false : pollInterval,
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
  const error = job?.error && typeof job.error === 'object' ? job.error as { code?: string; message?: string } : null;
  const progress = job?.status === 'waiting_input'
    ? remaining > 0 ? `有 ${remaining} 页需要补充页面图。` : '等待补充资料。'
    : job?.status === 'succeeded' ? result.count === 0 ? '正文处理完成，未发现明确的项目要求。文件总结可在下方单独查看。' : '处理完成，已生成要求草稿。'
    : job?.status === 'failed' ? `${error?.message ?? '来源处理失败。'}${error?.code ? `（${error.code}）` : ''}`
        : job?.status === 'cancelled' ? '任务已取消。' : '正在解析来源并生成要求草稿。';

  return <div className="sources-job" aria-live="polite">
    <div className="sources-job-head">
      <div><strong>{query.isLoading ? '正在读取解析任务' : job ? `解析任务：${job.status}` : '解析任务状态暂不可用'}</strong><p>{query.error ? classifySourceError(query.error) : progress}</p></div>
      <div className="sources-record-actions">
        {job?.status === 'waiting_input' && pagesToRender > 0 && (
          <button className="button button-primary button-small" type="button" disabled={scanning || !capability?.features.aiEnabled} onClick={() => onScan(tracked)}>
            {scanning ? <><LoaderCircle className="spin" size={14} /> 正在处理页面</> : <><ScanText size={14} /> 渲染并上传扫描页</>}
          </button>
        )}
        {job?.status === 'failed' && <button className="button button-quiet button-small" type="button" disabled={!capability?.features.aiEnabled} onClick={() => onRetryJob(tracked)}>重试任务</button>}
        {job?.status === 'succeeded' && <ResultSetLink result={job.result} />}
        {query.error && <button className="button button-quiet button-small" type="button" onClick={() => void query.refetch()}>重新查询</button>}
      </div>
    </div>
    {job?.status === 'waiting_input' && pagesToRender > 0 && !capability?.features.aiEnabled && <div className="callout warning-callout">当前服务能力显示 AI 未启用。扫描页 OCR 和要求提取暂不可用，页面不会用模拟结果替代。</div>}

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
  onRetryJob: (tracked: TrackedSourceJob) => void;
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
        <div className="source-status">
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
    {waitingForImages && <p className="muted">若此 PDF 本来有文本层，可重新读取服务器保留的原文件，无需重复上传；文本完整后会继续使用当前任务模型配置提取要求，可能产生 AI 用量。</p>}
    <div className="sources-record-meta">
      {source.currentVersionId ? <span>版本 {source.currentVersionId.slice(0, 8)}</span> : <span>暂无可解析版本</span>}
      {version?.pageCount !== null && version?.pageCount !== undefined && <span>{version.pageCount} 页</span>}
      {version?.charCount !== null && version?.charCount !== undefined && <span>{version.charCount.toLocaleString()} 字符</span>}
      {currentFileId && <span>已关联原文件，可继续渲染扫描页</span>}
    </div>
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

export function SourcesPage({ embedded = false, selectedSourceId, intakeOnly = false, header }: { header?: ReactNode; embedded?: boolean; selectedSourceId?: string; intakeOnly?: boolean }) {
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const targetSourceVersionId = searchParams.get('sourceVersionId');
  const targetPageValue = searchParams.get('page');
  const targetPageNumber = targetPageValue && Number.isInteger(Number(targetPageValue)) ? Number(targetPageValue) : null;
  const [kind, setKind] = useState<IntakeKind>('paste');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [parseMode,setParseMode]=useState<'auto'|'cloud'|'browser'>('auto');
  const importAbort=useRef<AbortController|null>(null);
  useEffect(()=>()=>importAbort.current?.abort(),[]);
  const [contributorIds, setContributorIds] = useState<string[] | undefined>();
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitStage, setSubmitStage] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  const [successMessage, setSuccessMessage] = useState('');
  const [parsingSourceId, setParsingSourceId] = useState<string | null>(null);
  const [trackedJobs, setTrackedJobs] = useState<TrackedSourceJob[]>(() => readTrackedSourceJobs(projectId));
  const [trackedJobsProjectId, setTrackedJobsProjectId] = useState(projectId);
  const [scanJobId, setScanJobId] = useState<string | null>(null);
  const [scanProgressSourceId, setScanProgressSourceId] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState('');
  const sourceIntentKeys = useRef(new Map<string, string>());
  const parseIntentKeys = useRef(new Map<string, string>());
  const retryIntentKeys = useRef(new Map<string, string>());
  const fileInitIntentKeys = useRef(new WeakMap<File, string>());
  const pageImagesIntentKeys = useRef(new Map<string, PendingPageImagesSubmission>());
  const currentProjectId = useRef(projectId); currentProjectId.current = projectId;
  const unavailableSourceIds = useRef(new Set<string>());
  const unavailableFileIds = useRef(new Set<string>());
  const sourceLifecycleEpochs = useRef(new Map<string, number>());

  const capabilityQuery = useQuery({ queryKey: ['capabilities'], queryFn: () => api.get<'CapabilitiesResponse'>('/api/v1/capabilities') });
  const capability = capabilityQuery.data;
  const sourceQuery = useQuery({
    queryKey: ['sources', projectId],
    queryFn: ({ signal }) => listAllProjectItems<'SourceListResponse'>(projectId, '/sources', capability!.limits.listMaxPageSize, signal, { deleted: false }),
    enabled: Boolean(capability),
  });
  const sources = useMemo(() => sourceQuery.data ?? [], [sourceQuery.data]);
  const handleLifecycleChanged = useCallback((change: LifecycleChange) => {
    if (change.projectId !== currentProjectId.current) return;
    void queryClient.invalidateQueries({ queryKey: ['resource-library', change.projectId] });
    const affected = new Set(change.sourceIds);
    for (const id of affected) {
      sourceLifecycleEpochs.current.set(id, (sourceLifecycleEpochs.current.get(id) ?? 0) + 1);
      if (change.restored) unavailableSourceIds.current.delete(id);
      else unavailableSourceIds.current.add(id);
    }
    if (change.fileId) {
      if (change.restored) unavailableFileIds.current.delete(change.fileId);
      else unavailableFileIds.current.add(change.fileId);
      setPendingUpload(current => current?.fileId === change.fileId ? null : current);
    }
    setTrackedJobs(items => {
      for (const item of items) if (affected.has(item.sourceId)) {
        retryIntentKeys.current.delete(item.jobId);
        pageImagesIntentKeys.current.delete(item.jobId);
      }
      const remaining = items.filter(item => !affected.has(item.sourceId) && (!change.fileId || item.fileId !== change.fileId));
      writeTrackedSourceJobs(change.projectId, remaining);
      return remaining;
    });
    for (const key of parseIntentKeys.current.keys()) if (affected.has(key.split(':')[0])) parseIntentKeys.current.delete(key);
    setParsingSourceId(current => current && affected.has(current) ? null : current);
    setScanProgressSourceId(current => current && affected.has(current) ? null : current);
  }, [queryClient]);
  const sourceResources = sources.filter(source => source.kind !== 'file' && !source.fileId).map(source => ({ kind: 'source' as const, id: source.sourceId, name: source.title, lifecycleVersion: source.lifecycleVersion, canDelete: source.canDelete, deletedAt: source.deletedAt }));
  const sourceLifecycle = useSourceLifecycle(projectId, 'active-sources', sourceResources, handleLifecycleChanged);
  const versionQueries = useQueries({ queries: sources.filter((source) => source.currentVersionId).map((source) => ({
    queryKey: ['sourceVersion', projectId, source.sourceId, source.sourceId === selectedSourceId && targetSourceVersionId ? targetSourceVersionId : source.currentVersionId],
    queryFn: () => api.get<'SourceVersionResponse'>(projectPath(projectId, `/sources/${encodeURIComponent(source.sourceId)}/versions/${encodeURIComponent(source.sourceId === selectedSourceId && targetSourceVersionId ? targetSourceVersionId : source.currentVersionId!)}`)),
    enabled: Boolean(source.currentVersionId),
  })) });
  const versionsBySourceId = useMemo(() => {
    const map = new Map<string, SourceVersion>();
    sources.filter((source) => source.currentVersionId).forEach((source, index) => {
      const version = versionQueries[index]?.data;
      if (version) map.set(source.sourceId, version);
    });
    return map;
  }, [sources, versionQueries]);

  useEffect(() => {
    if (trackedJobsProjectId === projectId) return;
    setTrackedJobsProjectId(projectId);
    setTrackedJobs(readTrackedSourceJobs(projectId));
    setKind('paste');
    setTitle('');
    setText('');
    setUrl('');
    setFile(null);
    setPendingUpload(null);
    setActionError(null);
    setSuccessMessage('');
    setScanJobId(null);
    setScanProgressSourceId(null);
    setScanProgress('');
    sourceIntentKeys.current.clear();
    fileInitIntentKeys.current = new WeakMap<File, string>();
    parseIntentKeys.current.clear();
    retryIntentKeys.current.clear();
    pageImagesIntentKeys.current.clear();
    unavailableSourceIds.current.clear();
    unavailableFileIds.current.clear();
    sourceLifecycleEpochs.current.clear();
  }, [projectId, trackedJobsProjectId]);

  useEffect(() => {
    if (trackedJobsProjectId === projectId) writeTrackedSourceJobs(projectId, trackedJobs);
  }, [projectId, trackedJobsProjectId, trackedJobs]);

  useEffect(() => {
    if (!targetSourceVersionId || !sources.length) return;
    const matched = sources.find((source) => source.currentVersionId === targetSourceVersionId);
    if (matched) {
      const targetId = targetPageNumber ? `source-page-${matched.sourceId}-${targetPageNumber}` : `source-${matched.sourceId}`;
      requestAnimationFrame(() => document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    }
  }, [sources, targetSourceVersionId, targetPageNumber, versionsBySourceId]);

  const replaceTracked = useCallback((oldJobId: string, update: Partial<TrackedSourceJob>) => {
    setTrackedJobs((items) => items.map((item) => item.jobId === oldJobId ? { ...item, ...update } : item));
  }, []);

  const onJobUpdate = useCallback((jobId: string, status: Job['status']) => {
    setTrackedJobs((items) => {
      const current = items.find((item) => item.jobId === jobId);
      if (!current || current.status === status) return items;
      return items.map((item) => item.jobId === jobId ? { ...item, status } : item);
    });
  }, []);

  const trackJob = useCallback((item: TrackedSourceJob) => {
    setTrackedJobs((items) => [item, ...items.filter((existing) => existing.jobId !== item.jobId)]);
  }, []);

  const startParse = useCallback(async (source: Pick<SourceItem, 'sourceId' | 'title'>, sourceVersionId: string): Promise<boolean> => {
    if (unavailableSourceIds.current.has(source.sourceId)) return false;
    const lifecycleEpoch = sourceLifecycleEpochs.current.get(source.sourceId) ?? 0;
    const intentId = `${source.sourceId}:${sourceVersionId}`;
    const intentKey = parseIntentKeys.current.get(intentId) ?? createIntentKey();
    parseIntentKeys.current.set(intentId, intentKey);
    setActionError(null);
    setSuccessMessage('');
    setParsingSourceId(source.sourceId);
    try {
      const result = await api.post<'SourceParseResponse'>(projectPath(projectId, `/sources/${encodeURIComponent(source.sourceId)}/parse`), { sourceVersionId }, { idempotencyKey: intentKey });
      if (currentProjectId.current !== projectId || unavailableSourceIds.current.has(source.sourceId) || (sourceLifecycleEpochs.current.get(source.sourceId) ?? 0) !== lifecycleEpoch) return false;
      parseIntentKeys.current.delete(intentId);
      trackJob({ jobId: result.jobId, sourceId: source.sourceId, sourceVersionId, sourceTitle: source.title, fileId: sourceFileId(projectId, sourceVersionId), status: result.status === 'queued' ? 'queued' : undefined });
      setSuccessMessage('解析任务已提交。页面可见时每 2–10 秒查询一次，切换到其他标签页时会暂停。');
      void queryClient.invalidateQueries({ queryKey: ['sourceVersion', projectId, source.sourceId, sourceVersionId] });
      return true;
    } catch (error) {
      setActionError(error);
      return false;
    } finally {
      setParsingSourceId(null);
    }
  }, [projectId, queryClient, trackJob]);

  const retryJob = useCallback(async (tracked: TrackedSourceJob) => {
    if (unavailableSourceIds.current.has(tracked.sourceId)) return;
    const lifecycleEpoch = sourceLifecycleEpochs.current.get(tracked.sourceId) ?? 0;
    setActionError(null);
    try {
      const intentKey = retryIntentKeys.current.get(tracked.jobId) ?? createIntentKey();
      retryIntentKeys.current.set(tracked.jobId, intentKey);
      const result = await api.post<'JobRetryResponse'>(`/api/v1/jobs/${encodeURIComponent(tracked.jobId)}/retry`, undefined, { idempotencyKey: intentKey });
      if (currentProjectId.current !== projectId || unavailableSourceIds.current.has(tracked.sourceId) || (sourceLifecycleEpochs.current.get(tracked.sourceId) ?? 0) !== lifecycleEpoch) return;
      retryIntentKeys.current.delete(tracked.jobId);
      setTrackedJobs((items) => [{ ...tracked, jobId: result.jobId, status: 'queued' }, ...items.filter((item) => item.jobId !== tracked.jobId)]);
    } catch (error) {
      setActionError(error);
    }
  }, [projectId]);

  const scanPages = useCallback(async (tracked: TrackedSourceJob) => {
    if (!capability || unavailableSourceIds.current.has(tracked.sourceId)) return;
    const lifecycleEpoch = sourceLifecycleEpochs.current.get(tracked.sourceId) ?? 0;
    const ensureAvailable = () => {
      if (currentProjectId.current !== projectId || unavailableSourceIds.current.has(tracked.sourceId) || (sourceLifecycleEpochs.current.get(tracked.sourceId) ?? 0) !== lifecycleEpoch) throw new Error('资料状态已变化或已切换项目，页面处理已停止。');
    };
    setActionError(null);
    setScanJobId(tracked.jobId);
    setScanProgressSourceId(tracked.sourceId);
    setScanProgress('读取服务器待渲染页码…');
    try {
      const version = await api.get<'SourceVersionResponse'>(projectPath(projectId, `/sources/${encodeURIComponent(tracked.sourceId)}/versions/${encodeURIComponent(tracked.sourceVersionId)}`));
      ensureAvailable();
      const fileId = version.fileId ?? tracked.fileId ?? sourceFileId(projectId, tracked.sourceVersionId);
      if (!fileId) throw new Error('此来源版本未关联原 PDF 文件，无法生成扫描页。');
      rememberSourceFile(projectId, tracked.sourceVersionId, fileId);
      let pending = pageImagesIntentKeys.current.get(tracked.jobId);
      if (!pending) {
        const response = await api.get<'RenderRequestsResponse'>(projectPath(projectId, `/sources/${encodeURIComponent(tracked.sourceId)}/render-requests`), { sourceVersionId: tracked.sourceVersionId });
        ensureAvailable();
        const pageNumbers = response.items.map((item) => item.pageNumber);
        if (pageNumbers.length === 0) {
          await queryClient.invalidateQueries({ queryKey: ['sourceVersion', projectId, tracked.sourceId, tracked.sourceVersionId] });
          setScanProgress('服务端当前没有待渲染页码；已刷新逐页状态。');
          return;
        }
        setScanProgress(`正在读取来源 PDF（${pageNumbers.length} 页待处理）…`);
        const bytes = await downloadSourcePdf(projectId, fileId);
        ensureAvailable();
        const { iteratePdfPages } = await import('./source-pdf-render');
        const uploadedImages: Array<{pageNumber:number;fileId:string}>=[];
        for await(const image of iteratePdfPages(bytes,pageNumbers,{
          pageImageMaxEdge:capability.limits.pageImageMaxEdge,pageImageMaxBytes:capability.limits.pageImageMaxBytes,maxPdfPages:null,
        })) {
          ensureAvailable();setScanProgress(`正在上传第 ${image.pageNumber} 页图片…`);
          const imageFileId=await uploadProjectFile(projectId,image.file,undefined,undefined,{derivedFromFileId:fileId});
          uploadedImages.push({pageNumber:image.pageNumber,fileId:imageFileId});
          if(uploadedImages.length===100) {
            await api.post<'PageImagesResponse'>(projectPath(projectId,`/sources/${encodeURIComponent(tracked.sourceId)}/page-images`),{sourceVersionId:tracked.sourceVersionId,images:uploadedImages.splice(0)},{idempotencyKey:createIntentKey()});
          }
        }
        pending = {
          body: { sourceVersionId: tracked.sourceVersionId, images: uploadedImages },
          idempotencyKey: createIntentKey(),
        };
        pageImagesIntentKeys.current.set(tracked.jobId, pending);
      } else {
        setScanProgress('沿用上次提交的同一批页面图片和请求编号，确认服务端处理状态…');
      }
      ensureAvailable();
      if(pending.body.images.length===0){await queryClient.invalidateQueries({queryKey:['sourceVersion',projectId]});return;}
      const accepted = await api.post<'PageImagesResponse'>(projectPath(projectId, `/sources/${encodeURIComponent(tracked.sourceId)}/page-images`), pending.body, { idempotencyKey: pending.idempotencyKey });
      ensureAvailable();
      pageImagesIntentKeys.current.delete(tracked.jobId);
      if (accepted.jobId) {
        replaceTracked(tracked.jobId, { jobId: accepted.jobId, status: 'queued' });
        setScanProgress(`已接收 ${accepted.accepted} 页，OCR 任务已排队，剩余未提交页数 ${accepted.remaining}。`);
      } else {
        replaceTracked(tracked.jobId, { status: 'waiting_input' });
        setScanProgress(`已接收 ${accepted.accepted} 页，仍有 ${accepted.remaining} 页待处理。`);
      }
      await queryClient.invalidateQueries({ queryKey: ['sourceVersion', projectId, tracked.sourceId, tracked.sourceVersionId] });
    } catch (error) {
      setActionError(error);
      setScanProgress('页面处理未完成；已显示服务端错误，可确认状态后再次操作。');
    } finally {
      setScanJobId(null);
    }
  }, [capability, projectId, queryClient, replaceTracked]);

  const submitSource = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!capability) return;
    setActionError(null);
    setSuccessMessage('');
    setSubmitting(true);
    try {
      let body: Record<string, string>;
      let fileId: string | null = null;
      if (kind === 'paste') {
        if (!text.trim()) throw new Error('请填写来源原文。');
        body = { kind, text: text.trim() };
      } else if (kind === 'web') {
        if (!capability.features.webFetch) throw new Error('当前服务能力未启用网页读取；可改用粘贴原文或上传文件。');
        const parsedUrl = new URL(url.trim());
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('仅支持 HTTP 或 HTTPS 网页地址。');
        body = { kind, url: parsedUrl.toString() };
      } else {
        if (!file) throw new Error('请先选择 PDF、DOCX、TXT、Markdown 或音视频文件。');
        const mediaFile = /\.(mp3|wav|m4a|mp4|webm)$/i.test(file.name);
        const uploadLimit = mediaFile ? capability.limits.maxMediaBytes : capability.limits.maxFileBytes;
        const audioFile = /\.(mp3|wav|m4a)$/i.test(file.name);
        const mediaEnabled = audioFile ? (capability.features.audioTranscriptionEnabled ?? capability.features.mediaEnabled) : (capability.features.videoSummaryEnabled ?? capability.features.mediaEnabled);
        if (mediaFile && mediaEnabled === false) throw new Error('该媒体的处理能力尚未启用；音频可使用 Whisper，视频需要独立 Gemini 配置。');
        if (uploadLimit != null && file.size > uploadLimit) throw new Error(`文件大小超过服务端上限 ${formatBytes(uploadLimit)}。`);
        if (!/\.(pdf|docx|txt|md|mp3|wav|m4a|mp4|webm)$/i.test(file.name)) throw new Error('仅支持 PDF、DOCX、TXT、Markdown、MP3、WAV、M4A、MP4 或 WebM 文件。');
        const pendingMatches = pendingUpload?.file === file;
        if (pendingMatches) {
          fileId = pendingUpload.fileId;
        } else {
          setSubmitStage('初始化文件上传…');
          let fileInitIntentKey = fileInitIntentKeys.current.get(file);
          if (!fileInitIntentKey) {
            fileInitIntentKey = createIntentKey();
            fileInitIntentKeys.current.set(file, fileInitIntentKey);
          }
          fileId = await uploadProjectFile(projectId, file, fileInitIntentKey, () => { void queryClient.invalidateQueries({ queryKey: ['files', projectId] }); }, { contributorIds });
          if (unavailableFileIds.current.has(fileId)) {
            fileInitIntentKeys.current.delete(file);
            throw new Error('该文件已移入回收站，未继续登记来源。可恢复后手动处理，或重新上传。');
          }
          setPendingUpload({ fileId, file });
        }
        body = { kind, fileId };
      }
      if (title.trim()) body.title = title.trim();
      else if(kind==='file'&&file)body.title=file.name.slice(0,200);
      const sourceIntentId = JSON.stringify(body);
      let sourceIntentKey = sourceIntentKeys.current.get(sourceIntentId);
      if (!sourceIntentKey) {
        sourceIntentKey = createIntentKey();
        sourceIntentKeys.current.set(sourceIntentId, sourceIntentKey);
      }
      setSubmitStage(kind === 'file' ? '登记来源并发起解析…' : '登记来源并发起解析…');
      const source = await api.post<'SourceCreateResponse'>(projectPath(projectId, '/sources'), body, { idempotencyKey: sourceIntentKey });
      sourceIntentKeys.current.delete(sourceIntentId);
      setPendingUpload(null);
      if (file) fileInitIntentKeys.current.delete(file);
      if (fileId) rememberSourceFile(projectId, source.sourceVersionId, fileId);
      await queryClient.invalidateQueries({ queryKey: ['sources', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['resource-library', projectId] });
      setSubmitStage('启动解析任务…');
      let parseStarted=false;let browserNotice='';
      let browserSelected=kind==='file'&&file&&/\.(pdf|docx)$/i.test(file.name)&&(/\.docx$/i.test(file.name)||parseMode==='browser'||(parseMode==='auto'&&file.size>10*1024*1024));
      if(kind==='file'&&file&&/\.pdf$/i.test(file.name)&&parseMode==='auto'&&!browserSelected) {
        await import('./source-pdf-render');
        const {getDocument}=await import('pdfjs-dist');
        const task=getDocument({data:new Uint8Array(await file.arrayBuffer())});
        try {browserSelected=(await task.promise).numPages>30;} finally{await task.destroy();}
      }
      if(browserSelected&&file) {
        const abort=new AbortController();importAbort.current=abort;
        const result=await importBrowserFile(projectId,source.sourceVersionId,file,abort.signal,setSubmitStage);
        importAbort.current=null;browserNotice=(result.textReady?'本机正文已保存。':`正文部分完成，${result.needsImages} 页待补充。`)+(result.warnings.length?' '+result.warnings.join('；'):'');
        if(result.textReady&&capability.features.aiEnabled) {
          const job=await documentRequest<{jobId:string}>(projectPath(projectId,'/document-imports/analyze'),{method:'POST',body:{sourceVersionId:source.sourceVersionId}});
          trackJob({jobId:job.jobId,sourceId:source.sourceId,sourceVersionId:source.sourceVersionId,sourceTitle:source.title,fileId,status:'queued'});parseStarted=true;
        }
      } else if(!capability.features.aiEnabled&&kind==='file'&&file&&/\.pdf$/i.test(file.name)) {const job=await documentRequest<{jobId:string}>(projectPath(projectId,'/document-imports/extract'),{method:'POST',body:{sourceVersionId:source.sourceVersionId}});trackJob({jobId:job.jobId,sourceId:source.sourceId,sourceVersionId:source.sourceVersionId,sourceTitle:source.title,fileId,status:'queued'});parseStarted=true;}
      else if(capability.features.aiEnabled) parseStarted=await startParse({sourceId:source.sourceId,title:source.title},source.sourceVersionId);
      setText('');
      setUrl('');
      setTitle('');
      setFile(null);
      setSuccessMessage(browserNotice || (!capability.features.aiEnabled
        ? '来源已创建并保存。当前服务能力显示 AI 未启用，暂不能发起要求提取。'
        : parseStarted ? '来源已创建，解析任务已提交。' : '来源已创建，但解析请求未成功；请在来源列表中确认状态后重试解析。'));
    } catch (error) {
      setActionError(error);
    } finally {
      importAbort.current=null;
      setSubmitting(false);
      setSubmitStage('');
      void queryClient.invalidateQueries({ queryKey: ['files', projectId] });
    }
  };

  if (capabilityQuery.isLoading) return <div className="page-stack"><Spinner label="正在读取服务能力与文件限制" /></div>;
  if (capabilityQuery.error || !capability) return <div className="page-stack"><PageHeading eyebrow="项目资料" title="通知来源" detail="先读取服务能力，确定文件与页面图片限制后再导入。" /><ErrorNotice error={capabilityQuery.error ?? new Error('服务能力暂不可用。')} onRetry={() => void capabilityQuery.refetch()} /></div>;


  const canSubmit = !submitting && (kind !== 'web' || capability.features.webFetch);

  return <div className="page-stack sources-page">
    {!embedded && <PageHeading eyebrow="项目资料" title="通知来源" detail="导入可核对的通知原文。解析任务会生成待确认要求；所有记录和状态来自项目服务。" />}

    {!capability.features.aiEnabled ? <div className="callout warning-callout">AI 未启用。仍可读取文件正文；总结、要求提取与视觉 OCR 暂不可用。</div> : null}

    {(!embedded || intakeOnly) && <SectionCard title="导入资料" detail="支持粘贴原文、公开网页链接，以及 PDF/DOCX/TXT/Markdown 和音视频文件。">
      <form className="sources-intake" onSubmit={(event) => void submitSource(event)}>
        <div className="sources-intake-tabs" role="group" aria-label="来源类型">
          <button type="button" className="sources-intake-tab" aria-pressed={kind === 'paste'} onClick={() => setKind('paste')}><Type size={15} /> 粘贴文本</button>
          <button type="button" className="sources-intake-tab" aria-pressed={kind === 'web'} disabled={!capability.features.webFetch} onClick={() => setKind('web')}><Globe2 size={15} /> 网页链接</button>
          <button type="button" className="sources-intake-tab" aria-pressed={kind === 'file'} onClick={() => setKind('file')}><FileText size={15} /> 文件</button>
        </div>
        {!capability.features.webFetch ? <div className="callout warning-callout">网页读取当前不可用。请粘贴可核对的原文，或上传 PDF/TXT/Markdown 文件。</div> : null}
        {kind === 'paste' && <Field label="通知或项目资料原文" hint="内容会作为来源版本保存。不要添加未经原文支持的日期、权重或要求。"><textarea className="input textarea" rows={7} maxLength={100_000} value={text} onChange={(event) => setText(event.target.value)} placeholder="粘贴通知原文或公开项目资料…" /></Field>}
        {kind === 'web' && <>
          {!capability.features.webFetch && <div className="callout warning-callout">当前服务能力未启用网页读取。你仍可粘贴网页原文或上传文件。</div>}
          <Field label="公开网页地址" hint="网页是否可读取取决于后端网络与域名规则；失败时会显示服务端原因。"><input className="input" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.org/notice" disabled={!capability.features.webFetch} /></Field>
        </>}
        {kind === 'file' && <>
          <Field label="选择来源文件" hint="支持 PDF、DOCX、TXT、Markdown、MP3、WAV、M4A、MP4、WebM，没有应用层文件大小或文档页数上限。大文档建议本机解析，实际受设备和平台能力限制；音视频原文件由独立 Gemini 模型生成摘要，仍受供应商能力限制。">
            <input className="input" type="file" accept=".pdf,.docx,.txt,.md,.mp3,.wav,.m4a,.mp4,.webm,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,audio/mpeg,audio/wav,audio/mp4,video/mp4,video/webm" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPendingUpload(null); }} />
          </Field>
          <FileContributorPicker projectId={projectId} value={contributorIds} onChange={ids => { setContributorIds(ids); if (file) fileInitIntentKeys.current.delete(file); }} disabled={submitting || Boolean(pendingUpload)} />
          {file && <div className="callout">已选择 {file.name} · {formatBytes(file.size)}{pendingUpload?.file === file ? ' · 文件内容已上传，重试时会复用上传记录' : ''}</div>}
        </>}
        <Field label="来源标题（可选）"><input className="input" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} placeholder={kind === 'file' ? file?.name ?? '使用文件名' : kind === 'web' ? '使用网页标题' : '粘贴文本'} /></Field>
        {actionError ? <ErrorNotice error={actionError} /> : null}
        {successMessage && <div className="notice notice-success" role="status"><FilePlus2 size={17} /><div className="notice-copy"><strong>{successMessage}</strong></div></div>}
        {kind === 'file' && (!file || /\.(pdf|docx)$/i.test(file.name)) && <Field label="正文解析方式"><select className="input" value={parseMode} onChange={e=>setParseMode(e.target.value as typeof parseMode)}><option value="auto">自动建议：小 PDF 云端，大 PDF 本机；DOCX 本机</option><option value="cloud">云端读取文字型 PDF</option><option value="browser">本机读取 PDF / DOCX</option></select><p className="form-note">10 MiB / 30 页是建议切换阈值，不是导入上限。未读取的图片、公式等会明确提示。</p></Field>}
        {submitting && importAbort.current && <button type="button" className="button button-quiet" onClick={()=>importAbort.current?.abort()}>停止本机解析</button>}
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={!canSubmit || (kind === 'file' && (!file || contributorIds?.length === 0))}>{submitting ? <><LoaderCircle className="spin" size={15} /> {submitStage || '正在提交'}</> : <><Send size={15} /> {capability.features.aiEnabled ? '导入并开始解析' : '导入来源'}</>}</button><span className="sources-inline-note">按服务端单页上限分批读取完整来源列表。</span></div>
      </form>
    </SectionCard>}

    {!embedded && <ProjectFileLibrary key={projectId} projectId={projectId} pageSize={capability.limits.listMaxPageSize} onChanged={handleLifecycleChanged} />}
    {targetSourceVersionId && !sourceQuery.isLoading && !sources.some((source) => source.currentVersionId === targetSourceVersionId) ? <div className="callout warning-callout">引用对应的来源版本不在当前来源列表中，可能已移入回收站，或它不是当前版本。引用原句仍保留在要求条目中。</div> : null}
    {!intakeOnly && <section className="card section-card resource-source-card">
      {header}
      <div className="section-head"><div><h2>{embedded ? '资料原文与处理状态' : '已导入来源'}</h2><p>解析状态和逐页 OCR 状态由后端返回。</p></div></div>
      {sourceLifecycle.error ? <ErrorNotice error={sourceLifecycle.error} /> : null}
      {sourceLifecycle.message && <div className="notice notice-success" role="status"><div className="notice-copy"><strong>{sourceLifecycle.message}</strong></div></div>}
      {sourceQuery.isLoading ? <Spinner label="正在读取真实来源记录" /> : sourceQuery.error ? <ErrorNotice error={sourceQuery.error} onRetry={() => void sourceQuery.refetch()} /> : sources.length === 0 ? <EmptyState title="还没有来源记录" detail="导入一份通知或资料后，解析任务和人工确认的要求会在这里关联显示。" /> : <div className="sources-record-list">
        {sources.filter(source => !selectedSourceId || source.sourceId === selectedSourceId).map((source) => {
          const version = versionsBySourceId.get(source.sourceId);
          const target = Boolean(targetSourceVersionId && (source.currentVersionId === targetSourceVersionId || source.sourceId === selectedSourceId));
          return <SourceRecord hideTitle={Boolean(header && selectedSourceId)} key={source.sourceId} source={source} version={version} projectId={projectId} highlighted={target} highlightedPageNumber={target ? targetPageNumber : null} jobs={trackedJobs.filter((job) => job.sourceId === source.sourceId)} capability={capability} parsingSourceId={parsingSourceId} scanJobId={scanJobId} scanProgress={scanProgressSourceId === source.sourceId ? scanProgress : ''} onParse={(item, versionId) => void startParse(item, versionId)} onRetryJob={(job) => void retryJob(job)} onScan={(job) => void scanPages(job)} onJobUpdate={onJobUpdate} lifecycleBusy={sourceLifecycle.busy} onRemove={item => { const resource = sourceResources.find(resource => resource.id === item.sourceId); if (resource) void sourceLifecycle.changeLifecycle(resource, false); }} />;
        })}
      </div>}
      {versionQueries.some((query) => query.error) && <div className="stack">{versionQueries.map((query, index) => query.error ? <ErrorNotice key={index} error={query.error} onRetry={() => void query.refetch()} /> : null)}</div>}
    </section>}
  </div>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
