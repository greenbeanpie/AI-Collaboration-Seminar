import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api, ApiError, request } from '../api/client';
import { ErrorNotice, Field, PageHeading } from '../components/ui';
import { ReceivedInvitations } from './UsernameInvitations';
import { InvitationPreview } from './InvitationPreview';
import type { DataOf } from '../api/types';

export function AcceptInvitationPage() {
  const [searchParams] = useSearchParams();
  const [code, setCode] = useState(() => searchParams.get('code') ?? '');
  const currentCode = useRef(code);
  const acceptKey = useRef(crypto.randomUUID()), unknownAccept = useRef(false);
  const acceptController=useRef<AbortController|null>(null),previewController=useRef<AbortController|null>(null);
  useEffect(()=>()=>{acceptController.current?.abort();previewController.current?.abort();},[]);
  const [review, setReview] = useState<{code:string; project:DataOf<'InvitationPreviewResponse'>} | null>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accept = useMutation({
    mutationFn: async () => {
      acceptController.current=new AbortController();const signal=acceptController.current.signal;
      const checkedMembership = async () => {
        try { await request(`/projects/${review!.project.projectId}`, { networkOnly: true,signal }); return { projectId: review!.project.projectId }; }
        catch { return null; }
      };
      if (unknownAccept.current) {
        const recovered = await checkedMembership();
        if (recovered) return recovered;
        throw new Error('上次加入结果尚未确认。请取消当前预览并重新查看邀请，核对后再确认。');
      }
      try { return await api.post<'InvitationAcceptResponse'>('/api/v1/invitations/accept', { code: review!.code }, { networkOnly: true, timeoutMs: 30_000, idempotencyKey: acceptKey.current,signal }); }
      catch (failure) {
        if (!signal.aborted && !(failure instanceof ApiError && failure.status === 0)) throw failure;
        unknownAccept.current = true;
        const recovered = await checkedMembership();
        if (recovered) return recovered;
        throw new Error('加入结果尚未确认，本次邀请已保留。请先核对项目权限或重新查看邀请，不会自动重复加入。', { cause: failure });
      }
    },
    onSuccess: async (result) => { if(acceptController.current?.signal.aborted)return;await queryClient.invalidateQueries({ queryKey: ['projects'] }); navigate(`/app/projects/${result.projectId}`); },
  });
  const preview = useMutation({
    mutationFn: (typed: string) => {previewController.current?.abort();previewController.current=new AbortController();return api.post<'InvitationPreviewResponse'>('/api/v1/invitations/preview', {code:typed}, {networkOnly:true, timeoutMs:30_000,signal:previewController.current.signal});},
    onSuccess: (project, typed) => { if (!previewController.current?.signal.aborted && currentCode.current.trim() === typed) { unknownAccept.current = false; acceptKey.current = crypto.randomUUID(); setReview({code:typed,project}); } },
  });
  const initialPreview = useRef(false);
  useEffect(() => {
    if (initialPreview.current) return;
    initialPreview.current = true;
    if (code.trim().length >= 10) preview.mutate(code.trim());
  }, [code, preview]);
  return <div className="page-stack narrow-page">
    <Link className="back-link" to="/app"><ArrowLeft size={16} />返回项目列表</Link>
    <PageHeading eyebrow="加入团队" title="项目邀请" detail="通过邀请码加入团队，或在下方处理发给你的项目邀请。" />
    <form className="card form-card" onSubmit={(event) => { event.preventDefault(); if (!review) preview.mutate(code.trim()); }}>
      <h2>通过邀请码接受邀请</h2>

      <Field label="邀请代码"><input className="input" required minLength={10} maxLength={200} disabled={accept.isPending} value={code} onChange={(event) => { const typed=event.target.value.trim(); currentCode.current=typed; setCode(typed); setReview(null); preview.reset(); accept.reset(); }} placeholder="粘贴负责人发来的代码" /></Field>
      {(preview.isPending||accept.isPending)&&<button type="button" className="button button-quiet" onClick={()=>{previewController.current?.abort(new DOMException('已取消等待','AbortError'));acceptController.current?.abort(new DOMException('已取消等待，加入结果尚未确认','AbortError'));}}>取消等待并保留邀请</button>}
      {preview.error && <ErrorNotice error={preview.error} />}
      {accept.error && <ErrorNotice error={accept.error} />}
      {review && <InvitationPreview project={review.project} pending={accept.isPending} onCancel={() => {setReview(null); accept.reset();}} onConfirm={() => accept.mutate()} />}
      <div className="form-actions"><Link to="/app" className="button button-quiet">取消</Link>{!review && <button className="button button-primary" disabled={preview.isPending || code.length < 10}>{preview.isPending ? '正在读取…' : '查看邀请详情'}</button>}</div>
    </form>
    <ReceivedInvitations />
  </div>;
}
