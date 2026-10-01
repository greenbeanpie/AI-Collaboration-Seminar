import type { Env } from '../env';
import { invalidState } from '../core/errors';

export interface ProfileRow {
  user_id: string; searchable: number; bio: string; major: string; specialties: string; preferred_roles: string;
  bio_public: number; major_public: number; specialties_public: number; preferred_roles_public: number;
  revision: number;
}
export function ownProfile(row: ProfileRow | null) {
  return { searchable: !!row?.searchable, revision: row?.revision ?? 0,
    bio: row?.bio ?? '', major: row?.major ?? '', specialties: row?.specialties ?? '', preferredRoles: row?.preferred_roles ?? '',
    visibility: { bio: !!row?.bio_public, major: !!row?.major_public, specialties: !!row?.specialties_public, preferredRoles: !!row?.preferred_roles_public } };
}
export function publicProfile(row: ProfileRow & { username: string; display_name: string }) {
  return { username: row.username, displayName: row.display_name,
    ...(row.bio_public ? { bio: row.bio } : {}), ...(row.major_public ? { major: row.major } : {}),
    ...(row.specialties_public ? { specialties: row.specialties } : {}), ...(row.preferred_roles_public ? { preferredRoles: row.preferred_roles } : {}) };
}
/** Only membership IDs and revision numbers persist in jobs. Private text is read just-in-time, never copied to jobs. */
export async function profileStamp(env: Env, projectId: string): Promise<string> {
  const rows = await env.DB.prepare(`SELECT m.id,m.user_id,COALESCE(p.revision,0) profile_revision
    FROM project_members m LEFT JOIN personal_profiles p ON p.user_id=m.user_id WHERE m.project_id=?1 ORDER BY m.id`).bind(projectId).all();
  return JSON.stringify(rows.results);
}
export async function assertProfileStamp(env: Env, projectId: string, expected: string | undefined) {
  if (!expected || await profileStamp(env, projectId) !== expected) throw invalidState('成员或个人资料已变化，请重新生成任务推荐');
}
export async function recommendationProfiles(env: Env, projectId: string) {
  const rows = await env.DB.prepare(`SELECT m.user_id,p.bio,p.major,p.specialties,p.preferred_roles
    FROM project_members m JOIN personal_profiles p ON p.user_id=m.user_id WHERE m.project_id=?1 ORDER BY m.user_id`).bind(projectId)
    .all<{ user_id: string; bio: string; major: string; specialties: string; preferred_roles: string }>();
  return rows.results.map(p => ({ userId: p.user_id, bio: p.bio, major: p.major, specialties: p.specialties, preferredRoles: p.preferred_roles }));
}
