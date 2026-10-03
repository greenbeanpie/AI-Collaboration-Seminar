import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, KeyRound } from 'lucide-react';
import { api } from '../api/client';
import { ErrorNotice, Field, PageHeading } from '../components/ui';
import { ReceivedInvitations } from './UsernameInvitations';

export function AcceptInvitationPage() {
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get('code') ?? '');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accept = useMutation({
    mutationFn: () => api.post<'InvitationAcceptResponse'>('/api/v1/invitations/accept', { code: code.trim() }),
    onSuccess: async (result) => { await queryClient.invalidateQueries({ queryKey: ['projects'] }); navigate(`/app/projects/${result.projectId}`); },
  });
  return <div className="page-stack narrow-page">
    <Link className="back-link" to="/app"><ArrowLeft size={16} />返回项目列表</Link>
    <PageHeading eyebrow="加入团队" title="项目邀请" detail="通过邀请码加入团队，或在下方处理发给你的项目邀请。" />
    <form className="card form-card" onSubmit={(event) => { event.preventDefault(); accept.mutate(); }}>
      <h2>通过邀请码接受邀请</h2>
      <div className="form-note"><KeyRound size={17} />邀请代码只用于接受邀请，不会公开显示在项目列表中。</div>
      <Field label="邀请代码"><input className="input" required minLength={10} maxLength={200} value={code} onChange={(event) => setCode(event.target.value.trim())} placeholder="粘贴负责人发来的代码" /></Field>
      {accept.error && <ErrorNotice error={accept.error} />}
      <div className="form-actions"><Link to="/app" className="button button-quiet">取消</Link><button className="button button-primary" disabled={accept.isPending || code.length < 10}>{accept.isPending ? '正在加入…' : '接受邀请并加入'}</button></div>
    </form>
    <ReceivedInvitations />
  </div>;
}
