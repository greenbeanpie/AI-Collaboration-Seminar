import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { operations, type PendingOperation } from './store';
import { prepareProject, resolveOperation, synchronizeOffline } from './sync';
import { confirmPage } from '../dialogs/dialog-service';
import { docToMarkdown } from '../pages/TasksMaterialsShared';
import './offline.css';

function preview(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const row = value as Record<string, unknown>;
  if (row.currentVersion) return preview(row.currentVersion);
  return [row.title, row.detail, row.criteria, row.body, row.markdown ?? (row.doc ? docToMarkdown(row.doc) : null)].filter(item => typeof item === 'string').join('\n\n');
}
export function OfflineWorkspaceStatus({ accountId }: { accountId: string }) {
  const location = useLocation();
  const projectId = location.pathname.match(/\/projects\/([^/]+)/)?.[1] ?? '';
  const client = useQueryClient();
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState<PendingOperation[]>([]);
  const syncing = useRef(new Map<string, Promise<void>>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    try { setPending(await operations(accountId)); }
    catch { setError('浏览器无法保存离线数据，请检查存储设置。'); }
  }, [accountId]);
  const sync = useCallback(() => {
    if (!navigator.onLine) return Promise.resolve();
    const key = `${accountId}:${projectId}`;
    const existing = syncing.current.get(key);
    if (existing) return existing;
    const run = async () => {
      setBusy(true); setError('');
      try { await synchronizeOffline(); if (projectId) await prepareProject(projectId); await client.invalidateQueries(); }
      catch (failure) { setError(failure instanceof Error ? failure.message : '同步失败，本机内容已保留'); }
      finally { setBusy(false); await reload(); }
    };
    const promise = run().finally(() => { syncing.current.delete(key); });
    syncing.current.set(key, promise);
    return promise;
  }, [accountId, client, projectId, reload]);
  useEffect(() => {
    void reload();
    const refresh = () => { if (navigator.onLine && document.visibilityState !== 'hidden') { setOnline(true); void sync(); } };
    const onOffline = () => setOnline(false);
    const onChanged = () => { void reload(); };
    const onFailure = () => setError('本机缓存写入失败；当前内容尚不能保证离线可用。');
    window.addEventListener('online', refresh); window.addEventListener('offline', onOffline);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    window.addEventListener('offline-data-changed', onChanged); window.addEventListener('offline-sync-completed', onChanged);
    window.addEventListener('offline-storage-failed', onFailure); window.addEventListener('offline-sync-retry', refresh);
    refresh();
    return () => {
      window.removeEventListener('online', refresh); window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('offline-data-changed', onChanged); window.removeEventListener('offline-sync-completed', onChanged);
      window.removeEventListener('offline-storage-failed', onFailure); window.removeEventListener('offline-sync-retry', refresh);
    };
  }, [reload, sync]);
  const resolve = async (row: PendingOperation, choice: 'server' | 'local') => {
    if (!await confirmPage(choice === 'local' ? '已核对两份内容，确认以本机内容作为新版本提交？仍会检查当前权限和版本。' : '确认放弃这项本机待同步操作，使用服务端内容？')) return;
    try { await resolveOperation(row, choice); await sync(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '处理失败，本机内容已保留'); }
  };
  if (online && !pending.length && !error) return null;
  return <section className="offline-workspace-status" aria-label="离线工作与同步">
    <div role="status"><strong>{!online ? '离线工作台' : busy ? '同步中…' : '本机操作待同步'}</strong>
      {!online && <span>正在使用本机快照，联网后自动同步；AI 和审批需联网完成。</span>}
      {pending.length > 0 && <span>{pending.length} 项本机操作待同步</span>}
    </div>
    {online && (pending.length > 0 || error) && <button className="button button-small" disabled={busy} onClick={() => void sync()}>重试同步</button>}
    {error && <p role="alert" style={{whiteSpace:'pre-wrap'}}>{error}</p>}
    {pending.some(row => row.state !== 'pending') && <details><summary>查看需要处理的本机操作</summary>{pending.filter(row => row.state !== 'pending').map(row => <article key={row.key}>
      <strong>{row.state === 'conflict' ? '内容存在冲突' : '操作未获服务端接受'}</strong><p style={{whiteSpace:'pre-wrap'}}>{row.error}</p>
      <div className="offline-conflict-copies"><div><h3>本机内容</h3><pre>{preview(row.body) || '本机任务操作已保留'}</pre></div><div><h3>服务端内容</h3><pre>{preview(row.server) || '请在原页面核对最新内容'}</pre></div></div>
      <button className="button button-quiet button-small" disabled={busy} onClick={() => void resolve(row, 'server')}>使用服务端内容</button>
      {row.state === 'conflict' && ['PUT', 'PATCH'].includes(row.method) && <button className="button button-small" disabled={!online || busy} onClick={() => void resolve(row, 'local')}>已核对，提交本机内容</button>}
    </article>)}</details>}
  </section>;
}
