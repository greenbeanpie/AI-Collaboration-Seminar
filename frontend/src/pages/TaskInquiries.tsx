import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { projectRequest } from '../api/simplification';
import { ErrorNotice, Spinner } from '../components/ui';
import { idempotencyKeyForIntent, completeIntent } from './aiWorkflowSupport';

type Message = { messageId: string; authorId: string; authorName: string; body: string; createdAt: string };
type Inquiry = { inquiryId: string; taskId: string; upstreamTaskId: string; taskTitle: string; upstreamTitle: string; requesterId: string; requesterName: string; recipientId: string; recipientName: string; recipientSource: string; messages: Message[] };
type Inbox = { items: Inquiry[] };
type MemberOption = { userId: string; displayName: string };

async function send(projectId: string, path: string, body: unknown) {
  const namespace = `inquiry:${projectId}:${path}`;
  const idempotencyKey = await idempotencyKeyForIntent(namespace, body);
  const result = await projectRequest(projectId, path, { method: 'POST', body, idempotencyKey });
  completeIntent(namespace);
  return result;
}

export function TaskInquiries({ projectId, taskId, taskTitle, meId, members }: {
  projectId: string;
  taskId: string;
  taskTitle?: string;
  meId?: string;
  members: MemberOption[];
}) {
  const client = useQueryClient();
  const key = ['task-inquiries', projectId, taskId, meId];
  const query = useQuery({ queryKey: key, queryFn: () => projectRequest<Inbox>(projectId, `/tasks/${taskId}/inquiries`), refetchInterval: 30_000 });
  const [readError, setReadError] = useState<unknown>(null);

  useEffect(() => {
    if (!query.data) return;
    let active = true;
    const messageIds = query.data.items.flatMap(thread => thread.messages.map(item => item.messageId));
    if (!messageIds.length) return;
    const markRead = async () => {
      for (let index = 0; index < messageIds.length; index += 200) {
        await projectRequest(projectId, `/tasks/${taskId}/inquiries/read`, { method: 'POST', body: { messageIds: messageIds.slice(index, index + 200) } });
      }
      if (active) {
        setReadError(null);
        await client.invalidateQueries({ queryKey: ['task-inquiries-unread', projectId] });
        await client.invalidateQueries({ queryKey: ['notifications'] });
      }
    };
    void markRead().catch(error => { if (active) setReadError(error); });
    return () => { active = false; };
  }, [query.data, projectId, taskId, client]);

  const [recipientId, setRecipientId] = useState('');
  const [body, setBody] = useState('');
  const recipients = meId ? members.filter(member => member.userId !== meId) : [];
  const create = useMutation({
    mutationFn: () => send(projectId, `/tasks/${taskId}/inquiries`, { recipientId, body }),
    onSuccess: async () => {
      setBody('');
      setRecipientId('');
      await Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({ queryKey: ['task-inquiries-unread', projectId] }),
        client.invalidateQueries({ queryKey: ['notifications'] }),
      ]);
    },
  });

  const title = taskTitle || '当前任务';
  return <section className="stack" aria-label="任务质询">
    <h3>任务质询 · {title}</h3>
    <form className="stack task-inquiry-create" onSubmit={event => { event.preventDefault(); create.mutate(); }}>
      <strong>新建一对一质询工单</strong>
      <p className="form-note">工单和双方回复都保存在“{title}”任务中，仅发起人与质询对象可见。</p>
      <label>质询对象<select className="input" required value={recipientId} onChange={event => setRecipientId(event.target.value)}>
        <option value="">选择一位项目成员</option>
        {recipients.map(member => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}
      </select></label>
      <label>质询内容<textarea className="input" required maxLength={4000} value={body} onChange={event => setBody(event.target.value)} placeholder="说明与此任务有关的问题" /></label>
      <button className="button" disabled={!meId || !recipientId || !body.trim() || create.isPending}>{create.isPending ? '创建中…' : '创建质询工单'}</button>
      {create.error && <ErrorNotice error={create.error} />}
      {!recipients.length && <p className="form-note">项目中暂无可质询的其他成员。</p>}
    </form>
    {query.isPending && <Spinner />}
    {query.error && <ErrorNotice error={query.error} />}
    {readError != null && <ErrorNotice error={readError} />}
    <div className="stack" aria-label="任务质询工单列表">
      <h4>与我有关的工单</h4>
      {query.data && !query.data.items.length && <p className="form-note">此任务暂无与你有关的质询工单。</p>}
      {query.data?.items.map(thread => <InquiryThread key={thread.inquiryId} projectId={projectId} taskId={taskId} meId={meId} thread={thread} refresh={() => client.invalidateQueries({ queryKey: key })} />)}
    </div>
  </section>;
}

function InquiryThread({ projectId, taskId, meId, thread, refresh }: {
  projectId: string;
  taskId: string;
  meId?: string;
  thread: Inquiry;
  refresh: () => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const reply = useMutation({
    mutationFn: () => send(projectId, `/task-inquiries/${thread.inquiryId}/messages`, { body }),
    onSuccess: async () => { setBody(''); await refresh(); },
  });
  const taskName = taskId === thread.taskId ? thread.taskTitle : thread.upstreamTitle;
  const recipientLabel = thread.requesterId === meId ? `发给${thread.recipientName}` : `来自${thread.requesterName}`;
  return <article className="callout stack task-inquiry-ticket">
    <div className="collab-toolbar"><strong>任务质询工单 · {taskName}</strong><small>{recipientLabel}</small></div>
    <div className="task-inquiry-messages" aria-label="工单消息">
      {thread.messages.map(item => <div className={item.authorId === meId ? 'task-inquiry-message task-inquiry-message-own' : 'task-inquiry-message'} key={item.messageId}>
        <small>{item.authorName} · {new Date(item.createdAt).toLocaleString('zh-CN')}</small>
        <p className="collab-preserve">{item.body}</p>
      </div>)}
    </div>
    <form className="stack" onSubmit={event => { event.preventDefault(); reply.mutate(); }}>
      <label>回复工单<textarea className="input" required maxLength={4000} value={body} onChange={event => setBody(event.target.value)} /></label>
      <button className="button" disabled={!body.trim() || reply.isPending}>{reply.isPending ? '发送中…' : '发送回复'}</button>
      {reply.error && <ErrorNotice error={reply.error} />}
    </form>
  </article>;
}
