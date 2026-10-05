import { AiReferenceBadge } from '../components/AiReferenceBadge';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { MessageCircle, Send } from 'lucide-react';
import { api, projectPath } from '../api/client';
import type { DataOf } from '../api/types';
import { EmptyState, ErrorNotice, Spinner } from '../components/ui';

export type CursorPage<T> = { items: T[]; nextCursor: string | null };
export type CommentEntry = DataOf<'CommentListResponse'>['items'][number];
export type CommentTarget = 'task' | 'material';

export async function loadCursorPages<T>(loadPage: (cursor?: string) => Promise<CursorPage<T>>): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
    const page = await loadPage(cursor);
    if (!page || !Array.isArray(page.items) || !('nextCursor' in page) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) throw new Error('服务端列表响应缺少分页字段，无法确认完整结果。');
    items.push(...page.items);
    if (!page.nextCursor) return items;
    if (seenCursors.has(page.nextCursor)) throw new Error('服务端返回了重复分页游标，已停止加载以避免遗漏记录。');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('列表超过安全分页上限，无法确认完整结果。');
}

type TiptapNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: TiptapNode[];
};

function asNode(value: unknown): TiptapNode | null {
  return typeof value === 'object' && value !== null ? value as TiptapNode : null;
}

function renderInlineMarkdown(node: TiptapNode): string {
  if (node.type === 'text') {
    let text = node.text ?? '';
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') text = `**${text}**`;
      else if (mark.type === 'italic') text = `*${text}*`;
      else if (mark.type === 'strike') text = `~~${text}~~`;
      else if (mark.type === 'code') text = `\`${text}\``;
      else if (mark.type === 'link') text = `[${text}](${String(mark.attrs?.href ?? '')})`;
    }
    return text;
  }
  if (node.type === 'hardBreak') return '  \n';
  return (node.content ?? []).map(renderInlineMarkdown).join('');
}

function plainText(node: TiptapNode): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(plainText).join('');
}

function tableMarkdown(rows: TiptapNode[]): string[] {
  const lines = rows.map((row) => (row.content ?? []).map((cell) =>
    renderInlineMarkdown(cell).replaceAll('|', '\\|').replaceAll('\n', ' '),
  ));
  if (!lines.length) return [];
  const header = lines[0] ?? [];
  const output = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of lines.slice(1)) output.push(`| ${row.join(' | ')} |`);
  return output;
}

/** Converts the supported editor nodes to Markdown without dropping tables or link marks. */
export function docToMarkdown(value: unknown): string {
  const root = asNode(value);
  if (root?.type !== 'doc' || !Array.isArray(root.content)) return '';
  const blocks: string[] = [];

  for (const node of root.content) {
    switch (node.type) {
      case 'heading': {
        const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
        blocks.push(`${'#'.repeat(level)} ${renderInlineMarkdown(node)}`);
        break;
      }
      case 'paragraph':
        blocks.push(renderInlineMarkdown(node));
        break;
      case 'bulletList':
        for (const item of node.content ?? []) blocks.push(`- ${plainText(item)}`);
        break;
      case 'orderedList': {
        const start = Number(node.attrs?.start ?? 1);
        (node.content ?? []).forEach((item, index) => blocks.push(`${start + index}. ${plainText(item)}`));
        break;
      }
      case 'blockquote':
        for (const child of node.content ?? []) blocks.push(`> ${renderInlineMarkdown(child)}`);
        break;
      case 'table':
        blocks.push(...tableMarkdown(node.content ?? []));
        break;
      case 'horizontalRule':
        blocks.push('---');
        break;
      default:
        break;
    }
  }
  return blocks.join('\n\n').trim();
}

function safeHref(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const protocol = new URL(value, window.location.origin).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:' ? value : null;
  } catch {
    return null;
  }
}

function InlineContent({ node }: { node: TiptapNode }) {
  let content: ReactNode = node.type === 'text' ? node.text : (node.content ?? []).map((child, index) => <InlineContent key={index} node={child} />);
  if (node.type === 'hardBreak') return <br />;
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') content = <strong>{content}</strong>;
    else if (mark.type === 'italic') content = <em>{content}</em>;
    else if (mark.type === 'strike') content = <s>{content}</s>;
    else if (mark.type === 'code') content = <code>{content}</code>;
    else if (mark.type === 'link') {
      const href = safeHref(mark.attrs?.href);
      content = href ? <a href={href} target="_blank" rel="noreferrer">{content}</a> : content;
    }
  }
  return <>{content}</>;
}

