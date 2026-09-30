import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInstallState, promptInstall, resetForTest, subscribe, type BeforeInstallPromptEvent, type InstallState } from './pwa-install';

function mockDisplayMode(standalone: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue({
      matches: standalone,
      media: '(display-mode: standalone)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

function createPromptEvent(outcome: 'accepted' | 'dismissed'): BeforeInstallPromptEvent {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as BeforeInstallPromptEvent & { prompt: ReturnType<typeof vi.fn> };
  event.prompt = vi.fn(async () => {});
  Object.defineProperty(event, 'userChoice', { value: Promise.resolve({ outcome, platform: 'web' }) });
  return event;
}

beforeEach(() => {
  resetForTest();
  mockDisplayMode(false);
  // 应用外壳挂载时即订阅，这里先让模块开始监听，再派发事件。
  getInstallState();
});

afterEach(() => {
  resetForTest();
});

describe('应用内 PWA 安装入口', () => {
  it('beforeinstallprompt 到达后进入可安装状态并通知订阅者', () => {
    const seen: InstallState[] = [];
    const unsubscribe = subscribe(() => seen.push(getInstallState()));
    expect(getInstallState()).toEqual({ installed: false, canInstall: false });

    const event = createPromptEvent('accepted');
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(getInstallState()).toEqual({ installed: false, canInstall: true });
    expect(seen).toEqual([{ installed: false, canInstall: true }]);
    unsubscribe();
  });

  it('promptInstall() 调用 event.prompt()，用户接受后不再可安装', async () => {
    const event = createPromptEvent('accepted');
    window.dispatchEvent(event);
    expect(getInstallState().canInstall).toBe(true);

    await expect(promptInstall()).resolves.toBe('accepted');

    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(getInstallState()).toEqual({ installed: true, canInstall: false });
    await expect(promptInstall()).resolves.toBe('unavailable');
  });

  it('用户拒绝后事件不可重用', async () => {
    const event = createPromptEvent('dismissed');
    window.dispatchEvent(event);

    await expect(promptInstall()).resolves.toBe('dismissed');
    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(getInstallState()).toEqual({ installed: false, canInstall: false });
  });

  it('appinstalled 后不再可安装', () => {
    window.dispatchEvent(createPromptEvent('accepted'));
    expect(getInstallState().canInstall).toBe(true);

    window.dispatchEvent(new Event('appinstalled'));

    expect(getInstallState()).toEqual({ installed: true, canInstall: false });
  });

  it('standalone 显示模式下一开始就不可安装', () => {
    mockDisplayMode(true);

    expect(getInstallState()).toEqual({ installed: true, canInstall: false });

    window.dispatchEvent(createPromptEvent('accepted'));

    expect(getInstallState()).toEqual({ installed: true, canInstall: false });
    expect(getInstallState().canInstall).toBe(false);
  });
});
