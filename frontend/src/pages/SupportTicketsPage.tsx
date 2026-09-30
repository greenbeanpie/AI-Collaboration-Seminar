import './SupportTicketsPage.css';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { DataOf } from '../api/types';
import { useSession } from '../auth';
import { ErrorNotice, PageHeading, SectionCard, Spinner, StatusPill } from '../components/ui';

type Ticket = DataOf<'SupportTicketResponse'>['ticket'];
type Status = Ticket['status'];
const ticketStatuses: Record<Status, string> = { pending: '待处理', in_progress: '处理中', waiting_user: '待用户回复', resolved: '已解决', closed: '已关闭' };
const roleAdmin = (role?: string) => role === 'super_admin' || role === 'admin';
const ticketPath = (id: string) => `/support/tickets/${encodeURIComponent(id)}`;
const dateLabel = (date: string) => new Date(date).toLocaleString();

export function SupportTicketsPage() {
  const session = useSession(); const account = session.data; const navigate = useNavigate();
  const [search, setSearch] = useSearchParams(); const cursor = search.get('cursor'); const filter = search.get('status') ?? '';
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const locked = useRef(false);
  const list = useQuery({ queryKey: ['support-tickets', account?.id, account?.role, cursor, filter], enabled: !!account,
    queryFn: ({ signal }) => api.get<'SupportTicketListResponse'>('/support/tickets', { cursor, status: filter, limit: 20 }, signal), retry: false });
  const create = useMutation({ mutationFn: () => api.post<'SupportTicketResponse'>('/support/tickets', { title, body }),
    onSuccess: data => navigate(`/app/support/${data.ticket.id}`), onSettled: () => { locked.current = false; } });
  function submit(event: FormEvent) { event.preventDefault(); if (locked.current) return; locked.current = true; create.mutate(); }
  return <div className="page-stack support-page">
    <PageHeading eyebrow="站内支持" title={roleAdmin(account?.role) ? '全部工单' : '我的工单'} detail="提交问题或求助，和管理员在站内沟通。请勿填写密码、验证码、API 密钥、支付资料等敏感凭据。" />
    <SectionCard title="提交工单" detail="仅支持文字，不发送邮件通知。">
      <form className="stack" onSubmit={submit}>
        <label>问题标题<input className="input" value={title} maxLength={160} required disabled={create.isPending} onChange={e => setTitle(e.target.value)} /></label>
        <label>问题描述<textarea className="input" rows={5} value={body} maxLength={8000} required disabled={create.isPending} onChange={e => setBody(e.target.value)} /></label>
        <button className="button button-primary" disabled={create.isPending || !title.trim() || !body.trim()}>{create.isPending ? '正在提交……' : '提交工单'}</button>
        {create.error && <ErrorNotice error={create.error} />}
      </form>
    </SectionCard>
    <SectionCard title="工单列表">
      <label>筛选状态<select className="input" value={filter} onChange={e => setSearch(e.target.value ? { status: e.target.value } : {})}><option value="">全部状态</option>{Object.entries(ticketStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {list.isLoading && <Spinner label="正在读取工单" />}
      {list.error && <ErrorNotice error={list.error} onRetry={() => void list.refetch()} />}
      {list.data && <>
        {list.data.items.length === 0 ? <p className="muted">暂无符合条件的工单。</p> : <ul className="support-ticket-list">{list.data.items.map(ticket => <li key={ticket.id}><Link to={`/app/support/${ticket.id}`}><strong>{ticket.title}</strong></Link><StatusPill>{ticketStatuses[ticket.status]}</StatusPill><small>{roleAdmin(account?.role) && `${ticket.ownerName} · `}创建于 {dateLabel(ticket.createdAt)}</small></li>)}</ul>}
        <div className="button-row">{cursor && <button className="button button-quiet" onClick={() => setSearch(filter ? { status: filter } : {})}>回到第一页</button>}{list.data.nextCursor && <button className="button button-quiet" onClick={() => setSearch({ ...(filter ? { status: filter } : {}), cursor: list.data!.nextCursor! })}>下一页</button>}</div>
      </>}
    </SectionCard>
  </div>;
}

export function SupportTicketDetailPage() {
  const { ticketId = '' } = useParams();
  return <SupportTicketThread key={ticketId} ticketId={ticketId} />;
}
function SupportTicketThread({ ticketId }: { ticketId: string }) {
  const session = useSession(); const account = session.data;
  const queryClient = useQueryClient(); const [body, setBody] = useState(''); const [selectedStatus, setSelectedStatus] = useState<Status | ''>('');
  const [notice, setNotice] = useState(''); const replyLocked = useRef(false);
  const key = [account?.id, account?.role, ticketId];
  const detail = useQuery({ queryKey: ['support-ticket', ...key], enabled: !!account && !!ticketId,
    queryFn: ({ signal }) => api.get<'SupportTicketResponse'>(ticketPath(ticketId), undefined, signal), retry: false });
  const messages = useInfiniteQuery({ queryKey: ['support-messages', ...key], enabled: !!detail.data,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.get<'SupportTicketMessagesResponse'>(`${ticketPath(ticketId)}/messages`, { cursor: pageParam, limit: 20 }, signal),
    getNextPageParam: last => last.nextCursor ?? undefined, retry: false });
  async function refresh() { await Promise.all([queryClient.invalidateQueries({ queryKey: ['support-ticket', ...key] }), queryClient.invalidateQueries({ queryKey: ['support-messages', ...key] }), queryClient.invalidateQueries({ queryKey: ['support-tickets'] })]); }
  const reply = useMutation({ mutationFn: () => api.post<'SupportTicketReplyResponse'>(`${ticketPath(ticketId)}/messages`, { body }),
    onSuccess: async () => { setBody(''); setNotice('回复已发送'); await refresh(); }, onSettled: () => { replyLocked.current = false; } });
  const changeStatus = useMutation({ mutationFn: () => api.patch<'SupportTicketResponse'>(`${ticketPath(ticketId)}/status`, { status: selectedStatus, revision: detail.data!.ticket.revision }),
    onSuccess: async () => { setSelectedStatus(''); setNotice('状态已更新'); await refresh(); } });
  function submitReply(event: FormEvent) { event.preventDefault(); if (replyLocked.current) return; replyLocked.current = true; setNotice(''); reply.mutate(); }
  const ticket = detail.data?.ticket;
  return <div className="page-stack support-page">
    <Link className="button button-quiet" to="/app/support">返回工单列表</Link>
    {detail.isLoading && <Spinner label="正在读取工单详情" />}
    {detail.error && <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />}
    {ticket && <>
      <PageHeading eyebrow="站内支持工单" title={ticket.title} detail={`${ticket.ownerName} · 创建于 ${dateLabel(ticket.createdAt)}`} />
      <SectionCard title="问题描述"><StatusPill>{ticketStatuses[ticket.status]}</StatusPill><p className="support-text">{ticket.body}</p></SectionCard>
      {roleAdmin(account?.role) && <SectionCard title="处理状态"><label>工单状态<select className="input" value={selectedStatus || ticket.status} disabled={changeStatus.isPending} onChange={e => setSelectedStatus(e.target.value as Status)}>{Object.entries(ticketStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="button button-primary" disabled={changeStatus.isPending || !selectedStatus || selectedStatus === ticket.status} onClick={() => { setNotice(''); changeStatus.mutate(); }}>保存状态</button>{changeStatus.error && <ErrorNotice error={changeStatus.error} />}</SectionCard>}
      <SectionCard title="沟通记录">
        {messages.isLoading && <Spinner label="正在读取回复" />}
        {messages.error && <ErrorNotice error={messages.error} onRetry={() => void messages.refetch()} />}
        {messages.data && messages.data.pages.every(p => p.items.length === 0) && <p className="muted">暂无回复。</p>}
        <ol className="support-messages">{messages.data?.pages.flatMap(p => p.items).map(item => <li key={item.id}><strong>{item.authorName}</strong><small>{dateLabel(item.createdAt)}</small><p className="support-text">{item.kind === 'status' && item.status ? `状态更新为：${ticketStatuses[item.status]}` : item.body}</p></li>)}</ol>
        {messages.hasNextPage && <button className="button button-quiet" disabled={messages.isFetchingNextPage} onClick={() => void messages.fetchNextPage()}>{messages.isFetchingNextPage ? '正在加载……' : '加载更多记录'}</button>}
      </SectionCard>
      <SectionCard title="回复工单" detail="请勿发送密码、验证码、API 密钥或支付资料。">
        {ticket.status === 'closed' ? <p className="muted">此工单已关闭。管理员重新打开后可继续回复。</p> : <form className="stack" onSubmit={submitReply}><label>回复内容<textarea className="input" rows={5} maxLength={8000} value={body} required disabled={reply.isPending} onChange={e => setBody(e.target.value)} /></label><button className="button button-primary" disabled={reply.isPending || !body.trim()}>{reply.isPending ? '正在发送……' : '发送回复'}</button></form>}
        {reply.error && <ErrorNotice error={reply.error} />}
        {notice && <p role="status">{notice}</p>}
      </SectionCard>
    </>}
  </div>;
}
