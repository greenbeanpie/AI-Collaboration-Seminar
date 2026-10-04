import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '../api/client';
import { ErrorNotice, Field, PageHeading } from '../components/ui';
import { ReceivedInvitations } from './UsernameInvitations';
import { InvitationPreview } from './InvitationPreview';
import type { DataOf } from '../api/types';

export function AcceptInvitationPage() {
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get('code') ?? '');
  const currentCode = useRef(code);
  const [review, setReview] = useState<{code:string; project:DataOf<'InvitationPreviewResponse'>} | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accept = useMutation({
    mutationFn: () => api.post<'InvitationAcceptResponse'>('/api/v1/invitations/accept', { code: review!.code }),
    onSuccess: async (result) => { await queryClient.invalidateQueries({ queryKey: ['projects'] }); navigate(`/app/projects/${result.projectId}`); },
  });
  const preview = useMutation({
    mutationFn: (typed: string) => api.post<'InvitationPreviewResponse'>('/api/v1/invitations/preview', {code:typed}, {networkOnly:true}),
    onSuccess: (project, typed) => { if (currentCode.current.trim() === typed) setReview({code:typed,project}); },
  });
  return <div className="page-stack narrow-page">
    <Link className="back-link" to="/app"><ArrowLeft size={16} />返回项目列表</Link>
    <PageHeading eyebrow="加入团队" title="项目邀请" detail="通过邀请码加入团队，或在下方处理发给你的项目邀请。" />
    <form className="card form-card" onSubmit={(event) => { event.preventDefault(); if (!review) preview.mutate(code.trim()); }}>
      <h2>通过邀请码接受邀请</h2>

      <Field label="邀请代码"><input className="input" required minLength={10} maxLength={200} disabled={accept.isPending} value={code} onChange={(event) => { const typed=event.target.value.trim(); currentCode.current=typed; setCode(typed); setReview(null); preview.reset(); accept.reset(); }} placeholder="粘贴负责人发来的代码" /></Field>
      {preview.error && <ErrorNotice error={preview.error} />}
      {accept.error && <ErrorNotice error={accept.error} />}
      {review && <InvitationPreview project={review.project} pending={accept.isPending} onCancel={() => {setReview(null); accept.reset();}} onConfirm={() => accept.mutate()} />}
      <div className="form-actions"><Link to="/app" className="button button-quiet">取消</Link>{!review && <button className="button button-primary" disabled={preview.isPending || code.length < 10}>{preview.isPending ? '正在读取…' : '查看邀请详情'}</button>}</div>
    </form>
    <ReceivedInvitations />
  </div>;
}
