import { SELF } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedUser } from './helpers/seed';
import { rasterFixtures } from './fixtures/ticket-images';
import { MAX_TICKET_IMAGE_BYTES, ticketCategories, ticketUrgencies } from '../../shared/support-tickets';
import { createApp } from '../src/app';
import { readTicketImage, validateTicketImage } from '../src/services/ticket-images';
import { consumePasswordRateLimit } from '../src/services/accounts';

const root = `${BASE}/api/v1/support/tickets`;
const png = Uint8Array.from(atob(rasterFixtures.png), c => c.charCodeAt(0));
async function actor(role = 'user') {
  const u = await seedUser();
  await env.DB.prepare('UPDATE auth_accounts SET account_role = ?2, is_admin = ?3 WHERE user_id = ?1').bind(u.userId, role, role === 'user' ? 0 : 1).run();
  return { ...u, cookie: authCookie(u.token) };
}
async function create(cookie: string, extra = {}) {
  const response = await SELF.fetch(root, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: '图片问题', body: '描述', ...extra }) });
  expect(response.status).toBe(201);
  return (await response.json() as { data: { ticket: { id: string; urgency: string; category: string; images: unknown[] } } }).data.ticket;
}
const imageUrl = (ticketId: string, imageId: string) => `${root}/${ticketId}/images/${imageId}`;
function upload(cookie: string, ticketId: string, imageId = crypto.randomUUID(), bytes: Uint8Array = png, type = 'image/png', headers = {}) {
  return SELF.fetch(imageUrl(ticketId, imageId), { method: 'PUT', headers: { cookie, 'content-type': type, ...headers }, body: new Uint8Array(bytes) });
}
beforeEach(async () => { await env.DB.prepare('DELETE FROM auth_password_rate_limits').run(); });

