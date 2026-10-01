import { useSyncExternalStore } from 'react';
import { Monitor } from 'lucide-react';

function subscribe(listener: () => void) {
  window.addEventListener('office-theme-change', listener);
  return () => window.removeEventListener('office-theme-change', listener);
}
function snapshot() { return document.documentElement.dataset.themePreference ?? 'system'; }

export function ThemeSelector({ variant = 'toolbar' }: { variant?: 'toolbar' | 'field' }) {
  const preference = useSyncExternalStore(subscribe, snapshot, () => 'system');
  return <div className={`theme-control theme-control-${variant}`}><label className={variant === 'field' ? 'field' : 'theme-selector'}>
    {variant === 'toolbar' && <Monitor size={16} aria-hidden="true" />}
    <span className={variant === 'field' ? 'field-label' : 'theme-label'}>主题</span>
    <select className="input" aria-label="主题" value={preference} onChange={event => window.dispatchEvent(new CustomEvent('office-theme-select', { detail: event.target.value }))}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select>
  </label></div>;
}
