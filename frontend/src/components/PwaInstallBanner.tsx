import { useEffect, useState, useSyncExternalStore } from 'react';
import { getInstallState, subscribe } from '../pwa-install';

const SHOWN_KEY = 'ai-office:install-banner-shown';
let shownInMemory = false;
function wasShown(): boolean {
  try { return shownInMemory || sessionStorage.getItem(SHOWN_KEY) === '1'; }
  catch { return shownInMemory; }
}

const DISMISSED_KEY = 'ai-office:install-banner-dismissed';
// Session storage is the only dismissal record; its absence is treated as not dismissed.
function wasDismissed(): boolean {
  try { return sessionStorage.getItem(DISMISSED_KEY) === '1'; }
  catch { return false; }
}

export function PwaInstallBanner() {
  const { canInstall } = useSyncExternalStore(subscribe, getInstallState);
  const [dismissed] = useState(wasDismissed);
  const [firstVisit] = useState(() => !wasShown());
  useEffect(() => {
    if (!canInstall || dismissed || !firstVisit) return;
    shownInMemory = true;
    try { sessionStorage.setItem(SHOWN_KEY, '1'); } catch { /* Keep the in-memory session fallback. */ }
    window.dispatchEvent(new CustomEvent('app-notification', { detail: { id: 'install', text: '安装到桌面可获得独立窗口和离线入口。', action: 'install' } }));
  }, [canInstall, dismissed, firstVisit]);
  return null;
}
