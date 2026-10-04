import { projectPermissionSql } from './project-permissions';
import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { AppError, invalidState, notFound, permissionDenied, validationFailed } from '../core/errors';
import { consumePasswordRateLimit, normalizeUsername } from './accounts';
import { notificationStatements } from './notifications';
export interface UsernameInvite {
  id: string;
  project_id: string;
  recipient_id: string;
  username: string;
  invited_by: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  expires_at: string;
  handled_at: string | null;
  created_at: string;
}
export async function resolveInviteRecipients(env: Env, userId: string, usernames: string[]) {
  if (new Set(usernames.map(normalizeUsername)).size !== usernames.length) {
    throw validationFailed('邀请用户名不能重复');
  }
  if (usernames.length) {
    await consumePasswordRateLimit(env, 'project-invite-resolve', userId, 60, 3600);
  }
  const result: Array<{
    userId: string;
    username: string;
  }> = [];
  for (const username of usernames) {
    const row = await env.DB.prepare('SELECT user_id,username FROM auth_accounts WHERE username_norm=?1 AND password_hash IS NOT NULL').bind(normalizeUsername(username)).first<{
      user_id: string;
      username: string;
    }>();
    if (!row) {
      throw validationFailed(`无法向用户名「${username}」发送邀请，请核对完整登录用户名`);
    }
    if (row.user_id === userId) {
      throw validationFailed('不能邀请自己');
    }
    result.push({
      userId: row.user_id, username: row.username
    });
  }
  return result;
}
export function invitationNotificationStatements(env: Env, id: string, actorId: string, now: string) {
  return notificationStatements(env, {
    key: `username-invitation:${id}`, kind: 'project_invitation', scope: 'project', resourceId: id, actorId, url: '/app', now, record: {
      table: 'project_username_invitations', id
    }
  });
}
export async function expireUsernameInvites(env: Env, projectId?: string) {
  await env.DB.prepare("UPDATE project_username_invitations SET status='expired',handled_at=?1 WHERE status='pending' AND expires_at<=?1 AND (?2 IS NULL OR project_id=?2)").bind(nowIso(), projectId ?? null).run();
}
/** Diagnose the failed atomic write from fresh state instead of listing guesses. */
async function invitationWriteFailure(env: Env, projectId: string, inviterId: string, recipientId: string, accepting = false): Promise<never> {
  const current = await env.DB.prepare(`SELECT p.status,p.team_size_limit,
    ${projectPermissionSql('p.id','?2','teamManage')} inviter_active,
    EXISTS(SELECT 1 FROM project_members WHERE project_id=p.id AND user_id=?3) already_member,
    (SELECT COUNT(*) FROM project_members WHERE project_id=p.id) member_count
    FROM projects p WHERE p.id=?1`).bind(projectId, inviterId, recipientId).first<{status:string;team_size_limit:number|null;inviter_active:number;already_member:number;member_count:number}>();
  if (!current) throw notFound('项目不存在');
  if (current.status !== 'active') throw invalidState('项目已归档，不能邀请新成员');
  if (!current.inviter_active) {
    if (accepting) throw invalidState('邀请发起人已不再是项目管理员');
    throw permissionDenied('当前账号已没有团队管理权限');
  }
  if (current.already_member) throw invalidState(accepting ? '你已经是项目成员' : '对方已经是项目成员');
  if (current.team_size_limit !== null && current.member_count >= current.team_size_limit) {
    throw new AppError('QUOTA_EXCEEDED', `项目人数已达到上限：${current.member_count}/${current.team_size_limit}（含负责人）`, 409, false, {teamSizeLimit:current.team_size_limit,memberCount:current.member_count});
  }
  throw invalidState('邀请未成功保存，请刷新后重试');
}
export async function sendUsernameInvite(env: Env, projectId: string, inviterId: string, username: string, expiresInDays: number, approvalRequestId?: string) {
  const inviter = await env.DB.prepare(`SELECT 1 FROM projects p WHERE p.id=?1 AND p.status='active' AND ${projectPermissionSql('p.id','?2','teamManage')}`).bind(projectId, inviterId).first();
  if (!inviter) {
    throw permissionDenied('需要当前有效的项目团队管理权限');
  }
  const [recipient] = await resolveInviteRecipients(env, inviterId, [username]);
  if (!recipient) {
    throw validationFailed('用户名不可用');
  }
  await expireUsernameInvites(env, projectId);
  if (await env.DB.prepare('SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2').bind(projectId, recipient.userId).first()) {
    throw invalidState('对方已经是项目成员');
  }
  const prior = await env.DB.prepare("SELECT id FROM project_username_invitations WHERE project_id=?1 AND recipient_id=?2 AND status='pending'").bind(projectId, recipient.userId).first<{
    id: string;
  }>();
  if (prior) {
    if(approvalRequestId)await env.DB.prepare(`UPDATE project_invitation_requests SET status='approved',revision=revision+1,decided_by=?3,invitation_id=?4,decided_at=?5 WHERE id=?1 AND project_id=?2 AND status='pending' AND ${projectPermissionSql('?2','?3','teamManage')}`).bind(approvalRequestId,projectId,inviterId,prior.id,nowIso()).run();
    return prior.id;
  }
  const id = newId(), now = nowIso(), expires = new Date(Date.now() + expiresInDays * 86400000).toISOString();
  const result = await env.DB.batch([env.DB.prepare(`INSERT INTO project_username_invitations(id,project_id,recipient_id,username,invited_by,expires_at,created_at)
 SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM project_members m JOIN projects p ON p.id=m.project_id WHERE m.project_id=?2 AND m.user_id=?5 AND ${projectPermissionSql('m.project_id','m.user_id','teamManage')} AND p.status='active' AND (p.team_size_limit IS NULL OR (SELECT COUNT(*) FROM project_members WHERE project_id=?2)<p.team_size_limit)) AND (?8 IS NULL OR EXISTS(SELECT 1 FROM project_invitation_requests WHERE id=?8 AND project_id=?2 AND status='pending')) AND NOT EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?3) ON CONFLICT DO NOTHING`).bind(id, projectId, recipient.userId, recipient.username, inviterId, expires, now,approvalRequestId??null), ...(approvalRequestId?[env.DB.prepare(`UPDATE project_invitation_requests SET status='approved',revision=revision+1,decided_by=?3,invitation_id=?4,decided_at=?5 WHERE id=?1 AND project_id=?2 AND status='pending' AND EXISTS(SELECT 1 FROM project_username_invitations WHERE id=?4) AND ${projectPermissionSql('?2','?3','teamManage')}`).bind(approvalRequestId,projectId,inviterId,id,now)]:[]), ...invitationNotificationStatements(env, id, inviterId, now)]);
  if (!result[0]?.meta.changes) {
    const duplicate = await env.DB.prepare("SELECT id FROM project_username_invitations WHERE project_id=?1 AND recipient_id=?2 AND status='pending'").bind(projectId, recipient.userId).first<{
      id: string;
    }>();
    if (duplicate) {
      return duplicate.id;
    }
    await invitationWriteFailure(env, projectId, inviterId, recipient.userId);
  }
  return id;
}
export async function handleUsernameInvite(env: Env, id: string, userId: string, action: 'accept' | 'decline') {
  await expireUsernameInvites(env);
  const invite = await env.DB.prepare('SELECT * FROM project_username_invitations WHERE id=?1 AND recipient_id=?2').bind(id, userId).first<UsernameInvite>();
  if (!invite) {
    throw notFound('邀请不存在');
  }
  const target = action === 'accept' ? 'accepted' : 'declined';
  if (invite.status === target) {
    return {
      id, status: target, projectId: invite.project_id
    };
  }
  if (invite.status !== 'pending') {
    throw invalidState(({accepted:'邀请已被接受',declined:'邀请已被拒绝',revoked:'邀请已被撤销',expired:'邀请已过期'} as Record<string,string>)[invite.status] ?? '邀请状态已变化');
  }
  const now = nowIso();
  if (action === 'decline') {
    const changed = await env.DB.prepare("UPDATE project_username_invitations SET status='declined',handled_at=?3 WHERE id=?1 AND recipient_id=?2 AND status='pending' AND expires_at>?3").bind(id, userId, now).run();
    if (!changed.meta.changes) {
      throw invalidState('邀请已变化');
    }
    return {
      id, status: target, projectId: invite.project_id
    };
  }
  const memberId = newId();
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO project_members(id,project_id,user_id,role,joined_at) SELECT ?1,i.project_id,?3,'member',?4 FROM project_username_invitations i JOIN projects p ON p.id=i.project_id WHERE i.id=?2 AND i.recipient_id=?3 AND i.status='pending' AND i.expires_at>?4 AND p.status='active' AND ${projectPermissionSql('i.project_id','i.invited_by','teamManage')} AND NOT EXISTS(SELECT 1 FROM project_members WHERE project_id=i.project_id AND user_id=?3) AND (p.team_size_limit IS NULL OR (SELECT COUNT(*) FROM project_members WHERE project_id=i.project_id)<p.team_size_limit)`).bind(memberId, id, userId, now),
    env.DB.prepare("UPDATE project_username_invitations SET status='accepted',handled_at=?3 WHERE id=?1 AND recipient_id=?2 AND status='pending' AND EXISTS(SELECT 1 FROM project_members WHERE id=?4)").bind(id, userId, now, memberId)
  ]);
  if (!result[0]?.meta.changes) {
    const latest = await env.DB.prepare('SELECT status,expires_at FROM project_username_invitations WHERE id=?1 AND recipient_id=?2').bind(id, userId).first<{
      status: string;
      expires_at:string;
    }>();
    if (latest?.status === 'accepted') {
      return {
        id, status: 'accepted', projectId: invite.project_id
      };
    }
    if (!latest) throw notFound('邀请不存在');
    if (latest.status !== 'pending') throw invalidState(({declined:'邀请已被拒绝',revoked:'邀请已被撤销',expired:'邀请已过期'} as Record<string,string>)[latest.status] ?? '邀请状态已变化');
    if (latest.expires_at <= nowIso()) throw invalidState('邀请已过期');
    await invitationWriteFailure(env, invite.project_id, invite.invited_by, userId, true);
  }
  return {
    id, status: target, projectId: invite.project_id
  };
}