function DocumentNode({ node }: { node: TiptapNode }) {
  const children = (node.content ?? []).map((child, index) => <DocumentNode key={index} node={child} />);
  switch (node.type) {
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      if (level === 1) return <h1>{(node.content ?? []).map((child, index) => <InlineContent key={index} node={child} />)}</h1>;
      if (level === 2) return <h2>{(node.content ?? []).map((child, index) => <InlineContent key={index} node={child} />)}</h2>;
      if (level === 3) return <h3>{(node.content ?? []).map((child, index) => <InlineContent key={index} node={child} />)}</h3>;
      if (level === 4) return <h4>{(node.content ?? []).map((child, index) => <InlineContent key={index} node={child} />)}</h4>;
      if (level === 5) return <h5>{(node.content ?? []).map((child, index) => <InlineContent key={index} node={child} />)}</h5>;
      return <h6>{(node.content ?? []).map((child, index) => <InlineContent key={index} node={child} />)}</h6>;
    }
    case 'paragraph': return <p>{(node.content ?? []).map((child, index) => <InlineContent key={index} node={child} />)}</p>;
    case 'bulletList': return <ul>{children}</ul>;
    case 'orderedList': return <ol start={Number(node.attrs?.start ?? 1)}>{children}</ol>;
    case 'listItem': return <li>{children}</li>;
    case 'blockquote': return <blockquote>{children}</blockquote>;
    case 'table': return <table><tbody>{children}</tbody></table>;
    case 'tableRow': return <tr>{children}</tr>;
    case 'tableHeader': return <th>{children}</th>;
    case 'tableCell': return <td>{children}</td>;
    case 'horizontalRule': return <hr />;
    case 'hardBreak': return <br />;
    case 'text': return <InlineContent node={node} />;
    default: return <>{children}</>;
  }
}

export function MaterialDocumentView({ doc, className = '' }: { doc: unknown; className?: string }) {
  const root = asNode(doc);
  if (root?.type !== 'doc' || !Array.isArray(root.content)) return <p>此版本没有可预览的正文。</p>;
  return <div className={className}><span className="tm-hide-print"><AiReferenceBadge /></span>{root.content.map((node, index) => <DocumentNode key={index} node={node} />)}</div>;
}

type CommentsPanelProps = { projectId: string; targetType: CommentTarget; targetId: string; presentation?: 'disclosure' | 'content' };

export function CommentsPanel({ projectId, targetType, targetId, presentation = 'disclosure' }: CommentsPanelProps) {
  return <CommentsPanelContent key={`${projectId}:${targetType}:${targetId}`} projectId={projectId} targetType={targetType} targetId={targetId} presentation={presentation} />;
}

function CommentsPanelContent({ projectId, targetType, targetId, presentation }: CommentsPanelProps) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const [page, setPage] = useState(0);
  const queryKey = ['comments', projectId, targetType, targetId] as const;
  const commentsQuery = useQuery({
    queryKey,
    queryFn: () => loadCursorPages<CommentEntry>((cursor) => api.get<'CommentListResponse'>(
      projectPath(projectId, '/comments'),
      { targetType, targetId, cursor, limit: 100 },
    )),
  });
  const createComment = useMutation({
    mutationFn: (commentBody: string) => api.post<'CommentResponse'>(projectPath(projectId, '/comments'), { targetType, targetId, body: commentBody.trim() }),
    onSuccess: async (created) => {
      setBody('');
      await queryClient.invalidateQueries({ queryKey });
      const comments = queryClient.getQueryData<CommentEntry[]>(queryKey) ?? [];
      const index = comments.findIndex(comment => comment.commentId === created.commentId);
      if (index >= 0) setPage(Math.floor(index / 5));
    },
  });

  const pageCount = Math.max(1, Math.ceil((commentsQuery.data?.length ?? 0) / 5));
  const currentPage = Math.min(page, pageCount - 1);
  const Container = presentation === 'content' ? 'section' : 'details';
  return (
    <Container className="tm-comments" aria-label="评论">
      {presentation !== 'content' && <summary className="tm-section-title tm-disclosure-heading"><span><MessageCircle size={16} />讨论</span><span>{commentsQuery.data?.length ?? '—'}</span></summary>}
      <div className="tm-disclosure-content">
      {commentsQuery.isLoading && <Spinner label="正在读取评论" />}
      {commentsQuery.error && <ErrorNotice error={commentsQuery.error} onRetry={() => void commentsQuery.refetch()} />}
      {commentsQuery.data?.length === 0 && <EmptyState title="还没有评论" detail="围绕任务或材料记录讨论，评论将保存在当前项目中。" />}
      {!!commentsQuery.data?.length && <ol className="tm-comment-list">{commentsQuery.data.slice(currentPage * 5, (currentPage + 1) * 5).map((comment) => (
        <li key={comment.commentId} className="tm-comment">
          <div className="tm-comment-meta"><strong>{comment.authorName}</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time></div>
          <AiReferenceBadge /><p>{comment.body}</p>
        </li>
      ))}</ol>}
      {!!commentsQuery.data?.length && <nav className="tm-list-pagination" aria-label="讨论分页"><button type="button" className="button button-quiet button-small" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {pageCount}</span><button type="button" className="button button-quiet button-small" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>下一页</button></nav>}
      <form className="tm-comment-form" onSubmit={(event) => { event.preventDefault(); if (body.trim()) createComment.mutate(body); }}>
        <label className="tm-sr-only" htmlFor={`comment-${targetType}-${targetId}`}>发表评论</label>
        <AiReferenceBadge /><textarea id={`comment-${targetType}-${targetId}`} value={body} onChange={(event) => setBody(event.target.value)} maxLength={4000} rows={3} placeholder="写下评论…" />
        <button className="button button-primary button-small" type="submit" disabled={!body.trim() || createComment.isPending}><Send size={14} />{createComment.isPending ? '发送中' : '发送'}</button>
      </form>
      {createComment.error && <ErrorNotice error={createComment.error} />}
      </div>
    </Container>
  );
}
