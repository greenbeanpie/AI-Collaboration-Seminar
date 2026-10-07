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
    return secureResponse(await env.ASSETS.fetch(request));
  },
};
