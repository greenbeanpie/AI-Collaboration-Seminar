import { useState, useSyncExternalStore } from 'react';
import { getInstallState, promptInstall, subscribe } from '../pwa-install';

const DISMISSED_KEY = 'ai-office:install-banner-dismissed';
// Storage can be unavailable; preserve dismissal across route remounts anyway.
let dismissedInMemory = false;
function wasDismissed(): boolean {
  try { return dismissedInMemory || sessionStorage.getItem(DISMISSED_KEY) === '1'; }
  catch { return dismissedInMemory; }
}

export function PwaInstallBanner() {
  const { canInstall } = useSyncExternalStore(subscribe, getInstallState);
  const [dismissed, setDismissed] = useState(wasDismissed);
  if (!canInstall || dismissed) return null;
  function dismiss() {
    dismissedInMemory = true;
    setDismissed(true);
    try { sessionStorage.setItem(DISMISSED_KEY, '1'); } catch { /* Closing still works without storage. */ }
  }
  return <div className="install-banner">
    <span>安装到桌面可获得独立窗口和离线入口。</span>
    <button type="button" className="button button-quiet button-small" onClick={() => void promptInstall()}>安装到桌面</button>
    <button type="button" className="button button-quiet button-small" aria-label="关闭安装提示" onClick={dismiss}>关闭</button>
  </div>;
}
