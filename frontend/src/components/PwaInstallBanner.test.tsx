import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

function installEvent() {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  const prompt = vi.fn(async () => {});
  Object.assign(event, { prompt, userChoice: Promise.resolve({ outcome: 'dismissed', platform: 'web' }) });
  act(() => { window.dispatchEvent(event); });
  return prompt;
}
const notices: CustomEvent[] = [];
const listener = (event: Event) => notices.push(event as CustomEvent);
window.addEventListener('app-notification', listener);
afterEach(async () => { cleanup(); (await import('../pwa-install')).resetForTest(); sessionStorage.clear(); vi.restoreAllMocks(); vi.resetModules(); notices.length = 0; });

it('offers one history notification without prompting and does not repeat after remount or refresh', async () => {
  const { PwaInstallBanner } = await import('./PwaInstallBanner');
  const view = render(<PwaInstallBanner />); const prompt = installEvent();
  expect(notices).toHaveLength(1); expect(notices[0].detail).toMatchObject({ id: 'install', action: 'install' });
  expect(prompt).not.toHaveBeenCalled();
  view.unmount(); render(<PwaInstallBanner />); installEvent(); expect(notices).toHaveLength(1);
  cleanup(); (await import('../pwa-install')).resetForTest(); vi.resetModules();
  const reloaded = await import('./PwaInstallBanner'); render(<reloaded.PwaInstallBanner />); installEvent(); expect(notices).toHaveLength(1);
});
it('retains one-time behavior when session storage is unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  const { PwaInstallBanner } = await import('./PwaInstallBanner');
  const view = render(<PwaInstallBanner />); installEvent(); view.unmount(); render(<PwaInstallBanner />); installEvent();
  expect(notices).toHaveLength(1);
});
it('only invokes the browser prompt from the shared notification action, once', async () => {
  const { PwaInstallBanner } = await import('./PwaInstallBanner'); render(<PwaInstallBanner />);
  const prompt = installEvent(); expect(prompt).not.toHaveBeenCalled();
  await act(async () => { window.dispatchEvent(new Event('app-install-request')); window.dispatchEvent(new Event('app-install-request')); });
  expect(prompt).toHaveBeenCalledTimes(1); expect((await import('../pwa-install')).getInstallState().canInstall).toBe(false);
});
it('keeps an early install event for the first dashboard visit', async () => {
  const pwa = await import('../pwa-install'); pwa.getInstallState(); const prompt = installEvent();
  const { PwaInstallBanner } = await import('./PwaInstallBanner'); const view = render(<PwaInstallBanner />);
  expect(notices).toHaveLength(1); expect(prompt).not.toHaveBeenCalled();
  view.unmount(); render(<PwaInstallBanner />); expect(notices).toHaveLength(1);
});
