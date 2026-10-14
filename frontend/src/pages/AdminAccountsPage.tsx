import { useSettingsDirty } from './settings-dirty';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import { accountRequest } from '../api/simplification';
import { adminRequest, useSession } from '../auth';
import type { AccountInvitation, CreatedAccountInvitation } from '../auth';
import { ErrorNotice, PageHeading, SectionCard, Spinner, StatusPill } from '../components/ui';

export function AdminAccountsPage() {
  const session = useSession();
  const [accessError, setAccessError] = useState<ApiError | null>(null);
  const authorized = session.data?.isAdmin === true && !accessError;
  const superAdmin = session.data?.role === 'super_admin';
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<CreatedAccountInvitation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [editorVersion, setEditorVersion] = useState(0);
  useSettingsDirty(created !== null);
  function denyAccess(error: unknown) {
    if (!(error instanceof ApiError) || ![401, 403, 404].includes(error.status)) return;
    setAccessError(error); setCreated(null); setNotice('');
    queryClient.removeQueries({ predicate: q => ['admin-accounts', 'admin-account-invitations'].includes(String(q.queryKey[0])) });
    void session.refetch();
  }
  async function protect<T>(load: () => Promise<T>): Promise<T> {
    try { return await load(); } catch (error) { denyAccess(error); throw error; }
  }
  const invitations = useQuery({ queryKey: ['admin-account-invitations', session.data?.id, session.data?.role], enabled: authorized,
    queryFn: () => protect(() => adminRequest<{ items: AccountInvitation[]; nextCursor: null }>('/api/v1/admin/account-invitations')), retry: false });
  const [cursor, setCursor] = useState<string | null>(null);
  const accounts = useQuery({ queryKey: ['admin-accounts', session.data?.id, session.data?.role, cursor], enabled: authorized,
    queryFn: () => protect(() => adminRequest<{ items: ManagedAccount[]; nextCursor: string | null }>(`/api/v1/admin/accounts${cursor ? `?cursor=${cursor}` : ''}`)), retry: false });
  const update = useMutation({
    mutationFn: ({ id, kind, body }: { id: string; kind: 'role' | 'profile'; body: unknown }) => adminRequest(`/api/v1/admin/accounts/${id}/${kind}`, { method: 'PATCH', body }),
    onSuccess: async () => { setError(null); await Promise.all([queryClient.invalidateQueries({ queryKey: ['admin-accounts'] }), queryClient.invalidateQueries({ queryKey: ['session'] })]); }, onError: async error => {
      setError(error); denyAccess(error);
      if (error instanceof ApiError && error.status === 409) {
        const [latest] = await Promise.all([accounts.refetch(), session.refetch()]);
        setEditorVersion(version => version + 1);
        if (!latest.error) setNotice('账户状态已刷新，请核对权限与等级后重试。');
      }
    },
  });
  const create = useMutation({
    mutationFn: () => adminRequest<CreatedAccountInvitation>('/api/v1/admin/account-invitations', { method: 'POST', body: {} }),
    onSuccess: async data => { setCreated(data); setError(null); await queryClient.invalidateQueries({ queryKey: ['admin-account-invitations'] }); },
    onError: error => { setError(error); denyAccess(error); },
  });
  if (accessError) return <ErrorNotice error={accessError} onRetry={() => setAccessError(null)} />;
  if (session.isLoading) return <Spinner label="正在检查系统管理员权限" />;
  if (session.error) return <ErrorNotice error={session.error} />;
  if (!authorized) return <SectionCard title="需要系统管理员权限"><p role="alert">只有系统管理员可以管理注册邀请码。项目负责人不具备此权限。</p></SectionCard>;
  return <div className="page-stack">
    <PageHeading eyebrow="系统管理" title="账户注册邀请码" detail="邀请码允许创建一个新账户，成功注册后即失效。它与团队的项目邀请独立。" action={superAdmin && <Link className="button button-quiet" to="/app/settings/ai">AI 模型设置</Link>} />
    {notice && <p role="status">{notice}</p>}
    <SectionCard title="账户等级与管理" detail="超级管理员管理账户等级和系统配置；普通管理员管理一般用户与邀请码。项目成员权限独立保留。">
      {accounts.isLoading && <Spinner label="正在读取账户" />}
      {accounts.error && <ErrorNotice error={accounts.error} onRetry={() => void accounts.refetch()} />}
      {accounts.data?.items.map(account => <AccountEditor key={`${account.id}:${account.role}:${account.displayName}:${editorVersion}`} account={account} superAdmin={superAdmin} pending={update.isPending || accounts.isFetching || accounts.isError} onSave={(kind, body) => { setError(null); update.mutate({ id: account.id, kind, body }); }} />)}
      <div className="button-row">{cursor && <button className="button button-quiet" onClick={() => setCursor(null)}>回到首页</button>}{accounts.data?.nextCursor && <button className="button button-quiet" onClick={() => setCursor(accounts.data!.nextCursor)}>下一页账户</button>}</div>
    </SectionCard>
    {superAdmin && <PasswordRecoveryIssuer accounts={accounts.data?.items ?? []} onFailure={denyAccess} />}
    <SectionCard title="生成注册邀请码" detail="完整邀请码只在生成时显示一次；离开页面后无法再次读取。请及时保存并交给受邀人员。">
      <button className="button button-primary" disabled={create.isPending || created !== null} onClick={() => { setError(null); create.mutate(); }}>{create.isPending ? '正在生成……' : '生成一个邀请码'}</button>
      {created && <div className="notice notice-success invitation-reveal" role="status"><strong>新邀请码（仅本次显示）</strong><code aria-label="新注册邀请码">{created.code}</code><p>请保存邀请码。确认后将从当前页面移除，服务端不会再次返回完整值。</p><button className="button button-quiet" onClick={() => { setCreated(null); create.reset(); }}>已保存，隐藏邀请码</button></div>}
      {error !== null && <ErrorNotice error={error} />}
    </SectionCard>
    <SectionCard title="注册邀请码记录" detail="列表只显示编号、创建时间与使用状态。">
      {invitations.isLoading && <Spinner label="正在读取邀请码记录" />}
      {invitations.error && <ErrorNotice error={invitations.error} onRetry={() => void invitations.refetch()} />}
      {invitations.data && (invitations.data.items.length === 0 ? <p className="muted">尚未生成注册邀请码。</p> : <div className="table-scroll"><table className="data-table"><thead><tr><th>编号</th><th>创建时间</th><th>状态</th><th>使用时间</th></tr></thead><tbody>{invitations.data.items.map(item => <tr key={item.id}><td><code>{item.id}</code></td><td>{new Date(item.createdAt).toLocaleString()}</td><td><StatusPill tone={item.usedAt ? 'neutral' : 'good'}>{item.usedAt ? '已使用' : '未使用'}</StatusPill></td><td>{item.usedAt ? new Date(item.usedAt).toLocaleString() : '—'}</td></tr>)}</tbody></table></div>)}
    </SectionCard>
  </div>;
}

