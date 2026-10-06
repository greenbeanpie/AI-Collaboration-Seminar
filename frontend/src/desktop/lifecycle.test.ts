import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginDesktopActivity, desktopPageState, desktopSafeToReload, markDesktopReady, setDesktopDirty, startDesktopLifecycle } from './lifecycle';

afterEach(() => { setDesktopDirty('test', false); vi.unstubAllGlobals(); });
describe('desktop restart protection', () => {
  it('keeps initial desktop startup unsafe until the compatible bridge is ready', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: vi.fn(async () => undefined) } });
    const stop = startDesktopLifecycle();
    expect(desktopPageState().durable).toBe(false);
    markDesktopReady(); expect(desktopPageState().durable).toBe(true);
    stop(); delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
  it('requires every active request to finish and ignores duplicate completion', () => {
    const a = beginDesktopActivity(), b = beginDesktopActivity();
    a(); a(); expect(desktopPageState().busy).toBe(true);
    b(); expect(desktopPageState().busy).toBe(false);
  });
  it('does not restart over dirty content or existing unload vetoes', () => {
    setDesktopDirty('test', true); expect(desktopSafeToReload()).toBe(false);
    setDesktopDirty('test', false);
    const veto = (event: Event) => event.preventDefault();
    window.addEventListener('beforeunload', veto);
    expect(desktopSafeToReload()).toBe(false);
    window.removeEventListener('beforeunload', veto);
    expect(desktopSafeToReload()).toBe(true);
  });
  it('acknowledges the native request with its nonce and fails closed', async () => {
    const invoke = vi.fn(async () => undefined);
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
    const stop = startDesktopLifecycle();
    setDesktopDirty('test', true);
    window.dispatchEvent(new CustomEvent('desktop-prepare-update', { detail: { requestId: 42 } }));
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('desktop_report_state', { state: expect.objectContaining({ requestId: 42, dirty: true }) });
    stop(); delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});
