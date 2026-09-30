import { SELF } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedUser } from './helpers/seed';
import { consumePasswordRateLimit } from '../src/services/accounts';
import { ADMIN_TOKEN } from './helpers/constants';
import { decodeCursor, encodeCursor } from '../src/core/pagination';
async function actor(role = 'user') { const u = await seedUser(); await env.DB.prepare('UPDATE auth_accounts SET account_role = ?2, is_admin = ?3 WHERE user_id = ?1').bind(u.userId, role, role === 'user' ? 0 : 1).run(); return { ...u, cookie: authCookie(u.token) }; }
async function call(cookie: string | undefined, path = '', method = 'GET', body?: unknown) {
 return SELF.fetch(`${BASE}/api/v1/support/tickets${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function create(cookie: string, title = '需要帮助') { const r = await call(cookie, '', 'POST', { title, body: '<script>alert(1)</script>\n文字问题' }); expect(r.status).toBe(201); return (await r.json() as { data: { ticket: { id: string; revision: number; status: string } } }).data.ticket; }
beforeEach(async () => { await env.DB.prepare('DELETE FROM auth_password_rate_limits').run(); });
it('password session required; guests, old OTP and operator bearer cannot enter support', async () => {
 expect((await call(undefined)).status).toBe(401);
 expect((await SELF.fetch(`${BASE}/api/v1/support/tickets`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).status).toBe(401);
 const u = await actor(); await env.DB.prepare("UPDATE sessions SET auth_method = 'legacy' WHERE user_id = ?1").bind(u.userId).run();
 expect((await call(u.cookie)).status).toBe(401);
});
it('owner-only list, detail, history and replies prevent IDOR, including forged creation owner/status', async () => {
 const a = await actor(), b = await actor(); const ticket = await create(a.cookie);
 const own = await call(a.cookie); const ownText = JSON.stringify(await own.json()); expect(ownText).toContain(ticket.id); expect(ownText).not.toContain('<script>');
 const other = await call(b.cookie); expect(JSON.stringify(await other.json())).not.toContain(ticket.id);
 for (const suffix of ['', '/messages']) expect((await call(b.cookie, `/${ticket.id}${suffix}`)).status).toBe(404);
 expect((await call(b.cookie, `/${ticket.id}/messages`, 'POST', { body: 'intrusion' })).status).toBe(404);
 expect((await call(b.cookie, `/${ticket.id}/status`, 'PATCH', { status: 'closed', revision: 1 })).status).toBe(403);
 expect((await call(a.cookie, '', 'POST', { title: 'bad', body: 'bad', ownerId: b.userId, status: 'closed' })).status).toBe(400);
 expect((await call(a.cookie, `/${ticket.id}/messages`, 'POST', { body: '我的回复' })).status).toBe(201);
 const detailText = await (await call(a.cookie, `/${ticket.id}`)).text(); expect(detailText).toContain('<script>'); expect(detailText).not.toContain(a.email); expect(detailText).not.toContain('password_hash');
});
it('both admin levels see and reply to all tickets, with auditable status changes', async () => {
 const owner = await actor(); const ticket = await create(owner.cookie);
 for (const role of ['admin', 'super_admin']) {
  const admin = await actor(role);
  expect(await (await call(admin.cookie)).text()).toContain(ticket.id);
  expect((await call(admin.cookie, `/${ticket.id}`)).status).toBe(200);
  expect((await call(admin.cookie, `/${ticket.id}/messages`, 'POST', { body: '处理回复' })).status).toBe(201);
  const changed = await call(admin.cookie, `/${ticket.id}/status`, 'PATCH', { status: 'in_progress', revision: ticket.revision++ }); expect(changed.status).toBe(200);
 }
 const history = await (await call(owner.cookie, `/${ticket.id}/messages`)).json() as { data: { items: { kind: string; authorId: string }[] } };
 expect(history.data.items.filter(x => x.kind === 'status')).toHaveLength(2);
});
it('demotion immediately removes global ticket access and status authority on existing session', async () => {
 const owner = await actor(), admin = await actor('admin'); const ticket = await create(owner.cookie);
 await env.DB.prepare("UPDATE auth_accounts SET account_role = 'user', is_admin = 0 WHERE user_id = ?1").bind(admin.userId).run();
 expect(await (await call(admin.cookie)).text()).not.toContain(ticket.id);
 expect((await call(admin.cookie, `/${ticket.id}`)).status).toBe(404);
 expect((await call(admin.cookie, `/${ticket.id}/messages`, 'POST', { body: 'old admin reply' })).status).toBe(404);
 expect((await call(admin.cookie, `/${ticket.id}/status`, 'PATCH', { status: 'resolved', revision: 1 })).status).toBe(403);
});
it('all five states supported; invalid status/revision rejected; closed tickets require reopening for replies', async () => {
 const owner = await actor(), admin = await actor('super_admin'); const ticket = await create(owner.cookie);
 let revision = 1;
 for (const status of ['pending', 'in_progress', 'waiting_user', 'resolved', 'closed']) expect((await call(admin.cookie, `/${ticket.id}/status`, 'PATCH', { status, revision: revision++ })).status).toBe(200);
 expect((await call(owner.cookie, `/${ticket.id}/messages`, 'POST', { body: 'closed reply' })).status).toBe(409);
 expect((await call(admin.cookie, `/${ticket.id}/status`, 'PATCH', { status: 'unknown', revision })).status).toBe(400);
 expect((await call(admin.cookie, `/${ticket.id}/status`, 'PATCH', { status: 'pending', revision: 1 })).status).toBe(409);
 expect((await call(admin.cookie, `/${ticket.id}/status`, 'PATCH', { status: 'pending', revision })).status).toBe(200);
 expect((await call(owner.cookie, `/${ticket.id}/messages`, 'POST', { body: 'reopened reply' })).status).toBe(201);
});
it('strict text bounds and rate limits apply without consuming production services', async () => {
 const u = await actor();
 for (const body of [{ title: ' ', body: 'ok' }, { title: 'x'.repeat(161), body: 'ok' }, { title: 'ok', body: 'x'.repeat(8001) }, { title: 'ok', body: '\u0000' }, { title: 'ok', body: 'ok', attachment: 'file' }]) expect((await call(u.cookie, '', 'POST', body)).status).toBe(400);
 const ticket = await create(u.cookie);
 expect((await call(u.cookie, `/${ticket.id}/messages`, 'POST', { body: ' ' })).status).toBe(400);
 for (let i = 0; i < 9; i++) await consumePasswordRateLimit(env, 'support-create-user', u.userId, 10, 3600);
 expect((await call(u.cookie, '', 'POST', { title: 'limited', body: 'limited' })).status).toBe(429);
});
it('stable pagination has no gaps/duplicates and rejects malformed cursors and limits', async () => {
 const u = await actor(); const ids = new Set<string>();
 for (let n = 0; n < 3; n++) ids.add((await create(u.cookie, `page${n}`)).id);
 const seen: string[] = []; let cursor: string | null = null;
 do {
  const res = await call(u.cookie, `?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
  const data = (await res.json() as { data: { items: { id: string }[]; nextCursor: string | null } }).data;
  seen.push(...data.items.map(x => x.id)); cursor = data.nextCursor;
  if (cursor) expect(Object.keys(decodeCursor(cursor)!)).toEqual(['createdAt', 'id']);
 } while (cursor);
 expect(new Set(seen)).toEqual(ids); expect(seen).toHaveLength(3);
 for (const query of ['?cursor=garbage', '?limit=0', '?limit=101', '?status=invalid', `?cursor=${encodeCursor({ id: 'bad', createdAt: 'bad' })}`]) expect((await call(u.cookie, query)).status).toBe(400);
 const id = seen[0]!; for (let i = 0; i < 3; i++) expect((await call(u.cookie, `/${id}/messages`, 'POST', { body: `message-${i}` })).status).toBe(201);
 const first = (await (await call(u.cookie, `/${id}/messages?limit=2`)).json() as { data: { items: { id: string }[]; nextCursor: string } }).data;
 const second = (await (await call(u.cookie, `/${id}/messages?limit=2&cursor=${first.nextCursor}`)).json() as { data: { items: { id: string }[]; nextCursor: null } }).data;
 expect(new Set([...first.items,...second.items].map(x=>x.id)).size).toBe(3); expect(second.nextCursor).toBeNull();
});
it('concurrent status writes use revision conflict, keeping one matching history event', async () => {
 const u = await actor(), admin = await actor('admin'); const ticket = await create(u.cookie);
 const responses = await Promise.all(['resolved', 'closed'].map(status => call(admin.cookie, `/${ticket.id}/status`, 'PATCH', { status, revision: 1 })));
 expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
 expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM support_ticket_messages WHERE ticket_id = ?1 AND kind = 'status'").bind(ticket.id).first<{ n: number }>())?.n).toBe(1);
});
it('private account and support successes and error responses disable HTTP caching', async () => {
 const user = await actor(), stranger = await actor(), admin = await actor('admin'); const ticket = await create(user.cookie);
 const responses = [
  await call(undefined),
  await call(user.cookie, `/${ticket.id}`),
  await call(stranger.cookie, `/${ticket.id}`),
  await call(user.cookie, '', 'POST', { title: '', body: '' }),
  await call(user.cookie, `/${ticket.id}/status`, 'PATCH', { status: 'closed', revision: 1 }),
  await SELF.fetch(`${BASE}/api/v1/admin/accounts`, { headers: { cookie: admin.cookie } }),
  await SELF.fetch(`${BASE}/api/v1/admin/accounts`, { headers: { cookie: user.cookie } }),
  await SELF.fetch(`${BASE}/api/v1/auth/session`),
  await SELF.fetch(`${BASE}/api/v1/support/tickets`, { method: 'POST', headers: { cookie: user.cookie, origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x', body: 'y' }) }),
 ];
 expect(responses.map(r => r.status)).toEqual([401,200,404,400,403,200,403,401,403]);
 for (const response of responses) expect(response.headers.get('cache-control')).toBe('no-store');
});
