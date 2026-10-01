import type { Env } from '../env';
import { invalidState } from '../core/errors';
import { nowIso } from '../core/db';

export interface ProfileRow {
  user_id: string; searchable: number; bio: string; major: string; specialties: string; preferred_roles: string;
  bio_public: number; major_public: number; specialties_public: number; preferred_roles_public: number;
  revision: number; ai_use_allowed: number;
}
export function ownProfile(row: ProfileRow | null) {
  return { searchable: !!row?.searchable, aiUseAllowed: row?.ai_use_allowed === 1, revision: row?.revision ?? 0,
    bio: row?.bio ?? '', major: row?.major ?? '', specialties: row?.specialties ?? '', preferredRoles: row?.preferred_roles ?? '',
    visibility: { bio: !!row?.bio_public, major: !!row?.major_public, specialties: !!row?.specialties_public, preferredRoles: !!row?.preferred_roles_public } };
}
export function publicProfile(row: ProfileRow & { username: string; display_name: string }) {
  return { username: row.username, displayName: row.display_name,
    ...(row.bio_public ? { bio: row.bio } : {}), ...(row.major_public ? { major: row.major } : {}),
    ...(row.specialties_public ? { specialties: row.specialties } : {}), ...(row.preferred_roles_public ? { preferredRoles: row.preferred_roles } : {}) };
}
/** Only IDs, revisions and consent state persist in jobs. Never copy personal text to jobs. */
export async function profileStamp(env: Env, projectId: string): Promise<string> {
  const rows = await env.DB.prepare(`SELECT m.id,m.user_id,COALESCE(p.revision,0) profile_revision,COALESCE(p.ai_use_allowed,0) ai_use_allowed
    FROM project_members m LEFT JOIN personal_profiles p ON p.user_id=m.user_id WHERE m.project_id=?1 ORDER BY m.id`).bind(projectId).all();
  return JSON.stringify(rows.results);
}
export async function assertProfileStamp(env: Env, projectId: string, expected: string | undefined) {
  if (!expected || await profileStamp(env, projectId) !== expected) throw invalidState('成员或个人资料已变化，请重新生成任务推荐');
}
/** Last dispatch read: current text, consent, member scope and config validity share one DB snapshot. */
export async function recommendationDispatch(env: Env, projectId: string, requestedBy: string, expectedStamp: string | undefined, configVersionId: string) {
  if (!expectedStamp) throw invalidState('缺少个人资料授权快照，请重新生成推荐');
  const guard = profileSnapshotGuard('?2','?1');
  const row = await env.DB.prepare(`/* recommendation-dispatch */ SELECT
    (SELECT json_group_array(json_object('userId',m.user_id,'loadHours',COALESCE((SELECT SUM(t.effort_hours) FROM tasks t WHERE t.project_id=m.project_id AND t.assignee_id=m.user_id AND t.status!='done'),0)))
      FROM project_members m WHERE m.project_id=?1) members_json,
    (SELECT json_group_array(json_object('userId',m.user_id,'bio',p.bio,'major',p.major,'specialties',p.specialties,'preferredRoles',p.preferred_roles))
      FROM project_members m JOIN personal_profiles p ON p.user_id=m.user_id WHERE m.project_id=?1 AND p.ai_use_allowed=1) profiles_json
    WHERE ${guard}
      AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?3)
      AND EXISTS(SELECT 1 FROM ai_config_versions WHERE id=?4 AND enabled=1 AND version=(SELECT MAX(version) FROM ai_config_versions))`)
    .bind(projectId,expectedStamp,requestedBy,configVersionId).first<{members_json:string;profiles_json:string}>();
  if (!row) throw invalidState('资料授权、成员或 AI 设置已变化，请重新生成推荐');
  // Only synchronous parsing follows the last read; the caller must not await other I/O before fetch.
  return { members:JSON.parse(row.members_json) as Array<{userId:string;loadHours:number}>,
    preferences:JSON.parse(row.profiles_json) as Array<{userId:string;bio:string;major:string;specialties:string;preferredRoles:string}> };
}

/** Trusted SQL expressions only; gate reads and publication against the current consent snapshot. */
export function profileSnapshotGuard(stamp: string, projectId: string): string {
  return `(json_valid(${stamp})=1 AND json_type(${stamp})='array'
    AND json_array_length(${stamp})=(SELECT COUNT(*) FROM project_members WHERE project_id=${projectId})
    AND NOT EXISTS(SELECT 1 FROM json_each(${stamp}) snap WHERE NOT EXISTS(
      SELECT 1 FROM project_members pm LEFT JOIN personal_profiles pp ON pp.user_id=pm.user_id
      WHERE pm.project_id=${projectId} AND pm.id=json_extract(snap.value,'$.id') AND pm.user_id=json_extract(snap.value,'$.user_id')
      AND COALESCE(pp.revision,0)=json_extract(snap.value,'$.profile_revision')
      AND COALESCE(pp.ai_use_allowed,0)=json_extract(snap.value,'$.ai_use_allowed'))))`;
}

/** Prevent a withdrawal between the final runtime check and the result UPDATE from publishing output. */
export async function finishRecommendationJob(env: Env, jobId: string, result: unknown) {
  const guard = profileSnapshotGuard("json_extract(jobs.input_json,'$.profileStamp')",'jobs.project_id');
  const changed = await env.DB.prepare(`UPDATE jobs SET status='succeeded',result_json=?2,finished_at=?3,updated_at=?3
    WHERE id=?1 AND status IN ('running','queued') AND ${guard}`).bind(jobId,JSON.stringify(result),nowIso()).run();
  if (!changed.meta.changes) throw invalidState('个人资料授权或成员已变化，推荐未发布，请重新生成');
  await env.DB.prepare("UPDATE job_outbox SET status='done',updated_at=?2 WHERE job_id=?1").bind(jobId,nowIso()).run();
}
