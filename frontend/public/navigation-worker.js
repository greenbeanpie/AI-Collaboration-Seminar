// Network-first navigation is deliberately separate from Workbox's precache handler.
// A missing/corrupt shell entry must never turn a healthy server response into ERR_FAILED.
// API requests and account/document responses are neither intercepted nor cached here.
function appNavigation(request) {
  const url = new URL(request.url);
  return request.method === 'GET' && request.mode === 'navigate' && url.origin === self.location.origin && !/^\/api(?:\/|$)/.test(url.pathname);
}
function navigationResponse(response) {
  // Canonical /index.html redirects can produce a redirected response incompatible
  // with a navigation's manual redirect mode. Return an ordinary response body.
  return response.redirected ? new Response(response.body, { status: response.status, statusText: response.statusText, headers: response.headers }) : response;
}
async function cachedAppShell() {
  try {
    for (const name of await caches.keys()) {
      if (!name.startsWith('workbox-precache-')) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const url = new URL(request.url);
        if (url.origin !== self.location.origin || url.pathname !== '/index.html') continue;
        const response = await cache.match(request);
        if (response?.ok && response.headers.get('content-type')?.includes('text/html')) return navigationResponse(response);
      }
    }
  } catch { /* Cache storage may be unavailable; the network path remains independent. */ }
  return null;
}
async function serveAppNavigation(request) {
  try {
    const response = await fetch(new Request(request, { cache: 'no-store', redirect: 'follow' }));
    if (response.status < 500) return navigationResponse(response);
    const shell = await cachedAppShell();
    return shell || navigationResponse(response);
  } catch {
    const shell = await cachedAppShell();
    return shell || new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>暂时无法连接</title><p>暂时无法连接工作台。请恢复网络后重新加载页面。</p></html>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
}
self.addEventListener('fetch', event => {
  if (!appNavigation(event.request)) return;
  // Own only navigation; prevent a later Workbox precache route from respondWith twice.
  event.stopImmediatePropagation();
  event.respondWith(serveAppNavigation(event.request));
});
