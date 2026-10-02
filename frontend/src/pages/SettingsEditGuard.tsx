import { confirmPage } from '../dialogs/dialog-service';
import type { SettingsLeaveRequest } from '../dialogs/settings-leave';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import { useSession } from '../auth';
import { SettingsDirtyContext } from './settings-dirty';

export function SettingsEditGuard({ children, message = '设置有尚未保存的编辑。确定放弃这些编辑并离开吗？' }: { children: ReactNode; message?: string }) {
  const session = useSession();
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
    const controller = new AbortController();
    void confirmPage(message, { signal: controller.signal, cancelOnBack: false }).then(confirmed => {
      if (!controller.signal.aborted) { if (confirmed) blocker.proceed(); else blocker.reset(); }
    });
    return () => controller.abort();
  }, [blocker, message]);
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
    const controller = new AbortController();
    const beforeLeave = (event: Event) => {
      if (!edits.current.size) return;
      const waitUntil = (event as CustomEvent<SettingsLeaveRequest>).detail?.waitUntil;
      if (!waitUntil) { event.preventDefault(); return; }
      waitUntil(confirmPage('设置有尚未保存的编辑。确定放弃这些编辑并退出登录吗？', { signal: controller.signal }).then(confirmed => {
        if (!confirmed || controller.signal.aborted) return false;
        pendingEdits = new Set(edits.current); edits.current.clear(); setDirty(false); return true;
      }));
    };
    const failed = () => { if (pendingEdits) { edits.current = pendingEdits; pendingEdits = null; setDirty(edits.current.size > 0); } };
    window.addEventListener('settings-before-leave', beforeLeave);
    window.addEventListener('settings-leave-failed', failed);
    return () => { controller.abort(); window.removeEventListener('settings-before-leave', beforeLeave); window.removeEventListener('settings-leave-failed', failed); };
  }, []);
  return <SettingsDirtyContext.Provider value={reportDirty}>{children}</SettingsDirtyContext.Provider>;
}
