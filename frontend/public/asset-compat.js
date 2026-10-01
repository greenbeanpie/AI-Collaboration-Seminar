// Preserve only generated same-origin static assets before Workbox prunes its old manifest.
// Never copy API responses, documents, HTML, or account data into this compatibility cache.
const COMPAT_ASSET_CACHE = 'ai-office-assets-compat-v1';
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const target = await caches.open(COMPAT_ASSET_CACHE);
    for (const name of await caches.keys()) {
      if (!name.startsWith('workbox-precache-')) continue;
      const source = await caches.open(name);
      for (const request of await source.keys()) {
        const url = new URL(request.url);
        if (url.origin !== self.location.origin || !/^\/assets\/[^/]+-[A-Za-z0-9_-]+\.(?:js|css)$/.test(url.pathname)) continue;
        const response = await source.match(request);
        if (response?.ok) await target.put(new Request(url.origin + url.pathname), response.clone());
      }
    }
  })());
});
