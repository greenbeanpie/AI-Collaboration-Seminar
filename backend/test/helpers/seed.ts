import { env } from './env';
import { newId, nowIso, sha256Hex } from '../../src/core/db';
import { SESSION_COOKIE } from '../../src/core/auth';
import { DUMMY_PASSWORD_HASH } from '../../src/services/password';

const futureIso = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

export interface SeededUser {
  userId: string;
  email: string;
  token: string;
}

/** Trusted test fixture: account + password-method session. Actual password flow has separate tests. */
export async function seedUser(email = 'owner@example.com', displayName = '测试用户'): Promise<SeededUser> {
  const userId = newId();
  const token = `tok-${newId()}`;
  const uniqueEmail = email.replace('@', `-${newId().slice(0, 8)}@`);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, email, display_name, created_at) VALUES (?1, ?2, ?3, ?4)').bind(
      userId,
      uniqueEmail,
      displayName,
      nowIso(),
    ),
    env.DB.prepare("INSERT INTO auth_accounts (user_id, username, username_norm, contact_email, contact_email_norm, password_hash, created_at) VALUES (?1, ?2, ?2, ?3, ?3, ?4, ?5)").bind(userId, `fixture-${userId}`, uniqueEmail, DUMMY_PASSWORD_HASH, nowIso()),
    env.DB.prepare(
      "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, auth_method) VALUES (?1, ?2, ?3, ?4, ?5, 'password')",
    ).bind(newId(), userId, await sha256Hex(token), futureIso(7), nowIso()),
  ]);
  return { userId, email: uniqueEmail, token };
}

export async function seedProject(ownerUserId: string, name = '测试项目'): Promise<string> {
  const projectId = newId();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, name, description, status, revision, created_by, created_at, updated_at) VALUES (?1, ?2, '', 'active', 1, ?3, ?4, ?4)",
    ).bind(projectId, name, ownerUserId, nowIso()),
    env.DB.prepare(
      "INSERT INTO project_members (id, project_id, user_id, role, joined_at) VALUES (?1, ?2, ?3, 'owner', ?4)",
    ).bind(newId(), projectId, ownerUserId, nowIso()),
  ]);
  return projectId;
}

export const authCookie = (token: string): string => `${SESSION_COOKIE}=${token}`;
