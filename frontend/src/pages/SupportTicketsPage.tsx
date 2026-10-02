import './SupportTicketsPage.css';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, apiUrl, ApiError } from '../api/client';
import { MAX_TICKET_IMAGES, MAX_TICKET_IMAGE_BYTES, ticketImageTypes } from '../../../shared/support-tickets';
import type { DataOf } from '../api/types';
import { useSession } from '../auth';
import { ErrorNotice, PageHeading, SectionCard, Spinner, StatusPill } from '../components/ui';

type Ticket = DataOf<'SupportTicketResponse'>['ticket'];
type Status = Ticket['status'];
const ticketStatuses: Record<Status, string> = { pending: '待处理', in_progress: '处理中', waiting_user: '待用户回复', resolved: '已解决', closed: '已关闭' };
const urgencies: Record<Ticket['urgency'], string> = { low: '低 · 不影响使用', normal: '普通 · 部分使用受影响', high: '高 · 重要功能受阻', urgent: '紧急 · 无法继续使用' };
const categories: Record<Ticket['category'], string> = { interface: '界面与显示', functionality: '功能与操作', account: '账户与权限', performance: '性能与稳定性', other: '其他' };
type SelectedImage = { id: string; file: File; preview: string; state: 'selected' | 'uploading' | 'uploaded' | 'failed'; error?: string };
function TicketTags({ ticket }: { ticket: Pick<Ticket, 'status' | 'urgency' | 'category'> }) {
  return <div className="support-tags"><StatusPill>{ticketStatuses[ticket.status]}</StatusPill><span className={`support-urgency support-urgency-${ticket.urgency ?? 'normal'}`}>紧急度：{urgencies[ticket.urgency ?? 'normal']}</span><span className="muted">分类：{categories[ticket.category ?? 'other']}</span></div>;
}
function TicketImage({ ticketId, image, index }: { ticketId: string; image: Ticket['images'][number]; index: number }) {
  const [attempt, setAttempt] = useState(0); const [failed, setFailed] = useState(false);
  const src = apiUrl(`${ticketPath(ticketId)}/images/${image.id}`, { retry: attempt || undefined });
  return <figure className="support-image">
    {failed ? <div role="alert">图片 {index + 1} 加载失败。<button className="button button-quiet" onClick={() => { setFailed(false); setAttempt(n => n + 1); }}>重试加载图片 {index + 1}</button></div> : <a href={src} target="_blank" rel="noreferrer"><img src={src} alt={`工单图片 ${index + 1}`} onError={() => setFailed(true)} /></a>}
    <figcaption>图片 {index + 1} · {(image.sizeBytes / 1024).toFixed(0)} KiB · 点击查看原图</figcaption>
  </figure>;
}
const roleAdmin = (role?: string) => role === 'super_admin' || role === 'admin';
const ticketPath = (id: string) => `/support/tickets/${encodeURIComponent(id)}`;
const denied = (error: unknown): error is ApiError => error instanceof ApiError && [401, 403, 404].includes(error.status);
const supportCache = (key: readonly unknown[]) => ['support-ticket', 'support-messages', 'support-tickets'].includes(String(key[0]));
const dateLabel = (date: string) => new Date(date).toLocaleString();

