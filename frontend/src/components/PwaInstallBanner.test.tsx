import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getInstallState, resetForTest } from '../pwa-install';

function installEvent() {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  const prompt = vi.fn(async () => {});
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }) });
  act(() => { window.dispatchEvent(event); });
  return prompt;
}

afterEach(() => { cleanup(); resetForTest(); sessionStorage.clear(); vi.restoreAllMocks(); vi.resetModules(); });

it('closes without prompting and stays dismissed after remount, refresh, and another install event', async () => {
  const { PwaInstallBanner } = await import('./PwaInstallBanner');
  const view = render(<PwaInstallBanner />);
  const prompt = installEvent();
  const close = screen.getByRole('button', { name: '关闭安装提示' });
  close.focus();
  expect(close).toHaveFocus();
  fireEvent.click(close);
  expect(prompt).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '安装到桌面' })).not.toBeInTheDocument();
  expect(getInstallState().canInstall).toBe(true);
  view.unmount();
  render(<PwaInstallBanner />); installEvent();
  expect(screen.queryByRole('button', { name: '关闭安装提示' })).not.toBeInTheDocument();
  cleanup(); vi.resetModules();
  const reloaded = await import('./PwaInstallBanner');
  render(<reloaded.PwaInstallBanner />); installEvent();
  expect(screen.queryByRole('button', { name: '关闭安装提示' })).not.toBeInTheDocument();
});

it('works when session storage is blocked and remains dismissed after remount', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  const { PwaInstallBanner } = await import('./PwaInstallBanner');
  const view = render(<PwaInstallBanner />); installEvent();
  fireEvent.click(screen.getByRole('button', { name: '关闭安装提示' }));
  view.unmount(); render(<PwaInstallBanner />); installEvent();
  expect(screen.queryByRole('button', { name: '安装到桌面' })).not.toBeInTheDocument();
});

it('only invokes the install prompt from the install button, once', async () => {
  const { PwaInstallBanner } = await import('./PwaInstallBanner');
  render(<PwaInstallBanner />);
  const prompt = installEvent();
  expect(prompt).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '安装到桌面' })); });
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: '安装到桌面' })).not.toBeInTheDocument();
});

it('keeps an early install event for the first dashboard visit and does not repeat on later visits', async () => {
  const pwa = await import('../pwa-install');
  pwa.getInstallState();
  const prompt = installEvent();
  const { PwaInstallBanner } = await import('./PwaInstallBanner');
  const view = render(<PwaInstallBanner />);
  expect(screen.getByRole('button', { name: '安装到桌面' })).toBeInTheDocument();
  expect(prompt).not.toHaveBeenCalled();
  view.unmount();
  render(<PwaInstallBanner />);
  expect(screen.queryByRole('button', { name: '安装到桌面' })).not.toBeInTheDocument();
});
