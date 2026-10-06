import { expect, it, vi } from 'vitest';
import worker from './worker';
import { securityHeaders } from './security-headers';
it('secures SPA and asset responses while preserving body/status/cache validators', async () => {
  const fetch = vi.fn(async () => new Response('asset', {status: 200, headers: {'ETag':'"asset"','Cache-Control':'public,max-age=60'}}));
  for (const path of ['/','/app/projects/x','/assets/main.js','/sw.js']) {
    const response = await worker.fetch(new Request('https://app.test'+path), {ASSETS:{fetch},API:{fetch}});
    expect(await response.text()).toBe('asset'); expect(response.headers.get('ETag')).toBe('"asset"');
    for (const [key,value] of Object.entries(securityHeaders)) expect(response.headers.get(key)).toBe(value);
  }
  expect(securityHeaders['Content-Security-Policy']).not.toContain("script-src 'self' 'unsafe-inline'");
  expect(securityHeaders['Permissions-Policy']).toContain('microphone=(self)');
});
it('does not overwrite endpoint-specific API policy', async () => {
  const original = new Response('api', {headers:{'Content-Security-Policy':"default-src 'none'"}});
  const fetch=vi.fn(async()=>original), assets=vi.fn();
  expect(await worker.fetch(new Request('https://app.test/api/v1/x'),{ASSETS:{fetch:assets},API:{fetch}})).toBe(original);
  expect(assets).not.toHaveBeenCalled();
});
it('assigns fresh HTML CSP nonces for Cloudflare injection and prevents cached reuse', async () => {
 const fetch=vi.fn(async()=>new Response('<div id="root"></div>',{headers:{'Content-Type':'text/html'}}));
 const first=await worker.fetch(new Request('https://app.test/login'),{ASSETS:{fetch},API:{fetch}});
 const second=await worker.fetch(new Request('https://app.test/login'),{ASSETS:{fetch},API:{fetch}});
 expect(first.headers.get('Cache-Control')).toBe('no-store');
 const policy=first.headers.get('Content-Security-Policy')!;
 expect(policy).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);expect(policy).toContain("frame-src 'self' https://challenges.cloudflare.com");
 expect(second.headers.get('Content-Security-Policy')).not.toBe(policy);
 expect(await first.text()).toBe('<div id="root"></div>');
});
