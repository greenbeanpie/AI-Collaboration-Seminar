import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv, SessionUser } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { newId, nowIso } from '../core/db';
import { requireUser } from '../core/auth';
import { accountRoleSql } from '../core/account-role';
import { decodeCursor, encodeCursor } from '../core/pagination';
import { invalidState, notFound, permissionDenied, validationFailed } from '../core/errors';
import { consumePasswordRateLimit } from '../services/accounts';

const status = z.enum(['pending', 'in_progress', 'waiting_user', 'resolved', 'closed']);
const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+$/);
const summary = z.object({ id: z.string().uuid(), title: z.string(), status, revision: z.number().int(), ownerId: z.string().uuid(), ownerName: z.string(), createdAt: z.string(), updatedAt: z.string() });
const ticket = summary.extend({ body: z.string() });
const message = z.object({ id: z.string().uuid(), authorId: z.string().uuid(), authorName: z.string(), kind: z.enum(['reply', 'status']), body: z.string(), status: status.nullable(), createdAt: z.string() });
const params = z.object({ ticketId: z.string().uuid() });
const paging = z.object({ cursor: z.string().max(256).optional(), limit: z.string().regex(/^(?:[1-9]\d?|100)$/).transform(Number).optional() });
const ok = (schema: z.ZodType, description: string) => ({ content: { 'application/json': { schema } }, description });
const listRoute = createRoute({ method: 'get', path: '/api/v1/support/tickets', tags: ['support'], request: { query: paging.extend({ status: status.optional() }) }, responses: { 200: ok(apiEnvelope(z.object({ items: z.array(summary), nextCursor: z.string().nullable() }), 'SupportTicketListResponse'), '自己的工单；管理员可查看全部') } });
const createRouteDef = createRoute({ method: 'post', path: '/api/v1/support/tickets', tags: ['support'], request: { body: { required: true, content: { 'application/json': { schema: z.object({ title: text(160), body: text(8000) }).strict() } } } }, responses: { 201: ok(apiEnvelope(z.object({ ticket }), 'SupportTicketResponse'), '工单已创建') } });
const detailRoute = createRoute({ method: 'get', path: '/api/v1/support/tickets/{ticketId}', tags: ['support'], request: { params }, responses: { 200: ok(apiEnvelope(z.object({ ticket }), 'SupportTicketResponse'), '工单详情') } });
const messagesRoute = createRoute({ method: 'get', path: '/api/v1/support/tickets/{ticketId}/messages', tags: ['support'], request: { params, query: paging }, responses: { 200: ok(apiEnvelope(z.object({ items: z.array(message), nextCursor: z.string().nullable() }), 'SupportTicketMessagesResponse'), '回复和状态历史') } });
const replyRoute = createRoute({ method: 'post', path: '/api/v1/support/tickets/{ticketId}/messages', tags: ['support'], request: { params, body: { required: true, content: { 'application/json': { schema: z.object({ body: text(8000) }).strict() } } } }, responses: { 201: ok(apiEnvelope(z.object({ id: z.string().uuid() }), 'SupportTicketReplyResponse'), '回复已保存') } });
const statusRoute = createRoute({ method: 'patch', path: '/api/v1/support/tickets/{ticketId}/status', tags: ['support'], request: { params, body: { required: true, content: { 'application/json': { schema: z.object({ status, revision: z.number().int().min(1) }).strict() } } } }, responses: { 200: ok(apiEnvelope(z.object({ ticket }), 'SupportTicketResponse'), '管理员已更新状态') } });
type Ticket = z.infer<typeof ticket>;
const selectTicket = 'SELECT t.id, t.title, t.body, t.status, t.revision, t.owner_id AS ownerId, u.display_name AS ownerName, t.created_at AS createdAt, t.updated_at AS updatedAt FROM support_tickets t JOIN users u ON u.id = t.owner_id';
const actorAdmin = `EXISTS (SELECT 1 FROM auth_accounts actor WHERE actor.user_id = ?2 AND ${accountRoleSql.replaceAll('account_role', 'actor.account_role').replaceAll('is_admin', 'actor.is_admin')} IN ('admin','super_admin'))`;
function page(query: { cursor?: string; limit?: number }) {
  const cursor = decodeCursor(query.cursor);
  if (query.cursor && (!cursor || !z.string().uuid().safeParse(cursor.id).success || !z.string().datetime().safeParse(cursor.createdAt).success)) throw validationFailed('分页游标无效');
  return { cursor, limit: query.limit ?? 20 };
}
async function readable(db: D1Database, id: string, user: SessionUser): Promise<Ticket> {
  const row = await db.prepare(`${selectTicket} WHERE t.id = ?1 AND (t.owner_id = ?2 OR ?3 = 1)`).bind(id, user.id, user.role !== 'user' ? 1 : 0).first<Ticket>();
  if (!row) throw notFound('工单不存在');
  return row;
}
export function registerSupportTicketRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/support/*', requireUser);
  app.openapi(listRoute, async c => {
    const user = c.get('user')!; const query = c.req.valid('query'); const { cursor, limit } = page(query);
    const rows = await c.env.DB.prepare(`${selectTicket} WHERE (t.owner_id = ?1 OR ?2 = 1) AND (?3 IS NULL OR t.status = ?3)
      AND (?4 IS NULL OR t.created_at < ?4 OR (t.created_at = ?4 AND t.id < ?5)) ORDER BY t.created_at DESC, t.id DESC LIMIT ?6`)
      .bind(user.id, user.role !== 'user' ? 1 : 0, query.status ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1).all<Ticket>();
    const items = rows.results.slice(0, limit); const last = items.at(-1);
    return c.json(apiData(c, { items: items.map(({ body: _body, ...item }) => item), nextCursor: rows.results.length > limit && last ? encodeCursor({ id: last.id, createdAt: last.createdAt }) : null }), 200);
  });
  app.openapi(createRouteDef, async c => {
    const user = c.get('user')!;
    await consumePasswordRateLimit(c.env, 'support-create-user', user.id, 10, 3600);
    await consumePasswordRateLimit(c.env, 'support-create-ip', c.req.header('cf-connecting-ip') ?? 'unknown', 30, 3600);
    const input = c.req.valid('json'); const id = newId(); const now = nowIso();
    await c.env.DB.prepare('INSERT INTO support_tickets (id, owner_id, title, body, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)').bind(id, user.id, input.title, input.body, now).run();
    return c.json(apiData(c, { ticket: await readable(c.env.DB, id, user) }), 201);
  });
  app.openapi(detailRoute, async c => c.json(apiData(c, { ticket: await readable(c.env.DB, c.req.valid('param').ticketId, c.get('user')!) }), 200));
  app.openapi(messagesRoute, async c => {
    const id = c.req.valid('param').ticketId; await readable(c.env.DB, id, c.get('user')!);
    const { cursor, limit } = page(c.req.valid('query'));
    const rows = await c.env.DB.prepare(`SELECT m.id, m.author_id AS authorId, u.display_name AS authorName, m.kind, m.body, m.status, m.created_at AS createdAt
      FROM support_ticket_messages m JOIN users u ON u.id = m.author_id WHERE m.ticket_id = ?1
      AND (?2 IS NULL OR m.created_at > ?2 OR (m.created_at = ?2 AND m.id > ?3)) ORDER BY m.created_at, m.id LIMIT ?4`)
      .bind(id, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1).all<z.infer<typeof message>>();
    const items = rows.results.slice(0, limit); const last = items.at(-1);
    return c.json(apiData(c, { items, nextCursor: rows.results.length > limit && last ? encodeCursor({ id: last.id, createdAt: last.createdAt }) : null }), 200);
  });
  app.openapi(replyRoute, async c => {
    const user = c.get('user')!; const ticketId = c.req.valid('param').ticketId; await readable(c.env.DB, ticketId, user);
    await consumePasswordRateLimit(c.env, 'support-reply-user', user.id, 60, 3600);
    const id = newId(); const now = nowIso();
    const result = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO support_ticket_messages (id,ticket_id,author_id,kind,body,created_at)
        SELECT ?3, id, ?2, 'reply', ?4, ?5 FROM support_tickets WHERE id = ?1 AND status != 'closed' AND (owner_id = ?2 OR ${actorAdmin})`)
        .bind(ticketId, user.id, id, c.req.valid('json').body, now),
      c.env.DB.prepare('UPDATE support_tickets SET updated_at = ?2 WHERE id = ?1 AND EXISTS (SELECT 1 FROM support_ticket_messages WHERE id = ?3)').bind(ticketId, now, id),
    ]);
    if (result[0]?.meta.changes !== 1) throw invalidState('工单已关闭或权限已变化，请刷新后重试');
    return c.json(apiData(c, { id }), 201);
  });
  app.openapi(statusRoute, async c => {
    const user = c.get('user')!; if (user.role === 'user') throw permissionDenied('只有管理员可以更改工单状态');
    const id = c.req.valid('param').ticketId; await readable(c.env.DB, id, user);
    await consumePasswordRateLimit(c.env, 'support-status-user', user.id, 120, 3600);
    const input = c.req.valid('json'); const now = nowIso();
    const result = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE support_tickets SET status = ?3, revision = revision + 1, updated_at = ?4 WHERE id = ?1 AND revision = ?5 AND ${actorAdmin}`)
        .bind(id, user.id, input.status, now, input.revision),
      c.env.DB.prepare("INSERT INTO support_ticket_messages (id,ticket_id,author_id,kind,body,status,created_at) SELECT ?1,?2,?3,'status',?4,?4,?5 WHERE changes() = 1")
        .bind(newId(), id, user.id, input.status, now),
    ]);
    if (result[0]?.meta.changes !== 1) throw invalidState('工单状态或管理员权限已变化，请刷新后重试');
    return c.json(apiData(c, { ticket: await readable(c.env.DB, id, user) }), 200);
  });
}