function PasswordRecoveryIssuer({ accounts, onFailure }: { accounts: ManagedAccount[]; onFailure: (error: unknown) => void }) {
  const [userId, setUserId] = useState(''), [reason, setReason] = useState(''), [verified, setVerified] = useState(false);
  const [issued, setIssued] = useState<{ token: string; expiresAt: string } | null>(null);
  useSettingsDirty(Boolean(issued || reason.trim()));
  const issue = useMutation({
    mutationFn: () => accountRequest<{ token: string; expiresAt: string }>(`/api/v1/admin/accounts/${encodeURIComponent(userId)}/password-recovery`, { method: 'POST', body: { reason, ownershipVerified: true }, headers: { 'X-Password-Recovery': '1' }, networkOnly: true, shortControl: true }),
    onSuccess: result => { setIssued(result); setReason(''); setVerified(false); }, onError: onFailure,
  });
  return <SectionCard title="人工核实后的密码恢复" detail="仅超级管理员可以签发。先通过可靠渠道核实账户归属，未验证邮箱不能作为恢复依据；系统不自动发送邮件。">
    <label>恢复账户<select className="input" value={userId} disabled={issue.isPending || Boolean(issued)} onChange={event => setUserId(event.target.value)}><option value="">请选择已核实账户</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.username || account.id} · {account.displayName}</option>)}</select></label>
    <label>核实依据与原因<textarea className="input" minLength={10} maxLength={1000} value={reason} disabled={issue.isPending || Boolean(issued)} onChange={event => setReason(event.target.value)} /></label>
    <label><input type="checkbox" checked={verified} disabled={issue.isPending || Boolean(issued)} onChange={event => setVerified(event.target.checked)} />我已独立核实该账户的归属</label>
    <button className="button button-primary" disabled={!userId || reason.trim().length < 10 || !verified || issue.isPending || Boolean(issued)} onClick={() => issue.mutate()}>签发一次性恢复代码</button>
    {issued && <div role="status"><p>仅本次显示；有效至 {new Date(issued.expiresAt).toLocaleString()}。请通过已核实的渠道人工交付。</p><code style={{ overflowWrap: 'anywhere' }} aria-label="一次性恢复代码">{issued.token}</code><p>恢复入口：{window.location.origin}/password-reset</p><button className="button button-quiet" onClick={() => { setIssued(null); issue.reset(); }}>已交付，隐藏代码</button></div>}
    {issue.error !== null && <ErrorNotice error={issue.error} />}
  </SectionCard>;
}


type Role = 'super_admin' | 'admin' | 'user';
type ManagedAccount = { id: string; username: string | null; email: string | null; displayName: string; role: Role };
const roleLabels: Record<Role, string> = { super_admin: '超级管理员', admin: '普通管理员', user: '一般用户' };
function AccountEditor({ account, superAdmin, pending, onSave }: { account: ManagedAccount; superAdmin: boolean; pending: boolean; onSave: (kind: 'role' | 'profile', body: unknown) => void }) {
  const [displayName, setDisplayName] = useState(account.displayName);
  const [role, setRole] = useState<Role>(account.role);
  useSettingsDirty(displayName !== account.displayName || role !== account.role);
  const canEdit = superAdmin || account.role === 'user';
  return <div className="stack" style={{ marginBottom: '1rem' }}>
    <strong>{account.username || account.email || account.id} · {roleLabels[account.role]}</strong>
    {canEdit ? <label>显示名称<input className="input" aria-label={`${account.username || account.id} 显示名称`} value={displayName} maxLength={64} disabled={pending} onChange={e => setDisplayName(e.target.value)} /><button className="button button-quiet" disabled={pending || !displayName.trim() || displayName.trim() === account.displayName} onClick={() => onSave('profile', { displayName })}>保存名称</button></label> : <span>{account.displayName}</span>}
    {superAdmin && <label>账户等级<select className="input" aria-label={`${account.username || account.id} 账户等级`} value={role} disabled={pending} onChange={e => setRole(e.target.value as Role)}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="button button-quiet" disabled={pending || role === account.role} onClick={() => onSave('role', { role })}>保存等级</button></label>}
  </div>;
}
