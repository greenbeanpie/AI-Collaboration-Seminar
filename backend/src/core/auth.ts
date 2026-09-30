import { accountRole, type AccountRole } from './account-role';
import { createMiddleware } from 'hono/factory';
import type { AppEnv, Env, SessionUser } from '../env';
import { nowIso, sha256Hex } from './db';
import { notFound, permissionDenied, unauthenticated } from './errors';

export const SESSION_COOKIE = 'ai_office_session';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) { try { out[key] = decodeURIComponent(value); } catch { /* Malformed cookie cannot authenticate. */ } }
  }
  return out;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  return attrs.join('; ');
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * 会话校验：读取 Cookie 中的令牌，仅按哈希查库（DB 不存明文）。
 * 不做滑动续期（首版固定 7 天）。
 */
/** Only sessions issued by password authentication can access business or admin routes. */
export async function loadSessionUser(env: Env, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, a.username, a.contact_email, u.display_name, a.is_admin, a.account_role
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN auth_accounts a ON a.user_id = u.id
      WHERE s.token_hash = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2
        AND s.auth_method = 'password' AND a.password_hash IS NOT NULL`,
  ).bind(await sha256Hex(token), nowIso()).first<{ id: string; username: string | null; contact_email: string | null; display_name: string; is_admin: number; account_role: AccountRole | null }>();
  return row ? { id: row.id, username: row.username, email: row.contact_email, displayName: row.display_name, role: accountRole(row), isAdmin: accountRole(row) !== 'user' } : null;
}

export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
  const user = await loadSessionUser(c.env, parseCookies(c.req.header('cookie'))[SESSION_COOKIE]);
  if (!user) throw unauthenticated();
  c.set('user', user);
  await next();
});

/**
 * 项目成员与角色校验。项目不存在返回 404（不泄露存在性）；
 * 非成员 403；需要 owner 而非 owner 时 403。不信任前端角色信息。
 */
export const requireProjectMember = (options?: { owner?: boolean }) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get('user');
    if (!user) throw unauthenticated();
    const projectId = c.req.param('projectId') ?? '';
    const project = await c.env.DB.prepare('SELECT id FROM projects WHERE id = ?1').bind(projectId).first();
    if (!project) throw notFound('项目不存在');
    const member = await c.env.DB.prepare(
      'SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2',
    )
      .bind(projectId, user.id)
      .first<{ role: 'owner' | 'member' }>();
    if (!member) throw permissionDenied('不是项目成员');
    if (options?.owner && member.role !== 'owner') throw permissionDenied('需要负责人权限');
    c.set('member', { projectId, userId: user.id, role: member.role });
    await next();
  });
