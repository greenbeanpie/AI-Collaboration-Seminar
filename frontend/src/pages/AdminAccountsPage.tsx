import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { adminRequest, useSession } from '../auth';
import type { AccountInvitation, CreatedAccountInvitation } from '../auth';
import { ErrorNotice, PageHeading, SectionCard, Spinner, StatusPill } from '../components/ui';

export function AdminAccountsPage() {
  const session = useSession();
  const authorized = session.data?.isAdmin === true;
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<CreatedAccountInvitation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const invitations = useQuery({ queryKey: ['admin-account-invitations'], enabled: authorized,
    queryFn: () => adminRequest<{ items: AccountInvitation[]; nextCursor: null }>('/api/v1/admin/account-invitations'), retry: false });
  const create = useMutation({
    mutationFn: () => adminRequest<CreatedAccountInvitation>('/api/v1/admin/account-invitations', { method: 'POST', body: {} }),
    onSuccess: async data => { setCreated(data); setError(null); await queryClient.invalidateQueries({ queryKey: ['admin-account-invitations'] }); },
    onError: setError,
  });
  if (session.isLoading) return <Spinner label="正在检查系统管理员权限" />;
  if (session.error) return <ErrorNotice error={session.error} />;
  if (!authorized) return <SectionCard title="需要系统管理员权限"><p role="alert">只有系统管理员可以管理注册邀请码。项目负责人不具备此权限。</p></SectionCard>;
  return <div className="page-stack">
    <PageHeading eyebrow="系统管理" title="账户注册邀请码" detail="邀请码允许创建一个新账户，成功注册后即失效。它与团队的项目邀请独立。" action={<Link className="button button-quiet" to="/app/admin/ai">AI 模型设置</Link>} />
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
