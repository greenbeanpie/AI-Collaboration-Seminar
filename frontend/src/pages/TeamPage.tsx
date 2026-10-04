import './CompactSettings.css';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Plus, ShieldCheck, UserMinus } from 'lucide-react';
import { api, listAllItems, projectPath } from '../api/client';
import { useCapabilities, useSession } from '../auth';
import { ConfirmButton, EmptyState, ErrorNotice, Field, PageHeading, SectionCard, Spinner, StatusPill } from '../components/ui';
import { invitationStatus } from './invitation-status';
import { SentUsernameInvitations } from './UsernameInvitations';
import { memberPermissionSummary, memberRoleLabel, useProjectPermissions } from '../project-permissions';
import { InvitationRequests } from './InvitationRequests';
import { MemberPermissionsDialog } from './MemberPermissions';

function displayDate(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString('zh-CN'); }
export function TeamPage() {
  // 统一权限入口：teamManage 负责邀请与成员移除；成员权限管理只属于 owner 或本项目内的平台管理员。
  const { projectId, project, can, canManagePermissions } = useProjectPermissions();
  const client = useQueryClient();
  const capabilities = useCapabilities();
  const session = useSession();
  const teamManage = can('teamManage');
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const members = useQuery({ queryKey: ['members', projectId], queryFn: () => listAllItems<'MemberListResponse'>(projectPath(projectId, '/members'), { limit: 100 }) });
  const tasks = useQuery({ queryKey: ['tasks', projectId], queryFn: () => listAllItems<'TaskListResponse'>(projectPath(projectId, '/tasks'), { limit: 100 }, { requireNextCursor: true }) });
  const invitations = useQuery({ queryKey: ['invitations', projectId], queryFn: () => api.get<'InvitationListResponse'>(projectPath(projectId, '/invitations')), enabled: teamManage });
  const [maxUses, setMaxUses] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('7');
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const invite = useMutation({ mutationFn: () => api.post<'InvitationCreateResponse'>(projectPath(projectId, '/invitations'), { ...(maxUses ? { maxUses: Number(maxUses) } : {}), expiresInDays: Number(expiresInDays) }), onSuccess: async result => { setCreatedCode(result.code); await client.invalidateQueries({ queryKey: ['invitations', projectId] }); } });
  const revoke = useMutation({ mutationFn: (id: string) => api.delete<'InvitationRevokeResponse'>(projectPath(projectId, `/invitations/${encodeURIComponent(id)}`)), onSuccess: () => client.invalidateQueries({ queryKey: ['invitations', projectId] }) });
  const remove = useMutation({ mutationFn: (id: string) => api.delete<'MemberRemoveResponse'>(projectPath(projectId, `/members/${encodeURIComponent(id)}`)), onSuccess: () => client.invalidateQueries({ queryKey: ['members', projectId] }) });
  const leave = useMutation({ mutationFn: () => api.delete<'MemberLeaveResponse'>(projectPath(projectId, '/members/me')), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['projects'] }); window.location.assign('/app'); } });
  async function copyCode() { if (!createdCode) return; try { await navigator.clipboard.writeText(createdCode); setCopied(true); } catch { setCopied(false); } }
  const editingMember = members.data?.find(member => member.userId === editingMemberId) ?? null;
  return <div className="page-stack team-page">
    <PageHeading title="团队成员" detail="管理角色、邀请与当前任务负荷。分工、提交和验收统一在任务工作区进行。" action={<StatusPill tone="blue">{members.data?.length ?? '—'} 位成员</StatusPill>} />
    {[members, tasks].filter(query => query.error).map((query, index) => <ErrorNotice key={index} error={query.error} onRetry={() => void query.refetch()} />)}
    <div className="compact-team-grid"><SectionCard title="成员与任务负荷" detail="负荷依据未完成任务的预计工时计算。">
      {members.isLoading && <Spinner label="正在读取成员" />}
      {members.data?.length ? <div className="team-member-list">{members.data.map(member => {
        const assigned = tasks.data?.filter(task => task.assigneeId === member.userId && task.status !== 'done') ?? [];
        const hours = assigned.reduce((total, task) => total + ((task as { effortHours?: number }).effortHours ?? 0), 0);
        // owner 与平台管理员的项目权限由身份决定，不提供可编辑入口。
        const permissionEditable = canManagePermissions && member.role !== 'owner' && member.isAdmin !== true;
        // teamManage 只能移除普通成员；移除平台管理员成员需要项目管理员，与后端 DELETE 校验一致。
        const removable = member.role !== 'owner' && member.userId !== session.data?.id && (member.isAdmin === true ? canManagePermissions : teamManage);
        return <div className="team-member" key={member.userId}>
          <span className="avatar">{member.displayName.slice(0, 1).toLocaleUpperCase()}</span>
          <div className="team-member-main">
            <div className="team-member-name"><strong>{member.displayName}</strong><StatusPill tone={member.role === 'owner' ? 'blue' : member.isAdmin ? 'warn' : 'neutral'}>{memberRoleLabel(member)}</StatusPill></div>
            <small>{member.username ?? member.email}</small>
            <small>{tasks.data ? `${assigned.length} 项未完成任务 · 预计 ${hours} 小时` : '任务负荷暂不可用'}</small>
            <small className="team-member-permissions">{memberPermissionSummary(member)}</small>
          </div>
          <div className="team-member-actions">
            {permissionEditable && <button type="button" className="button button-quiet button-small" aria-label={`调整 ${member.displayName} 的权限`} onClick={() => setEditingMemberId(member.userId)}>权限</button>}
            {member.role === 'owner' && <span className="team-member-lock" title="负责人始终拥有全部项目权限"><ShieldCheck size={15} />权限锁定</span>}
            {member.isAdmin === true && member.role !== 'owner' && <span className="team-member-lock" title="平台管理员的项目权限由平台身份决定"><ShieldCheck size={15} />权限锁定</span>}
            {removable && <ConfirmButton className="icon-button" aria-label={`移除成员 ${member.displayName}`} disabled={remove.isPending} onClick={() => remove.mutate(member.userId)}><UserMinus size={17} /></ConfirmButton>}
          </div>
        </div>;
      })}</div> : !members.isLoading && !members.error && <EmptyState title="暂无成员" detail="项目成员数据尚未返回记录。" />}
      {remove.error && <ErrorNotice error={remove.error} />}
      {!canManagePermissions && <p className="form-note">只有项目负责人或本项目内的平台管理员可以调整成员的项目权限。</p>}
      {project.myRole !== 'owner' && <div className="form-actions"><ConfirmButton disabled={leave.isPending} onClick={() => leave.mutate()}>退出项目</ConfirmButton>{leave.error && <ErrorNotice error={leave.error} />}</div>}
    </SectionCard>
    <div className="compact-team-invites"><InvitationRequests projectId={projectId} canApprove={teamManage} />{teamManage && <><SentUsernameInvitations projectId={projectId} /><SectionCard title="邀请新成员" detail="邀请码只在创建时显示一次，请复制后发送给受邀者。">
      {createdCode ? <div className="invite-code-box"><div><strong>一次性显示的邀请码</strong><code>{createdCode}</code><small>离开此页后不能再次读取原码。</small></div><button className="button button-primary" onClick={() => void copyCode()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? '已复制' : '复制邀请码'}</button><button className="button button-quiet" onClick={() => { setCreatedCode(null); setCopied(false); }}>创建另一个邀请</button></div> : <form className="invite-form" onSubmit={event => { event.preventDefault(); invite.mutate(); }}>
        <Field label="可使用次数" hint="留空表示不按固定次数限制。"><input className="input" type="number" min="1" max="100" value={maxUses} onChange={event => setMaxUses(event.target.value)} /></Field>
        <Field label="有效天数"><input className="input" type="number" min="1" max="30" required value={expiresInDays} onChange={event => setExpiresInDays(event.target.value)} /></Field>
        <button className="button button-primary" disabled={invite.isPending}><Plus size={16} />创建邀请码</button>
      </form>}
      {invite.error && <ErrorNotice error={invite.error} />}{invitations.error && <ErrorNotice error={invitations.error} onRetry={() => void invitations.refetch()} />}
      {invitations.isLoading && <Spinner label="正在读取邀请" />}
      {Boolean(invitations.data?.items.length) && <div className="table-wrap"><table><thead><tr><th>状态</th><th>有效期至</th><th>使用次数</th><th /></tr></thead><tbody>{invitations.data?.items.map(invitation => <tr key={invitation.invitationId}><td><StatusPill tone={invitationStatus(invitation) === '有效' ? 'good' : 'neutral'}>{invitationStatus(invitation)}</StatusPill></td><td>{displayDate(invitation.expiresAt)}</td><td>{invitation.usedCount} / {invitation.maxUses ?? '不限'}</td><td>{!invitation.revokedAt && <ConfirmButton className="button button-quiet button-small" disabled={revoke.isPending} onClick={() => revoke.mutate(invitation.invitationId)}>撤销</ConfirmButton>}</td></tr>)}</tbody></table></div>}
      {revoke.error && <ErrorNotice error={revoke.error} />}
    </SectionCard></>}</div></div>
    {capabilities.data?.competitionTemplate.teamSizeLimit && <p className="form-note">当前赛道建议人数上限 {capabilities.data.competitionTemplate.teamSizeLimit} 人。</p>}
    {editingMember && <MemberPermissionsDialog projectId={projectId} member={editingMember} onClose={() => setEditingMemberId(null)} />}
  </div>;
}
