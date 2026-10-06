import type { ReactNode } from 'react';
import { EmptyState, ErrorNotice, PageHeading, Spinner } from '../components/ui';
import { ProjectFileLibrary } from './ProjectFileLibrary';
import { SourceRecord } from '../features/sources/SourceRecord';
import { SourceIntake } from '../features/sources/SourceIntake';
import { useSourcesController } from '../features/sources/useSourcesController';
import './SourcesPage.css';

export { SourceRecord } from '../features/sources/SourceRecord';

export function SourcesPage({ embedded = false, selectedSourceId, intakeOnly = false, header }: { header?: ReactNode; embedded?: boolean; selectedSourceId?: string; intakeOnly?: boolean }) {
  const model = useSourcesController(selectedSourceId);
  const { projectId, capabilityQuery, capability, sourceQuery, sources, versionQueries, versionsBySourceId, targetSourceVersionId, targetPageNumber, parsingSourceId, trackedJobs, scanJobId, scanProgressSourceId, scanProgress, sourceResources, sourceLifecycle, handleLifecycleChanged, startParse, retryJob, scanPages, onJobUpdate } = model;
  if (capabilityQuery.isLoading) return <div className="page-stack"><Spinner label="正在读取服务能力与文件限制" /></div>;
  if (capabilityQuery.error || !capability) return <div className="page-stack"><PageHeading eyebrow="项目资料" title="通知来源" detail="先读取服务能力，确定文件与页面图片限制后再导入。" /><ErrorNotice error={capabilityQuery.error ?? new Error('服务能力暂不可用。')} onRetry={() => void capabilityQuery.refetch()} /></div>;




  return <div className="page-stack sources-page">
    {!embedded && <PageHeading eyebrow="项目资料" title="通知来源" detail="导入可核对的通知原文。解析任务会生成待确认要求；所有记录和状态来自项目服务。" />}

    {!capability.features.aiEnabled ? <div className="callout warning-callout">AI 未启用。仍可读取文件正文；总结、要求提取与视觉 OCR 暂不可用。</div> : null}

    {(!embedded || intakeOnly) && <SourceIntake model={model} />}

    {!embedded && <ProjectFileLibrary key={projectId} projectId={projectId} pageSize={capability.limits.listMaxPageSize} onChanged={handleLifecycleChanged} />}
    {targetSourceVersionId && !sourceQuery.isLoading && !sources.some((source) => source.currentVersionId === targetSourceVersionId) ? <div className="callout warning-callout">引用对应的来源版本不在当前来源列表中，可能已移入回收站，或它不是当前版本。引用原句仍保留在要求条目中。</div> : null}
    {!intakeOnly && <section className="card section-card resource-source-card">
      {header}
      <div className="section-head"><div><h2>{embedded ? '资料原文与处理状态' : '已导入来源'}</h2><p>原文件关联来源版本，解析正文与项目标准引用可逐项核对。</p></div></div>
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