export function SupportTicketsPage() {
  const session = useSession(); const account = session.data; const navigate = useNavigate();
  const [search, setSearch] = useSearchParams(); const cursor = search.get('cursor'); const filter = search.get('status') ?? '';
  const queryClient = useQueryClient();
  const [accessError, setAccessError] = useState<ApiError | null>(null);
  async function protect<T>(load: () => Promise<T>): Promise<T> {
    try { return await load(); } catch (error) {
      if (denied(error)) { setAccessError(error); queryClient.removeQueries({ predicate: q => supportCache(q.queryKey) }); void session.refetch(); }
      throw error;
    }
  }
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const locked = useRef(false);
  const [urgency, setUrgency] = useState<Ticket['urgency']>('normal'); const [category, setCategory] = useState<Ticket['category']>('other');
  const [images, setImages] = useState<SelectedImage[]>([]); const [imageError, setImageError] = useState('');
  const [savedTicket, setSavedTicket] = useState<Ticket | null>(null); const previews = useRef(new Set<string>());
  useEffect(() => { const urls = previews.current; return () => { urls.forEach(url => URL.revokeObjectURL(url)); }; }, []);
  function selectImages(files: FileList | null) {
    if (!files) return;
    const selected = Array.from(files);
    if (images.length + selected.length > MAX_TICKET_IMAGES) { setImageError(`最多选择 ${MAX_TICKET_IMAGES} 张图片。`); return; }
    if (selected.some(file => !ticketImageTypes.includes(file.type as typeof ticketImageTypes[number]) || !file.size || file.size > MAX_TICKET_IMAGE_BYTES)) { setImageError('请选择 PNG、JPEG 或 WebP 图片，每张不超过 5 MiB，不能为空。'); return; }
    setImageError('');
    setImages(current => [...current, ...selected.map(file => { const preview = URL.createObjectURL(file); previews.current.add(preview); return { id: crypto.randomUUID(), file, preview, state: 'selected' as const }; })]);
  }
  function removeImage(image: SelectedImage) { URL.revokeObjectURL(image.preview); previews.current.delete(image.preview); setImages(current => current.filter(item => item.id !== image.id)); setImageError(''); }
  const list = useQuery({ queryKey: ['support-tickets', account?.id, account?.role, cursor, filter], enabled: !!account && !accessError,
    queryFn: ({ signal }) => protect(() => api.get<'SupportTicketListResponse'>('/support/tickets', { cursor, status: filter, limit: 20 }, signal)), retry: false });
  const create = useMutation({ mutationFn: async () => {
      const ticket = savedTicket ?? (await protect(() => api.post<'SupportTicketResponse'>('/support/tickets', { title, body, urgency, category }))).ticket;
      setSavedTicket(ticket);
      let allUploaded = true;
      for (const image of images.filter(item => item.state !== 'uploaded')) {
        setImages(current => current.map(item => item.id === image.id ? { ...item, state: 'uploading', error: undefined } : item));
        try {
          await protect(() => api.put<'SupportTicketImageResponse'>(`${ticketPath(ticket.id)}/images/${image.id}`, undefined, { rawBody: image.file, headers: { 'Content-Type': image.file.type } }));
          setImages(current => current.map(item => item.id === image.id ? { ...item, state: 'uploaded' } : item));
        } catch (error) {
          allUploaded = false;
          setImages(current => current.map(item => item.id === image.id ? { ...item, state: 'failed', error: error instanceof Error ? error.message : '上传失败，请重试。' } : item));
          if (denied(error)) break;
        }
      }
      return { ticket, allUploaded };
    }, onSuccess: async data => {
      await queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      if (data.allUploaded) navigate(`/app/support/${data.ticket.id}`);
    }, onSettled: () => { locked.current = false; } });
  function submit(event: FormEvent) { event.preventDefault(); if (locked.current) return; locked.current = true; create.mutate(); }
  return <div className="page-stack support-page">
    <PageHeading eyebrow="站内支持" title={roleAdmin(account?.role) ? '全部工单' : '我的工单'} detail="提交问题或求助，和管理员在站内沟通。请勿填写密码、验证码、API 密钥、支付资料等敏感凭据。" />
    {accessError !== null && <ErrorNotice error={accessError} onRetry={() => setAccessError(null)} />}
    <SectionCard title="提交工单" detail="可填写紧急度、分类并附上问题截图。">
      <form className="stack" onSubmit={submit}>
        <label>问题标题<input className="input" value={title} maxLength={160} required disabled={create.isPending || !!savedTicket} onChange={e => setTitle(e.target.value)} /></label>
        <label>问题描述<textarea className="input" rows={5} value={body} maxLength={8000} required disabled={create.isPending || !!savedTicket} onChange={e => setBody(e.target.value)} /></label>
        <div className="support-fields">
          <label>紧急度<select className="input" value={urgency} disabled={create.isPending || !!savedTicket} onChange={e => setUrgency(e.target.value as Ticket['urgency'])}>{Object.entries(urgencies).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>问题分类<select className="input" value={category} disabled={create.isPending || !!savedTicket} onChange={e => setCategory(e.target.value as Ticket['category'])}>{Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        <label>上传问题图片<input className="input" type="file" accept={ticketImageTypes.join(',')} multiple disabled={create.isPending || !!savedTicket} aria-describedby="support-image-help" onChange={e => { selectImages(e.target.files); e.target.value = ''; }} /></label>
        <p id="support-image-help" className="muted">最多 {MAX_TICKET_IMAGES} 张，每张不超过 5 MiB；支持 PNG、JPEG、静态 WebP。截图请遮盖密码、密钥和个人资料。</p>
        {imageError && <p role="alert">{imageError}</p>}
        {images.length > 0 && <ul className="support-images" aria-label="已选择图片">{images.map(image => <li className="support-image" key={image.id}>
          <img src={image.preview} alt={`待上传图片：${image.file.name}`} />
          <span className="support-image-name">{image.file.name} · {(image.file.size / 1024 / 1024).toFixed(2)} MiB</span>
          <span role="status">{{ selected: '待上传', uploading: '正在上传……', uploaded: '已上传', failed: '上传失败' }[image.state]}</span>
          {image.error && <p role="alert">{image.error}</p>}
          {!savedTicket && <button type="button" className="button button-quiet" disabled={create.isPending} onClick={() => removeImage(image)}>移除 {image.file.name}</button>}
        </li>)}</ul>}
        {savedTicket && <p role="status">工单文字已保存。失败的图片可以重试，已成功的图片不会重复上传。<Link to={`/app/support/${savedTicket.id}`}>查看已保存工单</Link></p>}
        <button className="button button-primary" disabled={create.isPending || !!accessError || !title.trim() || !body.trim()}>{create.isPending ? '正在提交与上传……' : savedTicket ? '重试未上传图片' : '提交工单'}</button>
        {create.error && <ErrorNotice error={create.error} />}
      </form>
    </SectionCard>
    <SectionCard title="工单列表">
      <label>筛选状态<select className="input" value={filter} onChange={e => setSearch(e.target.value ? { status: e.target.value } : {})}><option value="">全部状态</option>{Object.entries(ticketStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {list.isLoading && <Spinner label="正在读取工单" />}
      {list.error && <ErrorNotice error={list.error} onRetry={() => void list.refetch()} />}
      {list.data && !accessError && !denied(list.error) && <>
        {list.data.items.length === 0 ? <p className="muted">暂无符合条件的工单。</p> : <ul className="support-ticket-list">{list.data.items.map(ticket => <li key={ticket.id}><Link to={`/app/support/${ticket.id}`}><strong>{ticket.title}</strong></Link><TicketTags ticket={ticket} /><small>{roleAdmin(account?.role) && `${ticket.ownerName} · `}创建于 {dateLabel(ticket.createdAt)}</small></li>)}</ul>}
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
  const [accessError, setAccessError] = useState<ApiError | null>(null);
  function denyAccess(error: unknown) {
    if (!denied(error)) return;
    setAccessError(error); setBody(''); setSelectedStatus(''); setNotice('');
    queryClient.removeQueries({ predicate: q => supportCache(q.queryKey) });
    void session.refetch();
  }
  async function protect<T>(load: () => Promise<T>): Promise<T> {
    try { return await load(); } catch (error) { denyAccess(error); throw error; }
  }
  const [notice, setNotice] = useState(''); const replyLocked = useRef(false);
  const key = [account?.id, account?.role, ticketId];
  const detail = useQuery({ queryKey: ['support-ticket', ...key], enabled: !!account && !!ticketId && !accessError,
    queryFn: ({ signal }) => protect(() => api.get<'SupportTicketResponse'>(ticketPath(ticketId), undefined, signal)), retry: false });
  const messages = useInfiniteQuery({ queryKey: ['support-messages', ...key], enabled: !!detail.data && !accessError && !denied(detail.error),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => protect(() => api.get<'SupportTicketMessagesResponse'>(`${ticketPath(ticketId)}/messages`, { cursor: pageParam, limit: 20 }, signal)),
    getNextPageParam: last => last.nextCursor ?? undefined, retry: false });
  async function refresh() { await Promise.all([queryClient.invalidateQueries({ queryKey: ['support-ticket', ...key] }), queryClient.invalidateQueries({ queryKey: ['support-messages', ...key] }), queryClient.invalidateQueries({ queryKey: ['support-tickets'] })]); }
  async function mutationFailure(error: Error) {
    if (denied(error)) { denyAccess(error); return; }
    if (error instanceof ApiError && error.status === 409) {
      setSelectedStatus('');
      const latest = await detail.refetch();
      if (!latest.error) { await queryClient.invalidateQueries({ queryKey: ['support-messages', ...key] }); setNotice('工单已被更新，已刷新最新状态；请检查后重试。回复草稿已保留。'); }
      else if (!denied(latest.error)) setNotice('工单状态已变化，但刷新失败。请先重试读取详情，再提交。回复草稿已保留。');
    }
  }
  const reply = useMutation({ mutationFn: () => api.post<'SupportTicketReplyResponse'>(`${ticketPath(ticketId)}/messages`, { body }),
    onSuccess: async () => { setBody(''); setNotice('回复已发送'); await refresh(); }, onError: mutationFailure, onSettled: () => { replyLocked.current = false; } });
  const changeStatus = useMutation({ mutationFn: () => api.patch<'SupportTicketResponse'>(`${ticketPath(ticketId)}/status`, { status: selectedStatus, revision: detail.data!.ticket.revision }),
    onSuccess: async () => { setSelectedStatus(''); setNotice('状态已更新'); await refresh(); }, onError: mutationFailure });
  function submitReply(event: FormEvent) { event.preventDefault(); if (replyLocked.current) return; replyLocked.current = true; setNotice(''); reply.mutate(); }
  const blocked = accessError || [detail.error, messages.error, reply.error, changeStatus.error, session.error].find(denied);
  const ticket = !blocked && account ? detail.data?.ticket : undefined;
  return <div className="page-stack support-page">
    <Link className="button button-quiet" to="/app/support">返回工单列表</Link>
    {blocked && <ErrorNotice error={blocked} onRetry={() => { setAccessError(null); reply.reset(); changeStatus.reset(); }} />}
    {detail.isLoading && !blocked && <Spinner label="正在读取工单详情" />}
    {detail.error && !blocked && <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />}
    {ticket && <>
      <PageHeading eyebrow="站内支持工单" title={ticket.title} detail={`${ticket.ownerName} · 创建于 ${dateLabel(ticket.createdAt)}`} />
      <SectionCard title="问题描述"><TicketTags ticket={ticket} /><p className="support-text">{ticket.body}</p>{(ticket.images ?? []).length > 0 && <div className="support-images" aria-label="工单图片">{ticket.images.map((image, index) => <TicketImage key={image.id} ticketId={ticket.id} image={image} index={index} />)}</div>}</SectionCard>
      {roleAdmin(account?.role) && <SectionCard title="处理状态"><label>工单状态<select className="input" value={selectedStatus || ticket.status} disabled={changeStatus.isPending || detail.isFetching || detail.isError} onChange={e => setSelectedStatus(e.target.value as Status)}>{Object.entries(ticketStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="button button-primary" disabled={changeStatus.isPending || detail.isFetching || detail.isError || !selectedStatus || selectedStatus === ticket.status} onClick={() => { setNotice(''); changeStatus.mutate(); }}>保存状态</button>{changeStatus.error && <ErrorNotice error={changeStatus.error} />}</SectionCard>}
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
