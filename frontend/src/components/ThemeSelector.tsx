import { useSyncExternalStore } from 'react';
import { Monitor } from 'lucide-react';

function subscribe(listener: () => void) {
  window.addEventListener('office-theme-change', listener);
  return () => window.removeEventListener('office-theme-change', listener);
}
function snapshot() { return document.documentElement.dataset.themePreference ?? 'system'; }

export function ThemeSelector() {
  const preference = useSyncExternalStore(subscribe, snapshot, () => 'system');
  return <div className="theme-toolbar"><label className="theme-selector"><Monitor size={16} aria-hidden="true" /><span>主题</span><select aria-label="主题" value={preference} onChange={event => window.dispatchEvent(new CustomEvent('office-theme-select', { detail: event.target.value }))}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label></div>;
}
