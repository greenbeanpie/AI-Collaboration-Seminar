(() => {
  const status = document.getElementById('status');
  const detail = document.getElementById('detail');
  const retry = document.getElementById('retry');
  const recovery = new URLSearchParams(location.search).get('recovery') === '1';
  let busy = false;
  const unavailable = (message) => {
    status.textContent = '工作区暂时无法打开';
    detail.textContent = message;
    retry.textContent = '重新打开工作区';
    retry.disabled = false;
  };
  const open = async () => {
    if (busy) return;
    busy = true;
    retry.disabled = true;
    status.textContent = '正在打开工作区…';
    retry.textContent = '正在打开…';
    try {
      await window.__TAURI_INTERNALS__.invoke('desktop_open_app');
    } catch {
      busy = false;
      unavailable('客户端启动未完成。请关闭后重新打开客户端；此操作不会清除本机保存的数据。');
    }
  };
  retry.addEventListener('click', () => { void open(); });
  if (recovery) {
    unavailable('连接暂时不可用，或本机尚未保存应用页面。已保存的项目、草稿和附件仍保留在此设备上。请恢复网络后重试。');
    window.addEventListener('online', () => { void open(); });
  } else {
    // Allow the bundled loading UI to paint. Offline startup still tries the remote
    // origin, so an installed service worker can serve the existing cached app.
    setTimeout(() => { void open(); }, 100);
  }
})();
