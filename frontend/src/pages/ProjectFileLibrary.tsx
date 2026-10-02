import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArchiveRestore, FileText, Trash2 } from 'lucide-react';
import type { DataOf } from '../api/types';
import { EmptyState, ErrorNotice, SectionCard, Spinner, StatusPill } from '../components/ui';
import { listAllProjectItems } from './source-workflows';
import { useSourceLifecycle, type LifecycleChange, type LifecycleResource } from './source-lifecycle';

type ProjectFile = DataOf<'FileListResponse'>['items'][number];
const statusLabels: Record<ProjectFile['status'], string> = { pending: '上传未完成', available: '文件已保存', quarantined: '文件校验未通过', discarded: '文件已弃用' };

export function ProjectFileLibrary({ projectId, pageSize, onChanged }: { projectId: string; pageSize: number; onChanged: (change: LifecycleChange) => void }) {
  const [view, setView] = useState<'active' | 'recycle'>('active');
  const deleted = view === 'recycle';
  const filesQuery = useQuery({
    queryKey: ['files', projectId, view],
    queryFn: ({ signal }) => listAllProjectItems<'FileListResponse'>(projectId, '/files', pageSize, signal, { deleted }),
    retry: false,
  });
  const recycledSourcesQuery = useQuery({
    queryKey: ['sources', projectId, 'recycle'],
    queryFn: ({ signal }) => listAllProjectItems<'SourceListResponse'>(projectId, '/sources', pageSize, signal, { deleted: true }),
    enabled: deleted,
    retry: false,
  });
  // File-linked sources are managed once through their original file, using the file lifecycle version.
  const recycledSources = (recycledSourcesQuery.data ?? []).filter(source => source.kind !== 'file' && !source.fileId);
  const files = filesQuery.data ?? [];
  const resources: LifecycleResource[] = [
    ...files.map(file => ({ kind: 'file' as const, id: file.fileId, name: file.name, lifecycleVersion: file.lifecycleVersion, canDelete: file.canDelete, deletedAt: file.deletedAt })),
    ...recycledSources.map(source => ({ kind: 'source' as const, id: source.sourceId, name: source.title, lifecycleVersion: source.lifecycleVersion, canDelete: source.canDelete, deletedAt: source.deletedAt })),
  ];
  const lifecycle = useSourceLifecycle(projectId, view, resources, onChanged);

  return <SectionCard title="文件库与回收站" className="sources-file-library" detail="上传尚未完成的文件也会保留在文件库中。移入回收站可停止关联处理，原文件与历史仍可恢复。" action={
    <div className="sources-library-tabs" role="group" aria-label="资料视图">
      <button type="button" className="sources-intake-tab" aria-pressed={!deleted} onClick={() => setView('active')}><FileText size={15} /> 文件库</button>
      <button type="button" className="sources-intake-tab" aria-pressed={deleted} onClick={() => setView('recycle')}><Trash2 size={15} /> 回收站</button>
    </div>
  }>
    {lifecycle.error ? <ErrorNotice error={lifecycle.error} /> : null}
    {lifecycle.message && <div className="notice notice-success" role="status"><div className="notice-copy"><strong>{lifecycle.message}</strong></div></div>}
    {deleted && <p className="sources-inline-note">恢复只恢复资料的可用状态，不会启动解析、OCR、要求提取或总结。已取消的任务不会自动重启。</p>}
    {filesQuery.isLoading ? <Spinner label={deleted ? '正在读取回收站文件' : '正在读取项目文件'} /> : filesQuery.error ? <ErrorNotice error={filesQuery.error} onRetry={() => void filesQuery.refetch()} /> : <div className="sources-library-list">
      {files.map(file => <article className="sources-library-record" key={file.fileId} aria-label={`文件：${file.name}`}>
        <div className="sources-library-copy"><h3>{file.name}</h3><div className="sources-record-meta"><StatusPill tone={file.status === 'available' ? 'good' : file.status === 'pending' ? 'warn' : 'neutral'}>{statusLabels[file.status]}</StatusPill><span>{file.sizeBytes === null ? '大小待上传后确认' : formatBytes(file.sizeBytes)}</span><span>{deleted && file.deletedAt ? `移入于 ${new Date(file.deletedAt).toLocaleString('zh-CN')}` : `创建于 ${new Date(file.createdAt).toLocaleString('zh-CN')}`}</span></div>
          {!deleted && <p className="sources-inline-note">{file.sourceIds.length ? `关联 ${file.sourceIds.length} 条来源；处理状态见下方来源记录` : '尚未关联来源，可直接移入回收站'}</p>}
        </div>
        {file.canDelete && <button type="button" className={`button button-small ${deleted ? 'button-quiet' : 'button-danger'}`} disabled={lifecycle.busy} onClick={() => void lifecycle.changeLifecycle(resources.find(item => item.kind === 'file' && item.id === file.fileId)!, deleted)} aria-label={`${deleted ? '恢复文件' : '移入回收站'}：${file.name}`}>
          {deleted ? <ArchiveRestore size={14} /> : <Trash2 size={14} />}{lifecycle.pendingKey === `file:${file.fileId}` ? '正在确认或处理…' : deleted ? '恢复文件' : '移入回收站'}
        </button>}
      </article>)}
    </div>}
    {deleted && (recycledSourcesQuery.isLoading ? <Spinner label="正在读取回收站文本与网页来源" /> : recycledSourcesQuery.error ? <ErrorNotice error={recycledSourcesQuery.error} onRetry={() => void recycledSourcesQuery.refetch()} /> : <div className="sources-library-list">
      {recycledSources.map(source => <article className="sources-library-record" key={source.sourceId} aria-label={`来源：${source.title}`}>
        <div className="sources-library-copy"><h3>{source.title}</h3><div className="sources-record-meta"><StatusPill>{source.kind === 'web' ? '网页' : '粘贴文本'}</StatusPill>{source.deletedAt && <span>移入于 {new Date(source.deletedAt).toLocaleString('zh-CN')}</span>}</div></div>
        {source.canDelete && <button type="button" className="button button-quiet button-small" disabled={lifecycle.busy} aria-label={`恢复来源：${source.title}`} onClick={() => void lifecycle.changeLifecycle(resources.find(item => item.kind === 'source' && item.id === source.sourceId)!, true)}><ArchiveRestore size={14} />{lifecycle.pendingKey === `source:${source.sourceId}` ? '正在确认或处理…' : '恢复来源'}</button>}
      </article>)}
    </div>)}
    {!filesQuery.isLoading && !filesQuery.error && (!deleted || (!recycledSourcesQuery.isLoading && !recycledSourcesQuery.error)) && files.length === 0 && (!deleted || recycledSources.length === 0) && <EmptyState title={deleted ? '回收站为空' : '还没有上传文件'} detail={deleted ? '移入回收站的原文件、文本与网页来源会显示在这里，可按权限恢复。' : '已初始化但尚未上传完成的文件也会显示在这里，无需等解析完成。'} />}
  </SectionCard>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
