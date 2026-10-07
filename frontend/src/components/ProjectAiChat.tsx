import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FileText, ListChecks, Search, CircleDot, CheckCircle2, AlertCircle, LoaderCircle } from 'lucide-react';
import { useSession } from '../auth';
import { activityTime, type ActivityJob } from '../api/ai-activity';
import { chatResourceHref, clearChat, readChat, readChatOperations, sendChat, type ChatMessage, type ChatOperation } from '../api/project-chat';
import { completeIntent, idempotencyKeyForIntent, retryBackendJob, useVisibleJobPoller } from '../pages/aiWorkflowSupport';
import { AiActivityStatus } from './AiActivityStatus';
import { ProfileMarkdown } from './ProfileMarkdown';
import { ErrorNotice, SectionCard } from './ui';
import './project-ai-chat.css';

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine !== false);
  useEffect(() => { const update = () => setOnline(navigator.onLine !== false); window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); }; }, []);
  return online;
}
const icons = { search: Search, read: FileText, tasks: ListChecks, status: CircleDot };
function Operation({ projectId, operation }: { projectId: string; operation: ChatOperation }) {
  const Icon = icons[operation.kind];
  const State = operation.status === 'running' ? LoaderCircle : operation.status === 'failed' ? AlertCircle : CheckCircle2;
  const href = chatResourceHref(projectId, operation.href);
  return <li className={`project-chat-operation is-${operation.status}`}><Icon size={16} aria-hidden="true" /><div>{href ? <Link to={href}>{operation.label}</Link> : <span>{operation.label}</span>}{operation.detail && <small>{operation.detail}</small>}{operation.href && !href && <small>资源不可访问</small>}<small>尝试 {operation.attempt} · <time dateTime={operation.at}>{activityTime(operation.at)}</time></small></div><State size={14} aria-label={operation.status === 'running' ? '运行中' : operation.status === 'failed' ? '失败' : '完成'} /></li>;
}

