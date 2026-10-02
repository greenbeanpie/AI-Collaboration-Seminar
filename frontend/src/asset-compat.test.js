import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it('copies only owned precached hashed JS/CSS before activation without touching user caches', async () => {
  const sw = new EventTarget(); sw.location = { origin: 'https://app.example' };
  const urls = ['/assets/Page-oldhash.js', '/assets/index-oldhash.css', '/index.html', '/api/v1/auth/session', '/documents/private.pdf', '/assets/nohash.js'];
  const source = { keys: async () => [...urls.map(p => new Request(sw.location.origin + p)), new Request('https://outside.example/assets/Page-hash.js')], match: async () => new Response('generated static code') };
  const target = { put: vi.fn(async () => {}) };
  const open = vi.fn(async name => name === 'ai-office-assets-compat-v1' ? target : source);
  vi.stubGlobal('self', sw); vi.stubGlobal('caches', { keys: async () => ['workbox-precache-v2-app', 'private-user-cache'], open });
  await import('../public/asset-compat.js');
  let completion; const install = new Event('install'); install.waitUntil = promise => { completion = promise; };
  sw.dispatchEvent(install); await completion;
  expect(target.put.mock.calls.map(([request]) => request.url)).toEqual(['https://app.example/assets/Page-oldhash.js', 'https://app.example/assets/index-oldhash.css']);
  expect(open).not.toHaveBeenCalledWith('private-user-cache');
});

it('does not fail worker installation when static compatibility cache is unavailable', async () => {
 const sw=new EventTarget();sw.location={origin:'https://app.example'};vi.stubGlobal('self',sw);vi.stubGlobal('caches',{open:vi.fn(async()=>{throw new Error('storage full');})});await import('../public/asset-compat.js');let completion;const install=new Event('install');install.waitUntil=promise=>{completion=promise;};sw.dispatchEvent(install);await expect(completion).resolves.toBeUndefined();
});
