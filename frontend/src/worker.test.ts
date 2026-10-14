import { describe, expect, it, vi } from 'vitest';
import worker from './worker';

describe('frontend Worker routing', () => {
  it.each(['/api', '/api/v1/auth/session'])('sends %s through the private API Service Binding before static assets', async (path) => {
    const apiResponse = new Response('api-response');
    const apiFetch = vi.fn().mockResolvedValue(apiResponse);
    const assetsFetch = vi.fn().mockResolvedValue(new Response('asset-response'));
    const request = new Request(`https://workspace.example${path}`);

    const response = await worker.fetch(request, { API: { fetch: apiFetch }, ASSETS: { fetch: assetsFetch } });

    expect(response).toBe(apiResponse);
    expect(apiFetch).toHaveBeenCalledWith(request);
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  it('serves application routes from the asset binding for Worker SPA fallback', async () => {
    const assetResponse = new Response('react-app');
    const apiFetch = vi.fn();
    const assetsFetch = vi.fn().mockResolvedValue(assetResponse);
    const request = new Request('https://workspace.example/app/projects/project-1/materials');

    const response = await worker.fetch(request, { API: { fetch: apiFetch }, ASSETS: { fetch: assetsFetch } });

    expect(await response.text()).toBe('react-app');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(assetsFetch).toHaveBeenCalledWith(request);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});


it.each(['/login','/login/','/help','/password-reset/','/app','/app/join?code=fixture','/app/projects/example/data'])('serves %s as a secured SPA navigation after an asset miss',async path=>{
  const assets=vi.fn(async(request:Request)=>new URL(request.url).pathname==='/index.html'
    ? new Response('<div id="root"></div>',{headers:{'content-type':'text/html'}})
    : new Response('missing',{status:404}));
  const response=await worker.fetch(new Request('https://example.test'+path),{ASSETS:{fetch:assets},API:{fetch:vi.fn()}});
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-security-policy')).toMatch(/'nonce-[^']+'/);
  expect(assets).toHaveBeenCalledTimes(2);
});
it.each(['/assets/missing.js','/missing-page'])('keeps %s a 404 instead of returning index.html',async path=>{
  const assets=vi.fn(async()=>new Response('missing',{status:404}));
  const response=await worker.fetch(new Request('https://example.test'+path),{ASSETS:{fetch:assets},API:{fetch:vi.fn()}});
  expect(response.status).toBe(404);expect(assets).toHaveBeenCalledOnce();
});
it('never turns an application POST into HTML',async()=>{
  const assets=vi.fn(async()=>new Response('missing',{status:404}));
  const response=await worker.fetch(new Request('https://example.test/app/join',{method:'POST'}),{ASSETS:{fetch:assets},API:{fetch:vi.fn()}});
  expect(response.status).toBe(404);expect(assets).toHaveBeenCalledOnce();
});
