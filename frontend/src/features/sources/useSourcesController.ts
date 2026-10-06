import { importBrowserFile, documentRequest } from '../../pages/document-import-client';
import { useSourceLifecycle, type LifecycleChange } from '../../pages/source-lifecycle';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, projectPath } from '../../api/client';
import { useProject } from '../../components/ProjectShell';
import { createIntentKey, downloadSourcePdf, readTrackedSourceJobs, rememberSourceFile, sourceFileId, uploadProjectFile, writeTrackedSourceJobs, type TrackedSourceJob } from '../../pages/source-workflows';
import type { SourceItem, Job, IntakeKind, PendingUpload, PendingPageImagesSubmission } from './types';
import { formatBytes } from './format';
import { useSourceQueries } from './useSourceQueries';

export function useSourcesController(selectedSourceId?: string) {
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

  const { capabilityQuery, capability, sourceQuery, sources, versionQueries, versionsBySourceId } = useSourceQueries(projectId, selectedSourceId, targetSourceVersionId);
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
        const { iteratePdfPages } = await import('../../pages/source-pdf-render');
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
        const mediaEnabled = audioFile ? (capability.features.audioSummaryEnabled ?? capability.features.audioTranscriptionEnabled ?? capability.features.mediaEnabled) : (capability.features.videoSummaryEnabled ?? capability.features.mediaEnabled);
        if (mediaFile && mediaEnabled === false) throw new Error('该媒体所选处理路径尚未配置，请在管理员设置中配置 Whisper、Gemini 或 MiMo。原文件将保留。');
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
        await import('../../pages/source-pdf-render');
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

  return { projectId, capabilityQuery, capability, sourceQuery, sources, versionQueries, versionsBySourceId, targetSourceVersionId, targetPageNumber, kind, setKind, title, setTitle, text, setText, url, setUrl, file, setFile, parseMode, setParseMode, importAbort, contributorIds, setContributorIds, pendingUpload, setPendingUpload, submitting, submitStage, actionError, successMessage, parsingSourceId, trackedJobs, scanJobId, scanProgressSourceId, scanProgress, fileInitIntentKeys, sourceResources, sourceLifecycle, handleLifecycleChanged, startParse, retryJob, scanPages, onJobUpdate, submitSource };
}
