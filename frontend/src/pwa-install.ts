/**
 * 应用内 PWA 安装入口。
 *
 * Chrome 的原生安装入口（地址栏图标）不在页面内，容易被忽略；这里捕获
 * beforeinstallprompt 并暴露一个可在应用外壳中渲染的安装按钮。
 * 该事件对象只能使用一次 prompt()，且仅在当前文档生命周期内有效，
 * 因此调用或 appinstalled 之后必须丢弃。
 */

/** lib.dom 尚未提供 beforeinstallprompt 的事件类型，这里按规范自定义。 */
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed'; readonly platform: string }>;
  prompt(): Promise<void>;
}

export interface InstallState {
  /** 应用已在独立窗口（桌面/主屏）中运行，无需再提供安装入口。 */
  readonly installed: boolean;
  /** 浏览器已给出安装机会，可以显示应用内「安装到桌面」。 */
  readonly canInstall: boolean;
}

export type InstallPromptOutcome = 'accepted' | 'dismissed' | 'unavailable';

const STANDALONE_QUERY = '(display-mode: standalone)';

const listeners = new Set<() => void>();
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installed = false;
let listening = false;
let snapshot: InstallState = Object.freeze({ installed: false, canInstall: false });

function isStandalone(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(STANDALONE_QUERY).matches;
  } catch {
    return false;
  }
}

function refresh(): InstallState {
  const standalone = isStandalone();
  const next: InstallState = {
    installed: standalone || installed,
    canInstall: !standalone && !installed && deferredPrompt !== null,
  };
  if (next.installed !== snapshot.installed || next.canInstall !== snapshot.canInstall) snapshot = Object.freeze(next);
  return snapshot;
}

function emit(): void {
  refresh();
  for (const listener of [...listeners]) listener();
}

function handleBeforeInstallPrompt(event: Event): void {
  const promptEvent = event as BeforeInstallPromptEvent;
  if (typeof promptEvent.prompt !== 'function') return;
  event.preventDefault();
  deferredPrompt = promptEvent;
  emit();
}

function handleAppInstalled(): void {
  installed = true;
  deferredPrompt = null;
  emit();
}

function ensureListening(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  window.addEventListener('appinstalled', handleAppInstalled);
}

/** 当前安装状态；配合 subscribe 供 useSyncExternalStore 使用。 */
export function getInstallState(): InstallState {
  ensureListening();
  return refresh();
}

/** 订阅安装状态变化，返回取消订阅函数。 */
export function subscribe(listener: () => void): () => void {
  ensureListening();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * 触发浏览器安装提示。
 * 没有可用事件、已安装或处于 standalone 显示模式时返回 'unavailable'。
 */
export async function promptInstall(): Promise<InstallPromptOutcome> {
  ensureListening();
  const promptEvent = deferredPrompt;
  if (!promptEvent || installed || isStandalone()) return 'unavailable';

  // 事件只能使用一次，先丢弃再等待用户选择，避免重复弹出。
  deferredPrompt = null;
  emit();
  try {
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome === 'accepted') {
      installed = true;
      emit();
    }
    return outcome;
  } catch {
    return 'unavailable';
  }
}

/** 仅供测试：清空事件、状态与订阅。 */
export function resetForTest(): void {
  if (listening && typeof window !== 'undefined') {
    window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.removeEventListener('appinstalled', handleAppInstalled);
  }
  listening = false;
  deferredPrompt = null;
  installed = false;
  listeners.clear();
  snapshot = Object.freeze({ installed: false, canInstall: false });
}
