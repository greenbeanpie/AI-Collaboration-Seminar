import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ArrowLeft, LayoutTemplate, ListChecks } from 'lucide-react';
import { api } from '../api/client';
import { isTemplatePayload, projectTemplateApi } from '../api/project-templates';
import { useSession } from '../auth';
import { EmptyState, ErrorNotice, PageHeading, Spinner } from '../components/ui';
import { readCreationDraft } from './project-creation-workflow';
import './TemplateDraftWorkspace.css';

export function NewProjectEntryPage() {
  const session = useSession();
  if (session.isLoading) return <Spinner label="正在确认创建账户" />;
  if (session.error) return <ErrorNotice error={session.error} />;
  if (!session.data) return <div className="callout">请先登录，再创建项目。</div>;
  if (readCreationDraft(session.data.id)?.createAttempted) return <Navigate to="/app/projects/new/wizard" replace />;
  return <NewProjectChoice key={session.data.id} userId={session.data.id} />;
}
function NewProjectChoice({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lock = useRef(false);
  const mounted = useRef(true);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { mounted.current = true; controller.current = new AbortController(); return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  const catalog = useQuery({ queryKey: ['project-templates'], queryFn: ({ signal }) => projectTemplateApi.catalog(signal), enabled: templatesOpen });
  const drafts = useQuery({ queryKey: ['creation-drafts', userId], queryFn: () => api.get<'CreationDraftListResponse'>('/api/v1/creation-drafts'), retry: false });
  async function openBlank() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setError(null);
    try { const draft = await projectTemplateApi.create(userId, controller.current?.signal); if (mounted.current) navigate(`/app/projects/new/template/${encodeURIComponent(draft.id)}`); }
    catch (reason) { if (mounted.current) setError(reason); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  return <div className="page-stack template-entry-page">
    <Link className="back-link" to="/app"><ArrowLeft size={16} />返回项目列表</Link>
    <PageHeading title="新建项目" detail="可以按步骤配置，也可以从模板进入项目预览，编辑后再创建。" />
    <div className="creation-mode-grid">
      <section className="card creation-mode-card"><ListChecks size={26} /><h2>分步创建</h2><p>沿用现有向导，依次配置项目信息、文件、成员与任务预览。</p><Link className="button button-primary" to="/app/projects/new/wizard">分步创建</Link></section>
      <section className="card creation-mode-card"><LayoutTemplate size={26} /><h2>选择模板</h2><p>打开一个项目形式的私有草稿，在各分区编辑，再统一保存为正式项目。</p><button className="button button-quiet" onClick={() => setTemplatesOpen(true)}>选择模板</button></section>
    </div>
    {templatesOpen && <section className="card template-catalog" aria-label="项目模板"><h2>项目模板</h2>{catalog.isLoading && <Spinner label="读取项目模板" />}{catalog.error && <ErrorNotice error={catalog.error} onRetry={() => void catalog.refetch()} />}{catalog.data?.items.filter(template => template.templateId === 'blank').map(template => <article className="template-tile" key={template.templateId}><h3>{template.name}</h3><p>{template.description}</p><button className="button button-primary" disabled={busy} onClick={() => void openBlank()}>{busy ? '正在打开私有草稿' : '使用空项目模板'}</button></article>)}{catalog.data?.items.length === 0 && <EmptyState title="暂无可用模板" detail="可以继续使用分步创建。" />}{error !== null && <ErrorNotice error={error} />}</section>}
    {drafts.error && <ErrorNotice error={drafts.error} onRetry={() => void drafts.refetch()} />}
    {Boolean(drafts.data?.items.length) && <section className="card template-resume-drafts"><h2>继续已有草稿</h2>{drafts.data?.items.map(draft => <Link key={draft.id} className="template-resume-row" to={isTemplatePayload(draft.payload) ? `/app/projects/new/template/${encodeURIComponent(draft.id)}` : `/app/projects/new/wizard?draftId=${encodeURIComponent(draft.id)}`}><strong>{draft.payload.name}</strong><span>{isTemplatePayload(draft.payload) ? '模板预览' : '分步创建'} · {draft.status === 'cancelled' ? '已取消，可恢复' : draft.status === 'committed' ? '已创建，可恢复结果' : '私有草稿'}</span></Link>)}</section>}
  </div>;
}
