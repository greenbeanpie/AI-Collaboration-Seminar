import { createMiddleware } from 'hono/factory';
import { createHash } from 'node:crypto';
import type { AppEnv } from '../env';
import { sha256Hex } from './db';
/** Hash serialized envelopes incrementally; do not parse/copy large documents on revalidation. */
async function envelopeHash(response: Response, principal: string, url: string): Promise<string | null> {
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  const hash = createHash('sha256').update(principal).update('\0').update(url).update('\0');
  let tail = new Uint8Array(0), prefix = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (prefix.length < 16) {
      const next = new Uint8Array(Math.min(16, prefix.length + value.length));
      next.set(prefix); next.set(value.subarray(0, next.length - prefix.length), prefix.length); prefix = next;
    }
    const bytes = new Uint8Array(tail.length + value.length);
    bytes.set(tail); bytes.set(value, tail.length);
    const boundary = Math.max(0, bytes.length - 128);
    hash.update(bytes.subarray(0, boundary)); tail = bytes.slice(boundary);
  }
  if (!new TextDecoder().decode(prefix).startsWith('{"data":')) return null;
  // apiData's sole trailing metadata changes on every request; retain nested requestId fields.
  const end = new TextDecoder().decode(tail);
  const metadata = end.match(/,"requestId":"[a-zA-Z0-9-]{1,64}"\}$/);
  if (!metadata) return null;
  hash.update(tail.subarray(0, tail.length - new TextEncoder().encode(metadata[0]).length));
  return '"' + hash.digest('hex') + '"';
}
/** Revalidate only after authorization; validators never grant access or bypass database reads. */
export const snapshotEtag = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  const user = c.get('user');
  if ((!user && c.req.path !== '/api/v1/capabilities') || c.req.method !== 'GET' || c.res.status !== 200 || !c.res.headers.get('content-type')?.includes('application/json')) return;
  const path = c.req.path;
  if (!(path === '/api/v1/capabilities' || path === '/api/v1/auth/session' || path === '/api/v1/projects' || /^\/api\/v1\/projects\/[^/]+(?:$|\/)/.test(path))) return;
  const etag = await envelopeHash(c.res, user?.id ?? await sha256Hex(c.req.header('cookie') ?? 'public'), c.req.url);
  if (!etag) return;
  c.header('ETag', etag);
  if (!c.res.headers.get('Cache-Control')?.includes('no-store')) c.header('Cache-Control', 'private, no-store');
  const vary = new Set((c.res.headers.get('Vary') ?? '').split(',').map(value => value.trim()).filter(Boolean));
  vary.add('Cookie'); c.header('Vary', [...vary].join(', '));
  if (c.req.header('if-none-match')?.split(',').some(value => value.trim() === etag)) c.res = new Response(null, { status: 304, headers: c.res.headers });
});
