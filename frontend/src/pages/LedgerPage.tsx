import { DateInput } from '../components/DateInput';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, BookOpenCheck, FilePlus2, History, Plus, Send, ShieldCheck } from 'lucide-react';
import { api, listAllItems, projectPath } from '../api/client';
import type { Contribution, Decision, Member, Resource } from '../api/types';
import { presentEvent } from './event-presentation';
import { useProject } from '../components/ProjectShell';
import { ErrorNotice, EmptyState, Field, PageHeading, SectionCard, Spinner, StatusPill } from '../components/ui';

export function LedgerPage() {
  const { projectId, project } = useProject();
  const queryClient = useQueryClient();
  const eventsQuery = useQuery({ queryKey: ['events', projectId], queryFn: () => listAllItems<'EventListResponse'>(projectPath(projectId, '/events'), { limit: 100 }, { requireNextCursor: true }) });
  const decisionsQuery = useQuery({ queryKey: ['decisions', projectId], queryFn: () => api.get<'DecisionListResponse'>(projectPath(projectId, '/decisions')) });
  const contributionsQuery = useQuery({ queryKey: ['contributions', projectId], queryFn: () => api.get<'ContributionListResponse'>(projectPath(projectId, '/contributions')) });
  const resourcesQuery = useQuery({ queryKey: ['resources', projectId], queryFn: () => api.get<'ResourceListResponse'>(projectPath(projectId, '/resources')) });
  const membersQuery = useQuery({ queryKey: ['members', projectId], queryFn: () => listAllItems<'MemberListResponse'>(projectPath(projectId, '/members')) });
  const [decisionTitle, setDecisionTitle] = useState('');
  const [decisionDetail, setDecisionDetail] = useState('');
  const [decisionDate, setDecisionDate] = useState('');
  const [contributionUserId, setContributionUserId] = useState('');
  const [contributionDescription, setContributionDescription] = useState('');
  const [contributionKind, setContributionKind] = useState('manual');
  const [correctionText, setCorrectionText] = useState<Record<string, string>>({});
  const [resourceKind, setResourceKind] = useState<'url' | 'file' | 'model' | 'other'>('url');
  const [resourceTitle, setResourceTitle] = useState('');
  const [resourceUrl, setResourceUrl] = useState('');
  const [resourceFileId, setResourceFileId] = useState('');
  const [resourceNote, setResourceNote] = useState('');

  const invalidate = async (key: string) => queryClient.invalidateQueries({ queryKey: [key, projectId] });
  const createDecision = useMutation({
    mutationFn: () => api.post<'DecisionResponse'>(projectPath(projectId, '/decisions'), { title: decisionTitle.trim(), detail: decisionDetail.trim(), ...(decisionDate ? { decidedAt: new Date(decisionDate).toISOString() } : {}) }),
    onSuccess: async () => { setDecisionTitle(''); setDecisionDetail(''); setDecisionDate(''); await invalidate('decisions'); await invalidate('events'); },
  });
  const createContribution = useMutation({
    mutationFn: () => api.post<'ContributionResponse'>(projectPath(projectId, '/contributions'), {
      ...(contributionUserId ? { userId: contributionUserId } : {}), kind: contributionKind,
      description: contributionDescription.trim(), evidence: {},
    }),
    onSuccess: async () => { setContributionDescription(''); await invalidate('contributions'); await invalidate('events'); },
  });
  const createCorrection = useMutation({
    mutationFn: ({ id, description }: { id: string; description: string }) => api.post<'ContributionResponse'>(projectPath(projectId, `/contributions/${encodeURIComponent(id)}/corrections`), { description }),
    onSuccess: async (_result, variables) => { setCorrectionText((current) => ({ ...current, [variables.id]: '' })); await invalidate('contributions'); await invalidate('events'); },
  });
  const createResource = useMutation({
    mutationFn: () => api.post<'ResourceResponse'>(projectPath(projectId, '/resources'), {
      kind: resourceKind, title: resourceTitle.trim(),
      url: resourceKind === 'url' ? resourceUrl.trim() : null,
      fileId: resourceKind === 'file' && resourceFileId ? resourceFileId.trim() : null,
      meta: resourceNote.trim() ? { note: resourceNote.trim() } : {},
    }),
    onSuccess: async () => { setResourceTitle(''); setResourceUrl(''); setResourceFileId(''); setResourceNote(''); await invalidate('resources'); await invalidate('events'); },
  });

  const loading = eventsQuery.isLoading && decisionsQuery.isLoading && contributionsQuery.isLoading && resourcesQuery.isLoading;
  const errors = [eventsQuery, decisionsQuery, contributionsQuery, resourcesQuery, membersQuery].filter((query) => query.error);
  const events = eventsQuery.data ?? [];
  const decisions = decisionsQuery.data?.items ?? [];
  const contributions = contributionsQuery.data?.items ?? [];
  const resources = resourcesQuery.data?.items ?? [];
  const members = membersQuery.data ?? [];
  const nameFor = (userId: string) => members.find((member: Member) => member.userId === userId)?.displayName ?? userId.slice(0, 8);
  if (loading) return <Spinner label="正在读取过程记录" />;

  return <div className="page-stack ledger-page">
    <PageHeading eyebrow="可追溯协作" title="过程账本" detail="记录团队决策、成员贡献、AI 使用和第三方资源。贡献记录用于说明过程，不生成个人排名。" />
    {errors.map((query, index) => <ErrorNotice key={index} error={query.error} onRetry={() => void query.refetch()} />)}
    <div className="ledger-warning"><ShieldCheck size={18} /><span>账本用于留痕与交接。贡献说明可以更正，原始记录会保留；请只记录可核实的事实。</span></div>

    <SectionCard title="事件流" detail="按发生时间列出服务端记录的决策、贡献和 AI 操作。" action={<StatusPill tone="blue">{events.length} 条</StatusPill>}>
      {events.length ? <div className="ledger-timeline">{events.map((event) => { const activity = presentEvent(event); return <div className="ledger-line" key={event.eventId}><span className={`ledger-marker actor-${event.actorType}`} /><div className="ledger-content"><div className="ledger-event-title"><strong>{activity.title}</strong><span>{activity.actor}</span></div><p>{activity.detail}</p><small>{new Date(event.occurredAt).toLocaleString('zh-CN')}</small></div></div>; })}</div> : <EmptyState title="暂无事件记录" detail="创建项目决策、补录贡献或发生 AI 工作流后，事件会出现在这里。" />}
    </SectionCard>

    <div className="two-column">
      <SectionCard title="决策记录" detail="记录时间、结论和团队形成共识的上下文。">
        <form className="stack ledger-form" onSubmit={(event) => { event.preventDefault(); createDecision.mutate(); }}>
          <Field label="决策标题"><input className="input" required maxLength={200} value={decisionTitle} onChange={(event) => setDecisionTitle(event.target.value)} placeholder="例如：确定作品介绍结构" /></Field>
          <Field label="决策背景和内容"><textarea className="input textarea" rows={3} maxLength={4000} value={decisionDetail} onChange={(event) => setDecisionDetail(event.target.value)} placeholder="描述决定事项和依据……" /></Field>
          <Field label="决策时间" hint="未填写时由后端记录当前时间；填写时按本地时区转换为 ISO 时间。"><DateInput className="input" type="datetime-local" value={decisionDate} onChange={(event) => setDecisionDate(event.target.value)} /></Field>
          {createDecision.error && <ErrorNotice error={createDecision.error} />}
          <button className="button button-primary" disabled={createDecision.isPending || !decisionTitle.trim()}><Plus size={15} />记录决策</button>
        </form>
        <div className="divider" />
        {decisions.length ? <div className="ledger-records">{decisions.map((decision: Decision) => <article className="ledger-record" key={decision.decisionId}><div><strong>{decision.title}</strong><StatusPill tone="neutral">{new Date(decision.decidedAt).toLocaleDateString('zh-CN')}</StatusPill></div><p>{decision.detail || '未填写额外说明。'}</p><small>{nameFor(decision.madeBy)} · 记录于 {new Date(decision.createdAt).toLocaleString('zh-CN')}</small></article>)}</div> : <p className="muted">尚未记录决策。</p>}
      </SectionCard>

      <SectionCard title="贡献记录" detail="可代表自己或团队成员补录；原记录不会被修改或删除。">
        <form className="stack ledger-form" onSubmit={(event) => { event.preventDefault(); createContribution.mutate(); }}>
          <div className="form-grid-two"><Field label="成员"><select className="input" disabled={project.myRole !== 'owner'} value={contributionUserId} onChange={(event) => setContributionUserId(event.target.value)}><option value="">记录给我自己</option>{project.myRole === 'owner' && members.map((member: Member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}</select></Field><Field label="记录类型"><select className="input" value={contributionKind} onChange={(event) => setContributionKind(event.target.value)}><option value="manual">人工补录</option><option value="research">调研</option><option value="design">设计</option><option value="development">开发</option><option value="writing">文案</option><option value="presentation">演示</option><option value="other">其他</option></select></Field></div>
          <Field label="具体贡献和依据"><textarea className="input textarea" required rows={3} maxLength={2000} value={contributionDescription} onChange={(event) => setContributionDescription(event.target.value)} placeholder="描述完成了什么，以及可在哪里核实……" /></Field>
          {createContribution.error && <ErrorNotice error={createContribution.error} />}
          <button className="button button-primary" disabled={createContribution.isPending || !contributionDescription.trim()}><Plus size={15} />添加贡献记录</button>
        </form>
        <div className="divider" />
        {contributions.length ? <div className="ledger-records">{contributions.map((contribution: Contribution) => <article className="ledger-record" key={contribution.contributionId}><div><strong>{nameFor(contribution.userId)} · {contribution.kind === 'correction' ? '更正记录' : contribution.kind}</strong>{contribution.correctionOf && <StatusPill tone="warn">更正自原记录</StatusPill>}</div><p>{contribution.description}</p><small>{new Date(contribution.createdAt).toLocaleString('zh-CN')}</small>{!contribution.correctionOf && <form className="correction-form" onSubmit={(event) => { event.preventDefault(); createCorrection.mutate({ id: contribution.contributionId, description: (correctionText[contribution.contributionId] ?? '').trim() }); }}><input className="input input-sm" maxLength={2000} value={correctionText[contribution.contributionId] ?? ''} onChange={(event) => setCorrectionText((current) => ({ ...current, [contribution.contributionId]: event.target.value }))} placeholder="有误时补充一条更正说明" /><button className="button button-quiet button-small" disabled={createCorrection.isPending || !(correctionText[contribution.contributionId] ?? '').trim()}><History size={13} />追加更正</button></form>}</article>)}</div> : <p className="muted">尚未记录成员贡献。</p>}
        {createCorrection.error && <ErrorNotice error={createCorrection.error} />}
      </SectionCard>
    </div>

    <SectionCard title="第三方资源声明" detail="登记外部图片、模型、引用或其他素材，方便团队整理来源和许可信息。">
      <form className="resource-form" onSubmit={(event) => { event.preventDefault(); createResource.mutate(); }}>
        <Field label="资源类型"><select className="input" value={resourceKind} onChange={(event) => setResourceKind(event.target.value as typeof resourceKind)}><option value="url">网址</option><option value="file">项目文件</option><option value="model">模型或服务</option><option value="other">其他</option></select></Field>
        <Field label="资源名称"><input className="input" required maxLength={200} value={resourceTitle} onChange={(event) => setResourceTitle(event.target.value)} placeholder="填写资源名称" /></Field>
        {resourceKind === 'url' && <Field label="来源网址"><input className="input" type="url" required maxLength={2048} value={resourceUrl} onChange={(event) => setResourceUrl(event.target.value)} placeholder="https://…" /></Field>}
        {resourceKind === 'file' && <Field label="已上传文件 ID" hint="可在文件上传流程中获取 fileId。"><input className="input mono" value={resourceFileId} onChange={(event) => setResourceFileId(event.target.value)} placeholder="UUID" /></Field>}
        <Field label="许可或使用说明"><input className="input" maxLength={500} value={resourceNote} onChange={(event) => setResourceNote(event.target.value)} placeholder="填写授权范围、模型版本或其他备注" /></Field>
        {createResource.error && <ErrorNotice error={createResource.error} />}
        <button className="button button-primary" disabled={createResource.isPending || !resourceTitle.trim() || (resourceKind === 'url' && !resourceUrl.trim())}><FilePlus2 size={15} />声明资源</button>
      </form>
      {resources.length ? <div className="resource-list">{resources.map((resource: Resource) => <article className="resource-item" key={resource.resourceId}><span className="resource-kind">{resource.kind === 'url' ? <Send size={15} /> : resource.kind === 'file' ? <Archive size={15} /> : <BookOpenCheck size={15} />}</span><div><strong>{resource.title}</strong><small>{resource.kind} · {new Date(resource.createdAt).toLocaleDateString('zh-CN')}</small>{resource.url && (resource.url.startsWith('https://') || resource.url.startsWith('http://')) ? <a href={resource.url} target="_blank" rel="noopener noreferrer">{resource.url}</a> : resource.url && <small>{resource.url}</small>}</div></article>)}</div> : <p className="muted">尚未声明第三方资源。</p>}
    </SectionCard>
  </div>;
}
