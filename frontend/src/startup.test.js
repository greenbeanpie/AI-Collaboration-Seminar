import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountStartup } from '../public/startup.js';
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div id="root"><main id="app-startup"><h1>正在打开补位</h1><p id="startup-message"></p><button id="startup-retry" hidden>重新加载</button></main></div>';
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(async () => {
  document.getElementById('root')?.replaceChildren();
  await Promise.resolve();
  vi.useRealTimers(); vi.restoreAllMocks();
});
it('offers recovery for a stalled bundle while explaining first-use offline', () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  mountStartup();
  expect(document.getElementById('startup-message').textContent).toContain('首次使用需要联网');
  vi.advanceTimersByTime(15_000);
  expect(document.getElementById('startup-retry').hidden).toBe(false);
  expect(document.getElementById('startup-message').textContent).toContain('恢复网络');
});
it('shows recovery immediately when the entry script fails', () => {
  mountStartup();
  const unrelated = document.createElement('script'); unrelated.src = '/app-updates.js'; document.body.append(unrelated);
  unrelated.dispatchEvent(new Event('error'));
  expect(document.getElementById('startup-retry').hidden).toBe(true);
  const script = document.createElement('script'); script.src = '/assets/index-abc.js'; document.body.append(script);
  script.dispatchEvent(new Event('error'));
  expect(document.getElementById('startup-retry').hidden).toBe(false);
});
it('stops the watchdog after the app mounts and never offers recovery over an editor', async () => {
  mountStartup();
  const placeholder = document.getElementById('app-startup');
  document.getElementById('root').innerHTML = '<textarea>未提交的正文</textarea>';
  await Promise.resolve();
  vi.advanceTimersByTime(30_000);
  expect(placeholder.querySelector('button').hidden).toBe(true);
  expect(document.querySelector('textarea').value).toBe('未提交的正文');
  expect(vi.getTimerCount()).toBe(0);
});
