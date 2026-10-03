import { DateInput } from '../components/DateInput';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { ApiError, api, projectPath } from '../api/client';
import { useCapabilities, useSession } from '../auth';
import { ErrorNotice, Field, PageHeading, Spinner } from '../components/ui';
import { confirmPage } from '../dialogs/dialog-service';
import { createIntentKey } from './source-workflows';
import {
  clearCreationDraft, completeCreationFile, creationFileExtensions, creationFileLimit, newCreationFile,
  readCreationDraft, validateCreationFiles, writeCreationDraft, type CreationDraft, type CreationFile,
} from './project-creation-workflow';

export function LegacyCreateProjectPage() {
  const session = useSession();
  if (session.isLoading) return <Spinner label="正在确认创建账户" />;
  if (session.error) return <ErrorNotice error={session.error} onRetry={() => void session.refetch()} />;
  if (!session.data) return <div className="callout">请先登录，再创建项目。</div>;
  return <ProjectCreationForm key={session.data.id} userId={session.data.id} />;
}

function ProjectCreationForm({ userId }: { userId: string }) {
  const [restored] = useState(() => readCreationDraft(userId));
  const [draft, setDraft] = useState<CreationDraft | null>(restored);
  const draftRef = useRef(draft);
  const [name, setName] = useState(restored?.payload.name ?? '');
  const [description, setDescription] = useState(restored?.payload.description ?? '');
  const [deadlineDate, setDeadlineDate] = useState(restored?.payload.deadlineDate ?? '');
  const [aiCollaborationEnabled, setAiCollaborationEnabled] = useState(restored?.payload.aiCollaborationEnabled ?? false);
  const [files, setFiles] = useState<CreationFile[]>(restored?.files ?? []);
  const originals = useRef(new Map<string, File>());
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const stopped = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState<unknown>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [archiveConflict, setArchiveConflict] = useState(false);
  const [finished, setFinished] = useState(false);
  const capabilities = useCapabilities();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const projectId = draft?.project?.id;
  const projectQuery = useQuery({ queryKey: ['project', projectId], queryFn: () => api.get<'ProjectResponse'>(projectPath(projectId!)), enabled: Boolean(projectId), retry: false });
  const frozen = Boolean(draft?.createAttempted);

  const commit = useCallback((next: CreationDraft) => {
    draftRef.current = next;
    const saved = writeCreationDraft(next);
    if (mounted.current) { setDraft(next); setFiles(next.files); if (!saved) setStorageUnavailable(true); }
  }, []);
  const interrupt = useCallback(() => {
    stopped.current = true;
    if (draftRef.current) commit({ ...draftRef.current, interrupted: true });
  }, [commit]);

  // The in-flight request is allowed to report its real result. No further writes start after leaving.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopped.current = true;
      if (pendingRef.current && draftRef.current) writeCreationDraft({ ...draftRef.current, interrupted: true });
    };
  }, []);
  useEffect(() => {
    if (!pending) return;
    const unload = (event: BeforeUnloadEvent) => {
      if (draftRef.current) writeCreationDraft({ ...draftRef.current, interrupted: true });
      event.preventDefault(); event.returnValue = '';
    };
    const pageHide = () => interrupt();
    window.addEventListener('beforeunload', unload); window.addEventListener('pagehide', pageHide);
    return () => { window.removeEventListener('beforeunload', unload); window.removeEventListener('pagehide', pageHide); };
  }, [pending, interrupt]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => pendingRef.current && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    const controller = new AbortController();
    void confirmPage('创建或上传尚未完成。离开会停止后续操作；已发出的请求可能已成功，项目与进度会保留。确定离开吗？', { signal: controller.signal, cancelOnBack: false }).then(confirmed => {
      if (controller.signal.aborted) return;
      if (confirmed) { interrupt(); blocker.proceed(); } else blocker.reset();
    });
    return () => controller.abort();
  }, [blocker, interrupt]);

  const selectFiles = (selected: FileList | null) => {
    if (!selected || pendingRef.current) return;
    const chosen = Array.from(selected);
    const limit = capabilities.data?.limits.maxFileBytes;
    const validation = limit ? validateCreationFiles(chosen, limit) : '请先读取后端文件大小限制，再选择文件。';
    if (validation) { setSelectionError(validation); return; }
    if (frozen) {
      let matched = 0;
      const updated = files.map(file => {
        if (file.sourceId || file.uploadConfirmed) return file;
        const original = chosen.find(candidate => candidate.name === file.name && candidate.size === file.size);
        if (!original) return file;
        originals.current.set(file.localId, original); matched += 1;
        return { ...file, status: 'pending' as const, error: undefined };
      });
      setSelectionError(matched ? null : '没有匹配的未完成原文件，请核对文件名与大小。');
      if (draftRef.current) commit({ ...draftRef.current, files: updated });
      return;
    }
    const additions = chosen.filter(original => !files.some(file => file.name === original.name && file.size === original.size && file.lastModified === original.lastModified));
    const all = [...files, ...additions.map(newCreationFile)];
    const totalValidation = validateCreationFiles(all, limit!);
    if (totalValidation) { setSelectionError(totalValidation); return; }
    additions.forEach((original, index) => originals.current.set(all[files.length + index].localId, original));
    setFiles(all); setSelectionError(null);
  };

  const run = async () => {
    if (pendingRef.current || finished || !name.trim()) return;
    const existing = draftRef.current;
    const remainingUploads = files.filter(file => !file.uploadConfirmed && !file.sourceId);
    if (remainingUploads.length) {
      const validation = validateCreationFiles(remainingUploads, capabilities.data?.limits.maxFileBytes ?? 0);
      if (validation) { setSelectionError(validation); return; }
    }
    pendingRef.current = true; stopped.current = false; setPending(true); setError(null); setSelectionError(null);
    commit(existing ? { ...existing, interrupted: false } : {
      version: 1, userId, createKey: createIntentKey(), createAttempted: true, interrupted: false, project: null, files,
      payload: { name: name.trim(), description: description.trim(), aiCollaborationEnabled,
        ...(deadlineDate ? { deadlineDate, deadlinePrecision: 'date' as const } : { deadlinePrecision: 'unknown' as const }) },
    });
    try {
      if (!draftRef.current!.project) {
        const project = await api.post<'ProjectResponse'>('/api/v1/projects', draftRef.current!.payload, { idempotencyKey: draftRef.current!.createKey });
        if (typeof project.id !== 'string' || !project.id || typeof project.name !== 'string' || !Number.isInteger(project.revision) || project.myRole !== 'owner') throw new Error('创建响应尚未确认，请用原请求重试核对项目。');
        commit({ ...draftRef.current!, project: { id: project.id, name: project.name, revision: project.revision, status: project.status }, interrupted: stopped.current });
        if (mounted.current) { queryClient.setQueryData(['project', project.id], project); void queryClient.invalidateQueries({ queryKey: ['projects'] }); }
      }
      // A replayed creation response can describe an older revision. Recheck access before uploads.
      if (!stopped.current && (existing?.project || draftRef.current!.files.length)) {
        const current = await api.get<'ProjectResponse'>(projectPath(draftRef.current!.project!.id));
        if (mounted.current) queryClient.setQueryData(['project', current.id], current);
        if (current.id !== draftRef.current!.project!.id || current.status !== 'active' || current.myRole !== 'owner') throw new Error('项目已归档或负责人权限已变化。请先进入已创建项目核对状态，未继续上传。');
      }
      if (stopped.current) return;
      const id = draftRef.current!.project!.id;
      for (const selected of draftRef.current!.files) {
        if (stopped.current) break;
        if (selected.sourceId) continue;
        const updateFile = (updated: CreationFile) => commit({ ...draftRef.current!, files: draftRef.current!.files.map(file => file.localId === updated.localId ? updated : file), interrupted: stopped.current });
        try {
          await completeCreationFile(id, selected, originals.current.get(selected.localId), updateFile, () => stopped.current);
        } catch (failure) {
          const latest = draftRef.current!.files.find(file => file.localId === selected.localId)!;
          updateFile({ ...latest, status: originals.current.has(selected.localId) || latest.uploadConfirmed ? 'failed' : 'needs_file', error: failure instanceof Error ? failure.message : '上传未完成，请重试。' });
        }
      }
      if (!stopped.current && draftRef.current!.files.every(file => Boolean(file.sourceId))) {
        clearCreationDraft(userId);
        pendingRef.current = false;
        if (mounted.current) {
          if (draftRef.current!.payload.aiCollaborationEnabled && draftRef.current!.files.length) setFinished(true);
          else navigate(`/app/projects/${id}${draftRef.current!.files.length ? '/sources' : ''}`);
        }
      }
    } catch (failure) { if (mounted.current) setError(failure); }
    finally {
      pendingRef.current = false;
      if (stopped.current && draftRef.current) commit({ ...draftRef.current, interrupted: true });
      if (mounted.current) setPending(false);
    }
  };

  const enterProject = async (skipRemaining = false) => {
    if (!projectId || pendingRef.current) return;
    pendingRef.current = true; stopped.current = false; setPending(true); setError(null);
    try {
      const current = await api.get<'ProjectResponse'>(projectPath(projectId));
      if (current.id !== projectId || !['owner', 'member'].includes(current.myRole)) throw new Error('无法确认当前账户对该项目的访问权限。');
      if (mounted.current) queryClient.setQueryData(['project', projectId], current);
      if (mounted.current && !stopped.current) {
        if (skipRemaining) clearCreationDraft(userId);
        pendingRef.current = false; navigate(`/app/projects/${projectId}`);
      }
    } catch (failure) { if (mounted.current) setError(failure); }
    finally { pendingRef.current = false; if (mounted.current) setPending(false); }
  };
  const archive = async () => {
    const current = draftRef.current?.project;
    if (!current || pendingRef.current || projectQuery.data?.myRole !== 'owner' || archiveConflict) return;
    pendingRef.current = true; setPending(true); setError(null);
    try {
      const archived = await api.patch<'ProjectResponse'>(projectPath(current.id), { expectedRevision: current.revision, status: 'archived' });
      if (mounted.current) { queryClient.setQueryData(['project', current.id], archived); void queryClient.invalidateQueries({ queryKey: ['projects'] }); }
      clearCreationDraft(userId);
      pendingRef.current = false;
      if (mounted.current) navigate('/app');
    } catch (failure) {
      if (mounted.current) { setError(failure); if (failure instanceof ApiError && failure.code === 'VERSION_CONFLICT') setArchiveConflict(true); }
    } finally { pendingRef.current = false; if (mounted.current) setPending(false); }
  };

  return <div className="page-stack narrow-page">
    <Link className="back-link" to="/app"><ArrowLeft size={16} />返回项目列表</Link>
    <PageHeading eyebrow="新建项目" title="建立协作空间" detail="项目由真实账户创建，创建者将成为负责人。" />
    <form className="card form-card" aria-label="新建项目" onSubmit={event => { event.preventDefault(); void run(); }}>
      <Field label="项目名称"><input className="input" required maxLength={100} disabled={frozen || pending} value={name} onChange={event => setName(event.target.value)} placeholder="例如：校园创新项目" /></Field>
      <Field label="项目说明" hint="可描述目标、背景或团队约定。"><textarea className="input textarea" maxLength={2000} rows={4} disabled={frozen || pending} value={description} onChange={event => setDescription(event.target.value)} placeholder="写下团队需要共同推进的目标……" /></Field>
      <Field label="截止日期" hint="仅填写通知中明确给出的日期；当前页面不录入具体时刻。"><DateInput className="input" type="date" disabled={frozen || pending} value={deadlineDate} onChange={event => setDeadlineDate(event.target.value)} /></Field>

      <label className="field"><span className="field-label"><input type="checkbox" checked={aiCollaborationEnabled} disabled={frozen || pending} onChange={event => setAiCollaborationEnabled(event.target.checked)} /> AI 智能协作</span><small>默认关闭。开启后启用本项目的自动任务分配与提交后的 AI 评价；受现有模型配置、可用性和预算限制，可能产生 AI 用量。上传只保存原文件并建立来源，不会自动解析或调用模型；可到“通知与来源”另行处理。</small></label>
      {aiCollaborationEnabled && !capabilities.data?.features.aiEnabled && <div className="form-note">{capabilities.data ? '系统 AI 当前未启用。项目开关可保存，但模型不可用时不会执行 AI 协作。' : '正在确认系统 AI 能力；开关不代表模型已可用。'}</div>}
      {capabilities.error && <ErrorNotice error={capabilities.error} onRetry={() => void capabilities.refetch()} />}
      <Field label={frozen ? '重新选择未完成的原文件' : '项目文件（可选）'} hint={`最多 ${creationFileLimit} 个文件；支持 PDF、PNG、JPG、WebP、TXT、Markdown。${capabilities.data ? `每个不超过 ${(capabilities.data.limits.maxFileBytes / (1024 * 1024)).toFixed(1)} MiB。` : '正在读取单文件大小限制。'} 原文件只存入本项目私有存储。`}><input className="input" type="file" multiple accept={creationFileExtensions} disabled={pending || !capabilities.data || (frozen && files.every(file => Boolean(file.sourceId) || file.uploadConfirmed))} onChange={event => { selectFiles(event.target.files); event.target.value = ''; }} /></Field>
      {selectionError && <div className="notice notice-error" role="alert">{selectionError}</div>}
      {files.length > 0 && <ul className="page-stack" aria-label="文件上传进度">{files.map(file => <li key={file.localId}>
        <strong>{file.name}</strong> · {(file.size / 1024).toFixed(1)} KiB · {file.sourceId ? '已保存原文件并建立来源' : pending && file.status === 'uploading' ? '正在上传或核对原文件' : pending && file.status === 'linking' ? '正在建立来源' : file.uploadConfirmed ? '原文件已上传，来源尚未确认' : file.status === 'failed' ? '上传未完成' : file.status === 'needs_file' ? '需要重新选择原文件' : '等待上传'}
        {file.error && <div role="status">{file.error}</div>}
        {!frozen && <button className="button button-quiet button-small" type="button" disabled={pending} aria-label={`移除 ${file.name}`} onClick={() => { originals.current.delete(file.localId); setFiles(items => items.filter(item => item.localId !== file.localId)); }}>移除</button>}
      </li>)}</ul>}
      {storageUnavailable && <div className="notice notice-warn" role="alert">此浏览器无法保存恢复进度。离开或刷新可能丢失本次重试信息，请等创建结果确认后保留项目链接。</div>}
      {draft?.interrupted && <div className="notice notice-warn" role="status">{pending ? '已请求停止后续操作，正在确认已发出的请求。' : '本次创建或上传已中断。'} 已创建项目和已完成文件会保留。刷新后未完成原文件需重新选择；重试沿用同一创建记录，不会另建项目。</div>}
      {frozen && !projectId && <div className="form-note">创建请求已发出，服务端结果尚未确认。表单已保留，请用原请求重试确认；不要另建同名项目。</div>}
      {projectId && <section className="callout" aria-label="已创建项目"><strong>项目已创建：{draft?.project?.name}</strong><p>项目编号：{projectId}。上传失败不会撤销或删除项目，已保存的文件不会重复上传。</p><Link to={`/app/projects/${projectId}`}>查看已创建项目</Link>
        {projectQuery.error && <ErrorNotice error={projectQuery.error} onRetry={() => void projectQuery.refetch()} />}
        {projectQuery.data?.status === 'archived' && <p>此项目已归档，暂停上传；可进入项目核对。</p>}
        {projectQuery.data && projectQuery.data.myRole !== 'owner' && <p>负责人权限已变化，暂停本创建流程；可进入项目核对。</p>}
      </section>}
      {projectId && aiCollaborationEnabled && files.some(file => Boolean(file.sourceId)) && <section className="callout" aria-label="AI 协作资料下一步">
        {finished && <strong>项目文件已保存并建立来源</strong>}
        <p>资料原文件已保存，AI 协作仍待正文读取；请到协作任务选择并处理来源，再发起基于资料的拆解。</p>
        <Link to={`/app/projects/${projectId}/tasks`}>选择来源并准备协作任务</Link> · <Link to={`/app/projects/${projectId}/sources`}>查看通知与来源</Link>
      </section>}
      {Boolean(error) && <ErrorNotice error={error} />}
      {archiveConflict && <div className="notice notice-warn">项目已被更新，归档未执行。请先进入项目核对当前状态；此页面不会自动覆盖新版本。</div>}
      <div className="form-actions">
        <button type="button" className="button button-quiet" disabled={pending && Boolean(draft?.interrupted)} onClick={() => { if (pendingRef.current) interrupt(); else { if (draftRef.current && !finished) commit({ ...draftRef.current, interrupted: true }); navigate('/app'); } }}>{pending ? '停止后续操作' : projectId ? finished ? '返回项目列表' : '保留进度并返回列表' : '取消'}</button>
        <button type="submit" className="button button-primary" disabled={finished || pending || !name.trim() || Boolean(projectId && (!projectQuery.data || projectQuery.data.status !== 'active' || projectQuery.data.myRole !== 'owner'))}>{pending ? '正在确认进度…' : finished ? '文件已保存' : projectId ? '重试未完成文件' : frozen ? '用原请求重试确认创建' : '创建项目'}</button>
        {projectId && <button type="button" className="button button-quiet" disabled={pending} onClick={() => void enterProject()}>保留进度并进入项目</button>}
        {projectId && !finished && files.some(file => !file.sourceId) && <button type="button" className="button button-quiet" disabled={pending} onClick={() => void enterProject(true)}>跳过未完成文件并进入项目</button>}
        {projectId && <button type="button" className="button button-danger" disabled={pending || archiveConflict || projectQuery.data?.myRole !== 'owner' || projectQuery.data?.status !== 'active'} onClick={() => void archive()}>归档此项目草稿</button>}
      </div>


    </form>
  </div>;
}
