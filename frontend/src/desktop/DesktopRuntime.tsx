import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { DESKTOP_PROTOCOL, desktopInvoke, isDesktop, setNativePlatform, type DesktopHello } from './bridge';
import { desktopSafeToReload, markDesktopReady } from './lifecycle';

export function DesktopRuntime() {
  const location = useLocation();
  const [error, setError] = useState('');
  useEffect(() => { window.dispatchEvent(new Event('desktop-route-changed')); }, [location.pathname, location.search]);
  useEffect(() => {
    if (!isDesktop()) return;
    let mounted = true;
    void desktopInvoke<DesktopHello>('desktop_hello').then(hello => {
      if (mounted && hello.protocol !== DESKTOP_PROTOCOL) setError('网页与客户端版本不兼容，请安装新版客户端。');
      if (mounted && hello.protocol === DESKTOP_PROTOCOL) { setNativePlatform(hello.platform); markDesktopReady(); }
    }).catch(() => { if (mounted) setError('客户端连接未完成，请更新或重新打开客户端。'); });
    const failure = (event: Event) => setError(String((event as CustomEvent<string>).detail));
    const blocked = (event: Event) => setError((event as CustomEvent<{ message?: string }>).detail?.message ?? '请先保存编辑并等待传输完成，再从托盘退出。');
    window.addEventListener('desktop-bridge-error', failure);
    window.addEventListener('desktop-exit-blocked', blocked);
    return () => { mounted = false; window.removeEventListener('desktop-bridge-error', failure); window.removeEventListener('desktop-exit-blocked', blocked); };
  }, []);
  return error ? <p className="notice notice-warn" role="alert">{error}</p> : null;
}

export function DesktopSettings() {
  const [hello, setHello] = useState<DesktopHello>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => { setHello(await desktopInvoke<DesktopHello>('desktop_hello')); };
  useEffect(() => {
    if (!isDesktop()) return;
    void refresh().catch(() => setMessage('暂时无法读取客户端状态。'));
    const updated = () => { void refresh().catch(() => {}); };
    window.addEventListener('desktop-update-state', updated);
    return () => window.removeEventListener('desktop-update-state', updated);
  }, []);
  if (!isDesktop()) return null;
  if (hello?.platform === 'android') return <section className="delivery-card" data-desktop-managed><h2>Android 客户端</h2><p>版本 {hello.version}。离线附件保存在此设备；进入后台暂停传输，返回前台后恢复。请使用同一签名的新版 APK 覆盖安装以保留本地数据。</p><p>通知可在应用内查看，后台不常驻轮询。</p></section>;
  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true); setMessage('');
    try { await operation(); await refresh(); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <section className="delivery-card" data-desktop-managed><h2>Windows 客户端</h2>
    <p>版本 {hello?.version ?? '读取中'}。关闭窗口后保留托盘，每分钟检查通知；退出后停止后台任务。</p>
    {hello && <p role="status">{({ idle: '等待检查更新', checking: '正在检查更新', downloading: '正在后台下载更新', ready: '更新已下载，重启后生效', current: '当前已是最新版本', installing: '正在安装更新', error: '更新暂未完成' })[hello.updateState.phase]}{hello.updateState.version ? ` · ${hello.updateState.version}` : ''}{hello.updateState.phase === 'downloading' ? ` · ${(hello.updateState.downloadedBytes / 1048576).toFixed(1)} MiB` : ''}</p>}
    {hello?.updateState.error && <p role="alert">{hello.updateState.error}</p>}
    <label><input type="checkbox" checked={hello?.autoRestart ?? false} disabled={!hello || busy} onChange={event => { void run(() => desktopInvoke('desktop_set_auto_restart', { enabled: event.target.checked }), '自动重启设置已保存。'); }} />托盘安全空闲时自动重启安装已下载更新</label>
    <div className="notification-buttons"><button type="button" disabled={busy} onClick={() => void run(() => desktopInvoke('desktop_check_update'), '更新检查已完成。新版会自动下载，准备好后可重启。')}>检查客户端更新</button>
      <button type="button" disabled={busy || hello?.updateState.phase !== 'ready'} onClick={() => void run(async () => { if (!desktopSafeToReload()) throw new Error('请先保存编辑并等待传输完成；未保存的表单请保存后返回项目列表。'); await desktopInvoke('desktop_restart_update'); }, '已请求安全重启。')}>重启安装更新</button></div>
    {message && <p role="status" style={{ whiteSpace: 'pre-wrap' }}>{message}</p>}
  </section>;
}