function ChatRound({ projectId, userId, question, answer, online, busy, onState, onSend }: {
  projectId: string; userId: string; question: ChatMessage; answer?: ChatMessage; online: boolean; busy: boolean;
  onState: (questionId: string, active: boolean) => void; onSend: (content: string) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState<string | null>(null);
  const poll = useVisibleJobPoller(answer ? null : attempt ?? question.jobId);
  const [lastJob, setLastJob] = useState<ActivityJob | null>(null);
  const job = poll.job ?? lastJob;
  const active = !answer && (!job || job.status === 'running' || job.status === 'queued') && Boolean(question.jobId);
  const [open, setOpen] = useState(!answer);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);
  const previousStatus = useRef<string | undefined>(undefined);
  const settled = useRef<string | null>(null);
  useEffect(() => { if (poll.job) setLastJob(poll.job); }, [poll.job]);
  useEffect(() => { onState(question.questionId, active || resuming); return () => onState(question.questionId, false); }, [question.questionId, active, resuming, onState]);
  useEffect(() => {
    const status = answer ? 'succeeded' : job?.status;
    if (!status || previousStatus.current === status) return;
    previousStatus.current = status;
    setOpen(status !== 'succeeded');
  }, [job?.status, answer]);
  useEffect(() => {
    if (!job || !poll.isSettled) return;
    const key = `${job.jobId}:${job.status}`;
    if (settled.current === key) return;
    settled.current = key;
    void queryClient.invalidateQueries({ queryKey: ['project-ai-chat', projectId, userId] }, { cancelRefetch: false });
    const operationKey = ['project-chat-operations', projectId, userId, question.questionId];
    // Finish an in-flight next page before refreshing terminal operation states.
    void queryClient.invalidateQueries({ queryKey: operationKey }, { cancelRefetch: false })
      .then(() => queryClient.invalidateQueries({ queryKey: operationKey }, { cancelRefetch: false }));
  }, [job, poll.isSettled, queryClient, projectId, userId, question.questionId]);
  const operations = useInfiniteQuery({ queryKey: ['project-chat-operations', projectId, userId, question.questionId], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => readChatOperations(projectId, question.questionId, pageParam, signal), getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: online, refetchInterval: active && online ? 2_000 : false });
  // Paging/refetch can overlap. The latest server state of each operation wins.
  const items = [...new Map((operations.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()];
  const reads = items.filter(item => item.kind === 'read' && item.status === 'completed').length;
  const searched = items.some(item => item.kind === 'search' && item.status === 'completed');
  const resume = async () => {
    if (lock.current || !job || !online) return;
    lock.current = true; setResuming(true); setError(null);
    try { const id = await retryBackendJob(projectId, job.jobId); setLastJob(null); setAttempt(id); }
    catch (failure) { setError(failure); }
    finally { lock.current = false; setResuming(false); }
  };
  return <section className="project-chat-round" aria-label="项目问答">
    {question.content && <div className="project-chat-question"><strong>我</strong><p>{question.content}</p></div>}
    <div className="project-chat-answer"><strong>AI</strong>
      <details open={open} onToggle={event => setOpen(event.currentTarget.open)} className="project-chat-operations"><summary>{searched ? '已搜索项目资料 · ' : ''}{reads ? `已读取 ${reads} 项资源` : active ? '正在查阅项目资料' : job?.status === 'failed' ? '执行失败 · 查看操作记录' : '查看资源调用记录'}</summary>
        <ol>{items.map(operation => <Operation key={operation.id} operation={operation} projectId={projectId} />)}</ol>
        {operations.isLoading && <p role="status">正在读取操作记录…</p>}
        {operations.error && <ErrorNotice error={operations.error} onRetry={() => void operations.refetch()} />}
        {!operations.isLoading && !items.length && !operations.error && <p>尚无资源调用记录。</p>}
        {operations.hasNextPage && <button className="button button-quiet button-small" disabled={!online || operations.isFetchingNextPage} onClick={() => void operations.fetchNextPage()}>加载更多操作</button>}
      </details>
      {!answer && <AiActivityStatus job={job} jobId={job?.jobId ?? question.jobId ?? undefined} loading={poll.loading} readError={poll.error} onRefresh={poll.refresh} showHistory={false} onResume={online ? resume : undefined} resuming={resuming} />}
      {Boolean(error) && <ErrorNotice error={error} />}
      {answer && <><ProfileMarkdown value={answer.content} />{Boolean(answer.references?.length) && <ul className="project-chat-references">{answer.references?.map((reference, index) => { const href = chatResourceHref(projectId, reference.href); return <li key={index}>{href ? <Link to={href}>{reference.title}</Link> : <span>{reference.title}{reference.href || !reference.detail ? '（资源不可访问）' : ''}</span>}{reference.detail && <small>{reference.detail}</small>}</li>; })}</ul>}</>}
      {!answer && job?.status === 'failed' && <button className="button button-quiet button-small" disabled={!online || busy} onClick={() => void onSend(question.content)}>重新发起</button>}
    </div>
  </section>;
}

/** Keyed by project and authenticated user so no draft or operation survives an identity switch. */
export function ProjectAiChat({ projectId }: { projectId: string }) {
  const session = useSession();
  return <ChatCard key={`${projectId}:${session.data?.id ?? 'unknown'}`} projectId={projectId} userId={session.data?.id ?? 'unknown'} />;
}
function ChatCard({ projectId, userId }: { projectId: string; userId: string }) {
  const online = useOnline();
  const client = useQueryClient();
  const queryKey = ['project-ai-chat', projectId, userId];
  const history = useInfiniteQuery({ queryKey, initialPageParam: undefined as string | undefined, queryFn: ({ pageParam, signal }) => readChat(projectId, pageParam, signal), getNextPageParam: page => page.nextCursor ?? undefined, enabled: online });
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [activeRounds, setActiveRounds] = useState<Record<string, boolean>>({});
  const lock = useRef(false);
  const composing = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const onState = useRef((questionId: string, active: boolean) => setActiveRounds(current => current[questionId] === active ? current : { ...current, [questionId]: active })).current;
  const messages = [...new Map([...(history.data?.pages ?? [])].reverse().flatMap(page => page.items).map(item => [item.id, item])).values()];
  const questionIds = new Set(messages.filter(item => item.role === 'user').map(item => item.questionId));
  const questions = messages.flatMap(item => item.role === 'user' ? [item] : !questionIds.has(item.questionId) ? [{ ...item, role: 'user' as const, content: '' }] : []);
  const answers = new Map(messages.filter(item => item.role === 'assistant').map(item => [item.questionId, item]));
  const busy = submitting || clearing || Object.values(activeRounds).some(Boolean) || Boolean(history.data?.pages[0]?.pendingJobId);
  const scrollSignature = messages.map(message => `${message.id}:${message.content}`).join('|');
  useEffect(() => { if (atBottom.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; }, [scrollSignature, submitting]);
  const send = async (content: string) => {
    const trimmed = content.trim();
    if (lock.current || busy || !online || !trimmed || trimmed.length > 4_000) return;
    lock.current = true; setSubmitting(true); setError(null);
    const namespace = `project-chat:${projectId}:${userId}`;
    try {
      const key = await idempotencyKeyForIntent(namespace, { content: trimmed });
      const result = await sendChat(projectId, trimmed, key);
      client.setQueryData(queryKey, (current: { pages: { items: ChatMessage[]; nextCursor: string | null; pendingJobId: string | null }[]; pageParams: unknown[] } | undefined) => ({ pages: current?.pages.map((page, index) => index ? page : { ...page, pendingJobId: result.jobId, items: [...page.items, { id: `pending-${result.questionId}`, questionId: result.questionId, role: 'user' as const, content: trimmed, createdAt: new Date().toISOString(), jobId: result.jobId }] }) ?? [], pageParams: current?.pageParams ?? [] }));
      completeIntent(namespace); setInput(''); atBottom.current = true;
      await client.invalidateQueries({ queryKey });
    } catch (failure) { setError(failure); }
    finally { lock.current = false; setSubmitting(false); }
  };
  const clear = async () => {
    if (lock.current || busy || !online) return;
    lock.current = true; setClearing(true); setError(null);
    const namespace = `project-chat-clear:${projectId}:${userId}`;
    try {
      await client.cancelQueries({ queryKey });
      const key = await idempotencyKeyForIntent(namespace, {});
      await clearChat(projectId, key); completeIntent(namespace);
      // A background read started before DELETE must not restore cleared history.
      await client.cancelQueries({ queryKey });
      await client.cancelQueries({ queryKey: ['project-chat-operations', projectId, userId] });
      client.removeQueries({ queryKey: ['project-chat-operations', projectId, userId] });
      client.setQueryData(queryKey, { pages: [{ items: [], nextCursor: null, pendingJobId: null }], pageParams: [undefined] });
      setActiveRounds({}); setInput('');
    } catch (failure) { setError(failure); }
    finally { lock.current = false; setClearing(false); }
  };
  return <SectionCard title="询问 AI" detail="根据当前项目资料回答你的问题。">
    <div className="project-ai-chat">
      <div className="project-chat-history" ref={viewport} role="log" aria-label="对话历史" onScroll={() => { const node = viewport.current; if (node) atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40; }}>
        {history.hasNextPage && <button className="button button-quiet button-small" disabled={!online || history.isFetchingNextPage} onClick={() => { atBottom.current = false; const height = viewport.current?.scrollHeight ?? 0; void history.fetchNextPage().then(() => { requestAnimationFrame(() => { if (viewport.current) viewport.current.scrollTop += viewport.current.scrollHeight - height; }); }); }}>加载更早对话</button>}
        {history.isLoading && <p role="status">正在读取对话历史…</p>}
        {history.error && <ErrorNotice error={history.error} onRetry={() => void history.refetch()} />}
        {!history.isLoading && !questions.length && !history.error && <p className="muted">可以询问项目目标、任务进度或资料中的要求。</p>}
        {questions.map(question => <ChatRound key={question.questionId} projectId={projectId} userId={userId} question={question} answer={answers.get(question.questionId)} online={online} busy={busy} onState={onState} onSend={send} />)}
      </div>
      {!online && <p role="status">已离线，联网后继续读取执行状态。</p>}
      {Boolean(error) && <ErrorNotice error={error} />}
      <label htmlFor={`project-chat-input-${projectId}`} className="field-label">向 AI 提问</label>
      <textarea className="input textarea" id={`project-chat-input-${projectId}`} rows={3} maxLength={4_000} value={input} placeholder="询问关于这个项目的问题…" onChange={event => setInput(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current && event.keyCode !== 229) { event.preventDefault(); void send(input); } }} />
      <div className="project-chat-controls"><small>{input.length}/4000</small><button className="button button-quiet" disabled={busy || !online || !questions.length || history.isLoading} onClick={() => void clear()}>{clearing ? '正在清空…' : '清空历史记录'}</button><button className="button button-primary" disabled={busy || !online || !input.trim() || history.isLoading || Boolean(history.error)} onClick={() => void send(input)}>{submitting ? '正在发送…' : '发送'}</button></div>
    </div>
  </SectionCard>;
}
