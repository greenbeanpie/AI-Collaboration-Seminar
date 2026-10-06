import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DesktopSettings } from './DesktopRuntime';
import { setNativePlatform } from './bridge';
import { startDesktopLifecycle } from './lifecycle';

afterEach(() => {
  cleanup(); setNativePlatform(undefined);
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

it('shows Android lifecycle and signed APK guidance without Windows restart controls', async () => {
  const invoke = vi.fn(async () => ({ protocol: 1, platform: 'android', version: '0.1.0' }));
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  render(<DesktopSettings />);
  expect(await screen.findByRole('heading', { name: 'Android 客户端' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '重启安装更新' })).toBeNull();
  expect(screen.getByText(/同一签名/)).toBeTruthy();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('reports visibility only on Android and removes its lifecycle listener', async () => {
  const invoke = vi.fn(async () => undefined);
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
  setNativePlatform('android');
  const stop = startDesktopLifecycle();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(invoke).toHaveBeenCalledWith('mobile_set_foreground', { foreground: false });
  stop(); invoke.mockClear();
  document.dispatchEvent(new Event('visibilitychange'));
  await Promise.resolve();
  expect(invoke).not.toHaveBeenCalled();
});
