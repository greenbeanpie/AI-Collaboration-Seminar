export const DESKTOP_PROTOCOL = 1;

type NativeWindow = Window & { __TAURI_INTERNALS__?: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> } };
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && typeof (window as NativeWindow).__TAURI_INTERNALS__?.invoke === 'function';
}
export async function desktopInvoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const bridge = (window as NativeWindow).__TAURI_INTERNALS__;
  if (!bridge) throw new Error('此功能需要 Windows 客户端');
  return bridge.invoke<T>(command, args);
}

export type DesktopUpdateState = { phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'installing' | 'error'; version?: string | null; downloadedBytes: number; totalBytes?: number | null; error?: string | null; autoRestart: boolean };
export type DesktopHello = { protocol: number; version: string; autoRestart: boolean; updateState: DesktopUpdateState };
