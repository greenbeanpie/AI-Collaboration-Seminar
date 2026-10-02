import { afterEach, beforeEach, expect, it, vi } from 'vitest';
let worker;
beforeEach(async () => {
  worker = new EventTarget(); worker.location = { origin: 'https://app.example' };
  vi.stubGlobal('self', worker); vi.stubGlobal('caches', { keys: vi.fn(async () => []), open: vi.fn() });
  vi.stubGlobal('fetch', vi.fn()); await import('../public/navigation-worker.js');
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
function dispatch(path = '/app/projects/one', method = 'GET', navigate = true) {
  const request = new Request(new URL(path, worker.location.origin), { method });
  if (navigate) Object.defineProperty(request, 'mode', { value: 'navigate' });
  const event = new Event('fetch'); event.request = request; let response;
  event.respondWith = vi.fn(value => { response = value; });
  const stop = vi.spyOn(event, 'stopImmediatePropagation'); worker.dispatchEvent(event);
  return { response, event, stop };
}
it('serves healthy navigation without touching corrupt caches or storing account data', async () => {
  caches.keys.mockRejectedValue(new Error('cache storage unavailable'));
  fetch.mockResolvedValue(new Response('network page', { headers: { 'Content-Type': 'text/html' } }));
  const result = dispatch(); expect(await (await result.response).text()).toBe('network page');
  expect(result.stop).toHaveBeenCalledOnce(); expect(caches.keys).not.toHaveBeenCalled();
  const request = fetch.mock.calls[0][0]; expect(request.url).toBe('https://app.example/app/projects/one'); expect(request.redirect).toBe('follow'); expect(request.cache).toBe('no-store');
});
it('normalizes a canonical redirect response before returning it to manual navigation', async () => {
  const redirected = new Response('redirected server shell', { headers: { 'Content-Type': 'text/html', 'X-Test': 'preserved' } });
  Object.defineProperty(redirected, 'redirected', { value: true }); fetch.mockResolvedValue(redirected);
  const response = await dispatch().response; expect(response.redirected).toBe(false); expect(response.headers.get('x-test')).toBe('preserved'); expect(await response.text()).toBe('redirected server shell');
});
it('uses only a generated offline shell when the network fails and leaves private caches untouched', async () => {
  fetch.mockRejectedValue(new TypeError('offline'));
  caches.keys.mockResolvedValue(['private-account-cache', 'workbox-precache-v2-app']);
  const put = vi.fn(); caches.open.mockResolvedValue({ keys: async () => [new Request('https://app.example/api/v1/auth/session'), new Request('https://app.example/index.html?__WB_REVISION__=one')], match: async () => new Response('offline static shell', { headers: { 'Content-Type': 'text/html' } }), put });
  expect(await (await dispatch().response).text()).toBe('offline static shell');
  expect(caches.open).toHaveBeenCalledTimes(1); expect(caches.open).toHaveBeenCalledWith('workbox-precache-v2-app'); expect(put).not.toHaveBeenCalled();
});
it('returns a readable offline response when both network and shell cache are unavailable', async () => {
  fetch.mockRejectedValue(new TypeError('offline')); caches.keys.mockRejectedValue(new Error('cache broken'));
  const response = await dispatch().response; expect(response.status).toBe(503); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.text()).toContain('恢复网络');
});
it.each([['/api/v1/auth/session', 'GET', true], ['/api', 'GET', true], ['https://other.example/app', 'GET', true], ['/app', 'POST', true], ['/assets/app-hash.js', 'GET', false]])('does not intercept %s %s navigation=%s', (path, method, navigation) => {
  const result = dispatch(path, method, navigation); expect(result.event.respondWith).not.toHaveBeenCalled(); expect(result.stop).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(caches.keys).not.toHaveBeenCalled();
});

it('normalizes an old redirected offline precache entry without deleting any caches', async () => {
  fetch.mockRejectedValue(new TypeError('offline'));caches.keys.mockResolvedValue(['workbox-precache-v2-app']);const shell=new Response('old redirected shell',{headers:{'Content-Type':'text/html'}});Object.defineProperty(shell,'redirected',{value:true});caches.open.mockResolvedValue({keys:async()=>[new Request('https://app.example/index.html?__WB_REVISION__=old')],match:async()=>shell});const response=await dispatch().response;expect(response.redirected).toBe(false);expect(await response.text()).toBe('old redirected shell');
});
