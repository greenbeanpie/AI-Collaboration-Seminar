import { useEffect, useRef, useState } from 'react';
import { listAllItems, projectPath } from '../api/client';
import { ErrorNotice } from '../components/ui';
import { confirmPage } from '../dialogs/dialog-service';
import { prepareProject } from '../offline/sync';
import { cacheProjectFiles, estimateCache, exportDesktopFile, listDesktopFiles, pauseDesktopFile, removeDesktopFile, resumeDesktopFile, stageDesktopFiles, transferDesktopFiles, type CacheFile, type DesktopFile } from './attachments';

export function DesktopFilesPanel({ projectId, taskId, disabled = false, onBusy, onComplete }: { projectId: string; taskId?: string; disabled?: boolean; onBusy?: (busy: boolean, reason?: string) => void; onComplete?: () => void }) {
  const [rows, setRows] = useState<DesktopFile[]>([]), [error, setError] = useState<unknown>(), [running, setRunning] = useState(false), [preview, setPreview] = useState<CacheFile[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const completed = useRef(onComplete);
  useEffect(() => { completed.current = onComplete; }, [onComplete]);
  useEffect(() => {
    let live = true;
    let signature: string | undefined;
    const refresh = () => { if (document.visibilityState === 'hidden') return; void listDesktopFiles(projectId).then(next => { if (live) { setRows(next); const nextSignature = next.filter(row => row.direction === 'upload' && row.status === 'complete').map(row => row.id).sort().join(','); if (signature !== undefined && signature !== nextSignature) completed.current?.(); signature = nextSignature; } }).catch(failure => { if (live) setError(failure); }); };
    refresh(); window.addEventListener('desktop-transfer-refresh', refresh); document.addEventListener('visibilitychange', refresh); const timer = setInterval(refresh, 3000); return () => { live = false; clearInterval(timer); window.removeEventListener('desktop-transfer-refresh', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [projectId]);
  const pending = rows.some(row => row.direction === 'upload' && row.taskId === taskId && row.status !== 'complete');
  useEffect(() => { onBusy?.(running || pending, pending ? '本机附件尚未上传并入库，提交将保存在本机等待附件完成。' : running ? '正在保存附件。' : ''); }, [onBusy, pending, running]);
  const run = async (action: () => Promise<unknown>) => { setError(undefined); setRunning(true); try { await action(); setRows(await listDesktopFiles(projectId)); onComplete?.(); } catch (failure) { setError(failure); } finally { setRunning(false); } };
  const downloadPreview = async () => { const files = await listAllItems<'FileListResponse'>(projectPath(projectId, '/files')); const available = files.filter(file => file.status === 'available' && !file.deletedAt).map(file => ({ fileId: file.fileId, name: file.name, sizeBytes: file.sizeBytes ?? 0 })); setPreview(available); setSelectedIds(available.map(file => file.fileId)); };
  const selection = (preview ?? []).filter(file => selectedIds.includes(file.fileId));
  const shown = rows.filter(row => !taskId || row.taskId === taskId || row.direction === 'download');
  return <section className="stack" aria-label="本机离线文件"><h3>本机离线文件</h3><p className="form-note">文件存放在此设备，按登录账户隔离。上传完成并加入材料库后才会参与任务提交。</p><div className="form-actions">
    <button type="button" className="button" disabled={disabled || running} onClick={() => void run(async () => { await stageDesktopFiles(projectId, taskId); if (navigator.onLine) await transferDesktopFiles(projectId); })}>添加本机附件</button>
    <button type="button" className="button button-quiet" disabled={running || !navigator.onLine} onClick={() => void run(() => transferDesktopFiles(projectId))}>继续传输</button>
    {!taskId && <button type="button" className="button button-quiet" disabled={running || !navigator.onLine} onClick={() => void run(downloadPreview)}>下载整个项目</button>}
  </div>{preview && <div className="callout"><p>本次下载 {estimateCache(selection).count} 个文件，预计 {(estimateCache(selection).sizeBytes / 1048576).toFixed(1)} MiB。确认后同时保存完整项目文本快照；后续新增文件需再次下载。</p>{preview.map(file => <label className="field" key={file.fileId}><input type="checkbox" checked={selectedIds.includes(file.fileId)} onChange={event => setSelectedIds(current => event.target.checked ? [...current, file.fileId] : current.filter(id => id !== file.fileId))}/>{file.name}</label>)}<button type="button" className="button" disabled={running} onClick={() => void run(async () => { await prepareProject(projectId); await cacheProjectFiles(projectId, selection); setPreview(null); await transferDesktopFiles(projectId); })}>确认下载</button><button type="button" className="button button-quiet" onClick={() => setPreview(null)}>取消</button></div>}
  <p className="form-note">当前项目本机文件合计 {(rows.reduce((sum, row) => sum + (row.direction === 'upload' ? row.sizeBytes : row.transferredBytes), 0) / 1048576).toFixed(1)} MiB</p>
  {shown.map(row => <article className="callout" key={row.id}><strong>{row.name}</strong><p role="status">{row.direction === 'upload' ? '上传' : '下载'} · {({ waiting: '等待传输', transferring: '正在传输', paused: '已暂停', failed: '失败，内容已保留', complete: '完成' })[row.status]} · {(row.transferredBytes / 1048576).toFixed(1)} / {(row.sizeBytes / 1048576).toFixed(1)} MiB</p>{row.error && <p role="alert">{row.error}</p>}<div className="form-actions">{row.status !== 'complete' && <button type="button" className="button button-quiet" onClick={() => void run(() => row.status === 'transferring' || row.status === 'waiting' ? pauseDesktopFile(projectId, row.id) : resumeDesktopFile(projectId, row.id))}>{row.status === 'transferring' || row.status === 'waiting' ? '暂停' : '恢复'}</button>}{row.status === 'complete' && <button type="button" className="button button-quiet" onClick={() => void run(() => exportDesktopFile(projectId, row.id))}>导出 / 离线查看</button>}<button type="button" className="button button-quiet" onClick={() => void run(async () => { const discard = row.direction === 'upload' && row.status !== 'complete'; if (discard && !await confirmPage('此附件尚未上传。确认放弃并删除此本机副本？')) return; await removeDesktopFile(projectId, row.id, discard); })}>{row.direction === 'upload' && row.status !== 'complete' ? '放弃此附件' : '清理缓存'}</button></div></article>)}{error != null && <ErrorNotice error={error}/>}</section>;
}
