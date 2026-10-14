import { secureResponse } from './security-headers.ts';
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  API: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return env.API.fetch(request);
    }
    let response = await env.ASSETS.fetch(request);
    // Missing assets remain 404. Only application routes use the SPA document,
    // so every successful HTML navigation still receives the nonce/no-store policy.
    if (response.status === 404 && ['GET', 'HEAD'].includes(request.method)
      && (/^\/(?:login|help|password-reset)\/?$/.test(url.pathname) || url.pathname === '/app' || url.pathname.startsWith('/app/'))) {
      response = await env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    }
    return secureResponse(response);
  },
};
