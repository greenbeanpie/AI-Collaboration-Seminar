// This placeholder exists only before React mounts; recovery never reloads an editor.
export function mountStartup() {
  const shell = document.getElementById('app-startup');
  if (!shell) return;
  const message = document.getElementById('startup-message');
  const retry = document.getElementById('startup-retry');
  const pending = () => {
    if (shell.isConnected) message.textContent = navigator.onLine
      ? '正在加载工作台，随后恢复已保存的内容。'
      : '当前离线，正在打开本机已保存的工作台。首次使用需要联网加载。';
  };
  const stalled = () => {
    if (!shell.isConnected) return;
    shell.querySelector('h1').textContent = '工作台尚未打开';
    message.textContent = navigator.onLine
      ? '加载时间较长，或部分页面资源未能加载。可以重新加载后再试。'
      : '当前离线，所需页面资源可能尚未保存到本机。请恢复网络后重新加载。';
    retry.hidden = false;
  };
  const failed = event => {
    const source = event.target?.getAttribute?.('src') ?? '';
    if (/\/(?:assets\/index-[^/]+\.js|src\/main\.tsx)(?:\?|$)/.test(source)) stalled();
  };
  retry.onclick = () => { if (shell.isConnected) location.reload(); };
  pending();
  window.addEventListener('online', pending);
  window.addEventListener('offline', pending);
  window.addEventListener('error', failed, true);
  const timer = window.setTimeout(stalled, 15_000);
  const observer = new MutationObserver(() => {
    if (shell.isConnected) return;
    clearTimeout(timer);
    window.removeEventListener('online', pending);
    window.removeEventListener('offline', pending);
    window.removeEventListener('error', failed, true);
    observer.disconnect();
  });
  observer.observe(shell.parentNode, { childList: true });
}
if (typeof document !== 'undefined') mountStartup();
