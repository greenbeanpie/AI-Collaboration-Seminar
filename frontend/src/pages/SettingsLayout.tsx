import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useBlocker, useLocation } from 'react-router-dom';
import { useSession } from '../auth';
import { SettingsDirtyContext } from './settings-dirty';
import './SettingsLayout.css';

export function SettingsLayout() {
  const session = useSession();
  const location = useLocation();
  const edits = useRef(new Set<string>());
  const [dirty, setDirty] = useState(false);
  const reportDirty = useCallback((id: string, changed: boolean) => {
    if (changed) edits.current.add(id); else edits.current.delete(id);
    setDirty(edits.current.size > 0);
  }, []);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => edits.current.size > 0 && Boolean(session.data) &&
    currentLocation.pathname + currentLocation.search + currentLocation.hash !== nextLocation.pathname + nextLocation.search + nextLocation.hash);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('设置有尚未保存的编辑。确定放弃这些编辑并离开吗？')) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    let confirmedUpdate = false;
    const updateConfirmed = () => { confirmedUpdate = true; };
    const unload = (event: BeforeUnloadEvent) => { if (confirmedUpdate) return; event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', unload);
    window.addEventListener('app-update-reload', updateConfirmed);
    return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('app-update-reload', updateConfirmed); };
  }, [dirty]);
  useEffect(() => {
    let pendingEdits: Set<string> | null = null;
    const beforeLeave = (event: Event) => {
      if (!edits.current.size) return;
      if (!window.confirm('设置有尚未保存的编辑。确定放弃这些编辑并退出登录吗？')) { event.preventDefault(); return; }
      pendingEdits = new Set(edits.current); edits.current.clear(); setDirty(false);
    };
    const failed = () => { if (pendingEdits) { edits.current = pendingEdits; pendingEdits = null; setDirty(edits.current.size > 0); } };
    window.addEventListener('settings-before-leave', beforeLeave);
    window.addEventListener('settings-leave-failed', failed);
    return () => { window.removeEventListener('settings-before-leave', beforeLeave); window.removeEventListener('settings-leave-failed', failed); };
  }, []);
  const tabs = [['profile', '个人资料'], ['security', '账户安全'], ['appearance', '外观']];
  tabs.splice(1, 0, ['privacy', '资料与隐私']);
  if (session.data?.isAdmin === true) {
    tabs.push(['accounts', '账户管理']);
    if (session.data.role === 'super_admin') tabs.push(['ai', 'AI 配置']);
  }
  return <div className="settings-layout">
    <h1>设置</h1>
    <nav className="settings-tabs" aria-label="设置分类">{tabs.map(([path, label]) => <NavLink key={path} to={`/app/settings/${path}`}>{label}</NavLink>)}</nav>
    <SettingsDirtyContext.Provider value={reportDirty}><div key={location.pathname} className="settings-content"><Outlet /></div></SettingsDirtyContext.Provider>
  </div>;
}
