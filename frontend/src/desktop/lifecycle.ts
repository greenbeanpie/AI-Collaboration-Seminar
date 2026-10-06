import { DESKTOP_PROTOCOL, desktopInvoke, isAndroidClient, isDesktop } from './bridge';

const dirtyOwners = new Set<string>();
let active = 0;
let storageSafe = true;
let bridgeReady = false;
let accountId: string | null = null;
let report: (() => void) | undefined;

export function setDesktopDirty(id: string, dirty: boolean): void {
  if (dirty) dirtyOwners.add(id); else dirtyOwners.delete(id);
  report?.();
}
export function beginDesktopActivity(): () => void {
  active++; report?.();
  let finished = false;
  return () => { if (!finished) { finished = true; active--; report?.(); } };
}
export function setDesktopAccount(id: string | null): void { accountId = id; report?.(); }
export function markDesktopReady(): void { bridgeReady = true; report?.(); }
export function desktopPageState() {
  return { protocol: DESKTOP_PROTOCOL, accountId, dirty: dirtyOwners.size > 0, busy: active > 0, durable: storageSafe && (!isDesktop() || bridgeReady) };
}
export function desktopSafeToReload(): boolean {
  const state = desktopPageState();
  if (state.dirty || state.busy || !state.durable) return false;
  const event = new Event('beforeunload', { cancelable: true });
  return window.dispatchEvent(event);
}

/** No timers are needed in the hidden renderer. Native code requests a fresh acknowledgement. */
export function startDesktopLifecycle(): () => void {
  if (!isDesktop()) return () => {};
  bridgeReady = false;
  let scheduled = false, disposed = false;
  const send = async (requestId?: number) => {
    if (disposed) return;
    const state = desktopPageState();
    if (requestId && !desktopSafeToReload()) state.dirty = true;
    try { await desktopInvoke('desktop_report_state', { state: { ...state, requestId } }); }
    catch { window.dispatchEvent(new CustomEvent('desktop-bridge-error', { detail: '客户端与网页版本不兼容，请升级客户端。' })); }
  };
  report = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; void send(); });
  };
  const storageFailure = () => { storageSafe = false; report?.(); };
  const prepare = (event: Event) => {
    const detail = (event as CustomEvent<{ requestId?: number }>).detail;
    void send(detail?.requestId);
  };
  const resume = () => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('desktop-transfer-refresh'));
    report?.();
  };
  const visibility = () => {
    if (!isAndroidClient()) return;
    void desktopInvoke('mobile_set_foreground', { foreground: document.visibilityState !== 'hidden' }).catch(() => {});
    if (document.visibilityState !== 'hidden') resume();
    else report?.();
  };
  const guardUpdate = (event: Event) => { if (!desktopSafeToReload()) event.preventDefault(); };
  const activityInput = (event: Event) => {
    const target = event.target;
    // Rich editors register their own dirty state. Unknown form edits conservatively block restart.
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
    if (target instanceof HTMLInputElement && ['search', 'checkbox', 'radio', 'file', 'range'].includes(target.type)) return;
    if (target.closest('[data-desktop-managed]')) return;
    setDesktopDirty('unmanaged-form', true);
  };
  const route = () => setDesktopDirty('unmanaged-form', false);
  window.addEventListener('offline-storage-failed', storageFailure);
  window.addEventListener('desktop-prepare-update', prepare);
  window.addEventListener('desktop-resume', resume);
  window.addEventListener('app-before-update', guardUpdate);
  window.addEventListener('desktop-route-changed', route);
  document.addEventListener('input', activityInput, true);
  document.addEventListener('visibilitychange', visibility);
  void send();
  return () => {
    disposed = true; report = undefined;
    window.removeEventListener('offline-storage-failed', storageFailure);
    window.removeEventListener('desktop-prepare-update', prepare);
    window.removeEventListener('desktop-resume', resume);
    window.removeEventListener('app-before-update', guardUpdate);
    window.removeEventListener('desktop-route-changed', route);
    document.removeEventListener('input', activityInput, true);
    document.removeEventListener('visibilitychange', visibility);
  };
}
