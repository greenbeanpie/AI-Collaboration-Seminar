import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { newId, nowIso } from '../core/db';
import { accountRoleSql, type AccountRole } from '../core/account-role';
import { invalidState, notFound, permissionDenied } from '../core/errors';

const role = z.enum(['super_admin', 'admin', 'user']);
const user = z.object({ id: z.string().uuid(), username: z.string().nullable(), email: z.string().nullable(), displayName: z.string(), role, isAdmin: z.boolean() });
const params = z.object({ userId: z.string().uuid() });
const response = { 200: { content: { 'application/json': { schema: apiEnvelope(z.object({ user }), 'AdminAccountResponse') } }, description: '账户已更新' } };
const list = createRoute({ method: 'get', path: '/api/v1/admin/accounts', tags: ['admin'], request: { query: z.object({ cursor: z.string().uuid().optional() }) }, responses: { 200: { content: { 'application/json': { schema: apiEnvelope(z.object({ items: z.array(user), nextCursor: z.string().nullable() }), 'AdminAccountListResponse') } }, description: '账户列表（不含凭据）' } } });
const changeRole = createRoute({ method: 'patch', path: '/api/v1/admin/accounts/{userId}/role', tags: ['admin'], request: { params, body: { required: true, content: { 'application/json': { schema: z.object({ role }).strict() } } } }, responses: response });
const profile = createRoute({ method: 'patch', path: '/api/v1/admin/accounts/{userId}/profile', tags: ['admin'], request: { params, body: { required: true, content: { 'application/json': { schema: z.object({ displayName: z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f\u007f]+$/) }).strict() } } } }, responses: response });
type Account = { id: string; username: string | null; email: string | null; displayName: string; role: AccountRole };
const select = `SELECT a.user_id AS id, a.username, a.contact_email AS email, u.display_name AS displayName, ${accountRoleSql} AS role FROM auth_accounts a JOIN users u ON u.id = a.user_id`;
const dto = (row: Account) => ({ ...row, isAdmin: row.role !== 'user' });

export function registerAdminAccountRoutes(app: OpenAPIHono<AppEnv>): void {
  // Existing operational bearer credentials intentionally cannot access new account APIs.
  app.use('/api/v1/admin/accounts', async (c, next) => { if (!c.get('user')) throw permissionDenied('需要管理员账户登录'); await next(); });
  app.use('/api/v1/admin/accounts/*', async (c, next) => { if (!c.get('user')) throw permissionDenied('需要管理员账户登录'); await next(); });
  app.openapi(list, async c => {
    const rows = await c.env.DB.prepare(`${select} WHERE a.user_id > ?1 ORDER BY a.user_id LIMIT 101`).bind(c.req.valid('query').cursor ?? '').all<Account>();
    const items = rows.results.slice(0, 100);
    return c.json(apiData(c, { items: items.map(dto), nextCursor: rows.results.length > 100 ? items[99]!.id : null }), 200);
  });
  app.openapi(changeRole, async c => {
    const actor = c.get('user')!;
    if (actor.role !== 'super_admin') throw permissionDenied('只有超级管理员可以更改账户等级');
    const targetId = c.req.valid('param').userId;
    const newRole = c.req.valid('json').role;
    const target = await c.env.DB.prepare(`${select} WHERE a.user_id = ?1`).bind(targetId).first<Account>();
    if (!target) throw notFound('账户不存在');
    // Both the actor role and last-super-admin invariant are checked in the mutation,
    // so concurrent demotions cannot act on a stale middleware/target snapshot.
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE auth_accounts SET account_role = ?2, is_admin = ?3
        WHERE user_id = ?1 AND ${accountRoleSql} = ?4
        AND EXISTS (SELECT 1 FROM auth_accounts actor WHERE actor.user_id = ?5 AND actor.account_role = 'super_admin')
        AND (account_role IS NOT 'super_admin' OR ?2 = 'super_admin'
          OR (SELECT COUNT(*) FROM auth_accounts WHERE account_role = 'super_admin' AND length(trim(COALESCE(username, ''))) > 0 AND length(trim(COALESCE(username_norm, ''))) > 0 AND length(trim(COALESCE(password_hash, ''))) > 0) > 1)
        AND (?2 != 'super_admin' OR (length(trim(COALESCE(username, ''))) > 0 AND length(trim(COALESCE(username_norm, ''))) > 0 AND length(trim(COALESCE(password_hash, ''))) > 0))`)
        .bind(targetId, newRole, newRole === 'user' ? 0 : 1, target.role, actor.id),
      c.env.DB.prepare('INSERT INTO account_role_audit (id, actor_id, target_id, previous_role, new_role, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE changes() = 1')
        .bind(newId(), actor.id, targetId, target.role, newRole, nowIso()),
    ]);
    if (results[0]?.meta.changes !== 1) throw invalidState('必须保留至少一位可登录的超级管理员；账户状态可能已变化，请刷新后重试');
    return c.json(apiData(c, { user: dto({ ...target, role: newRole }) }), 200);
  });
  app.openapi(profile, async c => {
    const actor = c.get('user')!;
    const targetId = c.req.valid('param').userId;
    const target = await c.env.DB.prepare(`${select} WHERE a.user_id = ?1`).bind(targetId).first<Account>();
    if (!target) throw notFound('账户不存在');
    if (actor.role !== 'super_admin' && target.role !== 'user') throw permissionDenied('普通管理员只能管理一般用户');
    const { displayName } = c.req.valid('json');
    const result = await c.env.DB.prepare(`UPDATE users SET display_name = ?2 WHERE id = ?1
      AND EXISTS (SELECT 1 FROM auth_accounts actor WHERE actor.user_id = ?3 AND
        (actor.account_role = 'super_admin' OR (${accountRoleSql.replaceAll('account_role', 'actor.account_role').replaceAll('is_admin', 'actor.is_admin')} = 'admin'
          AND EXISTS (SELECT 1 FROM auth_accounts target WHERE target.user_id = ?1 AND ${accountRoleSql.replaceAll('account_role', 'target.account_role').replaceAll('is_admin', 'target.is_admin')} = 'user'))))`)
      .bind(targetId, displayName, actor.id).run();
    if (result.meta.changes !== 1) throw permissionDenied('账户权限已变化，请刷新后重试');
    return c.json(apiData(c, { user: dto({ ...target, displayName }) }), 200);
  });
}
