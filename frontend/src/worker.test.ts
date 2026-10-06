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
