import { AiReferenceBadge } from '../components/AiReferenceBadge';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listAllItems, projectPath } from '../api/client';
import { projectRequest } from '../api/simplification';
import { ErrorNotice, Spinner } from '../components/ui';
import { uploadProjectFile } from './source-workflows';
import { archiveFile, archiveMaterial, listTaskFiles, taskFilesKey, type TaskFile } from './task-files-client';

type PendingUpload = { key: string; file: File; initializedId?: string; uploadedId?: string; replace?: TaskFile; state: 'waiting' | 'uploading' | 'failed' | 'done'; error?: unknown };
export function TaskFileUploads({ projectId, taskId, disabled, onBusy }: { projectId: string; taskId: string; disabled: boolean; onBusy: (busy: boolean) => void }) {
  const client = useQueryClient();
  const files = useQuery({ queryKey: taskFilesKey(projectId, taskId), queryFn: () => listTaskFiles(projectId, taskId) });
  const [pending, setPending] = useState<PendingUpload[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [archived, setArchived] = useState(false);
  const executing = useRef(false);
  const unresolved = pending.some(item => item.state !== 'done');
  useEffect(() => { onBusy(busy || unresolved || files.isPending || files.isError); }, [busy, unresolved, files.isPending, files.isError, onBusy]);
  const refresh = async () => { await Promise.all(['task-files', 'material', 'materials', 'materialVersions', 'resource-library', 'files'].map(key => client.invalidateQueries({ queryKey: [key, projectId] }))); };
  const setRow = (key: string, changes: Partial<PendingUpload>) => setPending(rows => rows.map(row => row.key === key ? { ...row, ...changes } : row));
  const upload = async (rows: PendingUpload[]) => {
    if (executing.current) return;
    executing.current = true; setBusy(true); setError(undefined);
    try {
      for (const row of rows) {
        setRow(row.key, { state: 'uploading', error: undefined });
        try {
          // A successfully uploaded object is reused when registration needs retrying.
          let storedId = row.uploadedId;
          if (!storedId && row.initializedId) {
            const existing = await listAllItems<'FileListResponse'>(projectPath(projectId, '/files'));
            if (existing.some(file => file.fileId === row.initializedId && file.status === 'available' && !file.archivedAt)) storedId = row.initializedId;
          }
          const fileId = storedId ?? await uploadProjectFile(projectId, row.file, row.key, initializedId => { row.initializedId = initializedId; setRow(row.key, { initializedId }); });
          row.uploadedId = fileId; setRow(row.key, { uploadedId: fileId });
          await projectRequest(projectId, `/tasks/${taskId}/files${row.replace ? `/${row.replace.materialId}` : ''}`, {
            method: row.replace ? 'PUT' : 'POST', body: { fileId, ...(row.replace ? { expectedRevision: row.replace.revision } : {}) }, idempotencyKey: row.key,
          });
          setRow(row.key, { state: 'done' });
        } catch (failure) { setRow(row.key, { state: 'failed', error: failure }); }
      }
      await refresh();
    } catch (failure) { setError(failure); }
    finally { executing.current = false; setBusy(false); }
  };
  const enqueue = (selected: FileList | null, replace?: TaskFile) => {
    if (!selected?.length || executing.current) return;
    if (!replace && selected.length + (files.data ?? []).filter(file => !file.archivedAt && !file.materialArchivedAt && !file.deletedAt).length > 10) { setError(new Error('每轮最多提交 10 个文件，请减少选择或归档旧文件。')); return; }
    const rows = Array.from(selected).map(file => ({ key: crypto.randomUUID(), file, replace, state: 'waiting' as const }));
    setPending(current => [...current, ...rows]); void upload(rows);
  };
  const changeArchive = async (file: TaskFile) => {
    if (executing.current) return;
    executing.current = true; setBusy(true); setError(undefined);
    try {
      if (file.materialArchivedAt) await archiveMaterial(projectId, file.materialId, file.revision, true);
      else await archiveFile(projectId, file.fileId, file.lifecycleVersion, !!file.archivedAt);
      await refresh();
    } catch (failure) { setError(failure); }
    finally { executing.current = false; setBusy(false); }
  };
  const active = (files.data ?? []).filter(file => !file.archivedAt && !file.materialArchivedAt && !file.deletedAt);
  const archivedFiles = (files.data ?? []).filter(file => !file.deletedAt && (file.archivedAt || file.materialArchivedAt));
  const shown = archived ? archivedFiles : active;
  return <section className="stack task-file-uploads" aria-label="任务成果文件">
    <h3>成果文件<AiReferenceBadge ariaHidden /></h3><p className="form-note">上传后自动加入材料库。本轮采用未归档文件的最新固定版本，之后更新不会改变历史提交。也可仅提交文字说明。</p>
    <label className="field">上传成果文件<AiReferenceBadge ariaHidden /><input type="file" multiple disabled={disabled || busy || unresolved || active.length >= 10} onChange={event => { enqueue(event.target.files); event.target.value = ''; }}/></label>
    {files.isPending && <Spinner label="读取任务文件"/>}{files.error && <ErrorNotice error={files.error} onRetry={() => void files.refetch()}/>}
    <div className="form-actions"><button type="button" className="button button-quiet button-small" aria-pressed={!archived} onClick={() => setArchived(false)}>当前文件（{active.length}）</button><button type="button" className="button button-quiet button-small" aria-pressed={archived} onClick={() => setArchived(true)}>已归档（{archivedFiles.length}）</button></div>
    {shown.map(file => <article className="callout stack" key={file.materialId}><a href={projectPath(projectId, `/files/${file.fileId}/content`)} download={file.name}>{file.name}</a><AiReferenceBadge />{(file.archivedAt || file.materialArchivedAt) && <small>已归档 · 只读</small>}{file.canManage && <div className="form-actions">{!archived && <label className="field">更新文件：{file.name}<AiReferenceBadge ariaHidden /><input type="file" disabled={disabled || busy || unresolved} onChange={event => { enqueue(event.target.files, file); event.target.value = ''; }}/></label>}<button type="button" className="button button-quiet button-small" disabled={disabled || busy || unresolved} onClick={() => void changeArchive(file)}>{file.materialArchivedAt ? '撤销材料归档' : file.archivedAt ? '撤销文件归档' : '归档文件'}</button></div>}</article>)}
    {!shown.length && !files.isPending && <p className="form-note">{archived ? '没有已归档文件。' : '暂无任务文件。'}</p>}
    {pending.filter(row => row.state !== 'done').map(row => <article className="callout" key={row.key}><strong>{row.file.name}<AiReferenceBadge ariaHidden /></strong><p role="status">{row.state === 'uploading' ? '正在上传并加入材料库…' : row.state === 'failed' ? '上传或入库失败，文件与草稿已保留。' : '等待上传'}</p>{row.error != null && <ErrorNotice error={row.error}/>}<button type="button" className="button" disabled={busy} onClick={() => void upload([{ ...row, state: 'waiting' }])}>重试</button><button type="button" className="button button-quiet" disabled={busy} onClick={() => setPending(rows => rows.filter(item => item.key !== row.key))}>移除待上传项</button></article>)}
    {active.length > 10 && <p role="alert">每轮最多提交 10 个文件，请归档不参与本轮的文件。</p>}
    {error != null && <ErrorNotice error={error}/>}
  </section>;
}
