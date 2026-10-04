import type { Env } from '../env';
import { invalidState, quotaExceeded } from '../core/errors';

/** Called only after authenticating the recipient or validating their secret code. */
export async function readInvitationProject(env: Env, projectId: string, userId: string) {
  const project = await env.DB.prepare(`SELECT p.id,p.name,p.description,p.status,p.team_size_limit,
    g.title,g.detail,(SELECT COUNT(*) FROM project_members WHERE project_id=p.id) member_count,
    EXISTS(SELECT 1 FROM project_members WHERE project_id=p.id AND user_id=?2) already_member
    FROM projects p LEFT JOIN project_goals g ON g.project_id=p.id WHERE p.id=?1`)
    .bind(projectId,userId).first<{id:string;name:string;description:string;status:string;team_size_limit:number|null;title:string|null;detail:string|null;member_count:number;already_member:number}>();
  if (!project || project.status !== 'active') throw invalidState('邀请对应的项目不可用');
  if (project.already_member) throw invalidState('你已经是项目成员');
  if (project.team_size_limit !== null && project.member_count >= project.team_size_limit) {
    throw quotaExceeded('项目人数已满', {teamSizeLimit:project.team_size_limit});
  }
  return {projectId:project.id,projectName:project.name,description:project.description,
    goal:{title:project.title ?? '',detail:project.detail ?? ''}};
}