it('preserves legacy defaults and stores every allowed urgency/category, rejecting unsupported or forged fields', async () => {
  const owner = await actor();
  expect(await create(owner.cookie)).toMatchObject({ urgency: 'normal', category: 'other', images: [] });
  for (const urgency of ticketUrgencies) expect(await create(owner.cookie, { urgency })).toMatchObject({ urgency });
  for (const category of ticketCategories) {
    const ticket = await create(owner.cookie, { category });
    expect(await (await SELF.fetch(`${root}/${ticket.id}`, { headers: { cookie: owner.cookie } })).text()).toContain(`"category":"${category}"`);
  }
  for (const extra of [{ urgency: 'critical' }, { category: 'unknown' }, { urgency: null }, { images: ['forged'] }]) {
    const response = await SELF.fetch(root, { method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x', body: 'y', ...extra }) });
    expect(response.status).toBe(400);
  }
});
it.each(['png','jpeg','webp'] as const)('accepts real %s raster bytes and serves private typed responses without storage keys', async format => {
  const owner = await actor(), ticket = await create(owner.cookie), id = crypto.randomUUID();
  const bytes = Uint8Array.from(atob(rasterFixtures[format]), c => c.charCodeAt(0)); const type = `image/${format}`;
  expect((await upload(owner.cookie, ticket.id, id, bytes, type)).status).toBe(200);
  const detail = await (await SELF.fetch(`${root}/${ticket.id}`, { headers: { cookie: owner.cookie } })).text();
  expect(detail).toContain(id); expect(detail).not.toContain('sha256'); expect(detail).not.toContain('support-images/');
  const response = await SELF.fetch(imageUrl(ticket.id, id), { headers: { cookie: owner.cookie } });
  expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe(type);
  expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-security-policy')).toContain('sandbox'); expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
});
it.each(['losslessWebp','alphaWebp'] as const)('accepts valid %s images including tiny lossless and extended alpha containers', async format => {
  const owner = await actor(), ticket = await create(owner.cookie);
  const bytes = Uint8Array.from(atob(rasterFixtures[format]), c => c.charCodeAt(0));
  expect((await upload(owner.cookie, ticket.id, crypto.randomUUID(), bytes, 'image/webp')).status).toBe(200);
});
it('enforces owner-only uploads, owner/admin reads, ticket binding and immediate demotion/session revocation', async () => {
  const owner = await actor(), other = await actor(), admin = await actor('admin'), superAdmin = await actor('super_admin');
  const ticket = await create(owner.cookie), otherTicket = await create(owner.cookie), id = crypto.randomUUID();
  expect((await upload(owner.cookie, ticket.id, id)).status).toBe(200);
  expect((await upload(other.cookie, ticket.id)).status).toBe(404);
  expect((await upload(admin.cookie, ticket.id)).status).toBe(403);
  for (const cookie of [admin.cookie, superAdmin.cookie]) expect((await SELF.fetch(imageUrl(ticket.id, id), { headers: { cookie } })).status).toBe(200);
  for (const cookie of [undefined, other.cookie]) {
    const response = await SELF.fetch(imageUrl(ticket.id, id), { headers: cookie ? { cookie } : {} }); expect(response.status).toBe(cookie ? 404 : 401); expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect((await SELF.fetch(imageUrl(otherTicket.id, id), { headers: { cookie: owner.cookie } })).status).toBe(404);
  expect((await upload(owner.cookie, otherTicket.id, id)).status).toBe(409);
  expect((await upload(owner.cookie, ticket.id, crypto.randomUUID(), png, 'image/png', { origin: 'https://evil.example' })).status).toBe(403);
  await env.DB.prepare("UPDATE auth_accounts SET account_role = 'user', is_admin = 0 WHERE user_id = ?1").bind(admin.userId).run();
  expect((await SELF.fetch(imageUrl(ticket.id, id), { headers: { cookie: admin.cookie } })).status).toBe(404);
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(owner.userId).run();
  expect((await upload(owner.cookie, ticket.id)).status).toBe(401);
});
it('rejects executable/disguised/truncated files, MIME mismatches, zero bytes and oversized streams before reserving storage', async () => {
  const owner = await actor(), ticket = await create(owner.cookie);
  for (const [bytes, type] of [[png, 'image/svg+xml'], [png, 'text/html'], [png, 'application/octet-stream'], [png, 'image/jpeg'], [new TextEncoder().encode('<svg onload="alert(1)"></svg>'), 'image/png'], [png.slice(0, 35), 'image/png'], [new TextEncoder().encode('<html>evil</html>'), 'image/webp']] as const) {
    expect((await upload(owner.cookie, ticket.id, crypto.randomUUID(), bytes, type)).status).toBe(415);
  }
  expect((await upload(owner.cookie, ticket.id, crypto.randomUUID(), new Uint8Array())).status).toBe(400);
  expect((await upload(owner.cookie, ticket.id, crypto.randomUUID(), new Uint8Array(MAX_TICKET_IMAGE_BYTES + 1))).status).toBe(413);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAX_TICKET_IMAGE_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  await expect(readTicketImage(new Request(BASE, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: stream }))).rejects.toMatchObject({ status: 413 });
  const huge = png.slice(); new DataView(huge.buffer).setUint32(16, 12001);
  expect(() => validateTicketImage(huge, 'image/png')).toThrow();
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM support_ticket_images WHERE ticket_id = ?1').bind(ticket.id).first<{ n: number }>())?.n).toBe(0);
  expect((await env.FILES.list({ prefix: `support-images/${ticket.id}/` })).objects).toHaveLength(0);
});
it('enforces a four-image cap across concurrent writes and immutable, idempotent retries', async () => {
  const owner = await actor(), ticket = await create(owner.cookie); const ids = Array.from({ length: 8 }, () => crypto.randomUUID());
  const responses = await Promise.all(ids.map(id => upload(owner.cookie, ticket.id, id)));
  expect(responses.filter(response => response.status === 200)).toHaveLength(4); expect(responses.filter(response => response.status === 409)).toHaveLength(4);
  const id = ids[responses.findIndex(response => response.status === 200)]!;
  expect((await upload(owner.cookie, ticket.id, id)).status).toBe(200);
  const changed = png.slice(); changed[changed.length - 1] = changed.at(-1)! ^ 1;
  expect((await upload(owner.cookie, ticket.id, id, changed)).status).toBe(409);
  expect((await env.FILES.list({ prefix: `support-images/${ticket.id}/` })).objects).toHaveLength(4);
  await env.DB.prepare("UPDATE support_tickets SET status = 'closed' WHERE id = ?1").bind(ticket.id).run();
  expect((await upload(owner.cookie, ticket.id)).status).toBe(409);
});
it('keeps R2 failures private and retries the reserved ID; closure during write cannot publish an attachment', async () => {
  const owner = await actor(), ticket = await create(owner.cookie), id = crypto.randomUUID(); const app = createApp();
  const request = () => new Request(imageUrl(ticket.id, id), { method: 'PUT', headers: { cookie: owner.cookie, 'content-type': 'image/png' }, body: png });
  const failingEnv = { ...env, FILES: { put: async () => { throw new Error('private storage failure'); } } as unknown as R2Bucket };
  const failed = await app.fetch(request(), failingEnv); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('private storage');
  expect((await SELF.fetch(imageUrl(ticket.id, id), { headers: { cookie: owner.cookie } })).status).toBe(404);
  expect((await upload(owner.cookie, ticket.id, id)).status).toBe(200);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM support_ticket_images WHERE ticket_id = ?1').bind(ticket.id).first<{ n: number }>())?.n).toBe(1);
  const nextId = crypto.randomUUID();
  const closingEnv = { ...env, FILES: { put: async () => { await env.DB.prepare("UPDATE support_tickets SET status = 'closed' WHERE id = ?1").bind(ticket.id).run(); } } as unknown as R2Bucket };
  const raced = await app.fetch(new Request(imageUrl(ticket.id, nextId), { method: 'PUT', headers: { cookie: owner.cookie, 'content-type': 'image/png' }, body: png }), closingEnv);
  expect(raced.status).toBe(409); expect((await SELF.fetch(imageUrl(ticket.id, nextId), { headers: { cookie: owner.cookie } })).status).toBe(404);
});
it('limits repeated upload attempts server-side', async () => {
  const owner = await actor(), ticket = await create(owner.cookie);
  for (let i = 0; i < 60; i++) await consumePasswordRateLimit(env, 'support-image-user', owner.userId, 60, 3600);
  expect((await upload(owner.cookie, ticket.id)).status).toBe(429);
});
