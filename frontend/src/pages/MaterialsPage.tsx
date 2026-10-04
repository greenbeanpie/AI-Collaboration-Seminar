import { usePageDialogs } from '../dialogs/usePageDialogs';
import { MaterialAttachments } from './MaterialAttachments';
import { MaterialAiAssistance } from './MaterialAiAssistance';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DropdownMenu } from '../components/DropdownMenu';
import { EditorContent, useEditor } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { TableKit } from '@tiptap/extension-table';
import { AlertTriangle, Bold, Download, Heading2, Heading3, Italic, Link2, List, ListOrdered, MessageCircle, History, Plus, Printer, Table2, WifiOff } from 'lucide-react';
import { api, ApiError, projectPath } from '../api/client';
import type { DataOf } from '../api/types';
import { useProject } from '../components/ProjectShell';
import { useSession } from '../auth';
import { EmptyState, ErrorNotice, PageHeading, Spinner, Modal } from '../components/ui';
import { getDraft, removeDraft, saveDraft } from '../storage';
import { CommentsPanel, docToMarkdown, loadCursorPages, MaterialDocumentView } from './TasksMaterialsShared';
import { useSettingsDirty } from './settings-dirty';
import './TasksMaterials.css';

type Material = DataOf<'MaterialResponse'>;
type MaterialSummary = DataOf<'MaterialListResponse'>['items'][number];
type MaterialVersionSummary = DataOf<'MaterialVersionListResponse'>['items'][number];
type LocalDraft = {
  doc: Record<string, unknown>;
  baseRevision: number;
  needsReconnectConfirmation: boolean;
};
type ConflictCopy = {
  server: Material;
  localDoc: Record<string, unknown>;
  reviewed: boolean;
};

const emptyDoc: Record<string, unknown> = { type: 'doc', content: [{ type: 'paragraph' }] };
const materialExtensions = [
  StarterKit.configure({
    link: false,
    blockquote: false,
    code: false,
    codeBlock: false,
    horizontalRule: false,
    strike: false,
    underline: false,
  }),
  Link.configure({ openOnClick: false, autolink: true }),
  TableKit.configure({ table: { resizable: false } }),
];

function isTiptapDocument(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null &&
    (value as { type?: unknown }).type === 'doc' &&
    Array.isArray((value as { content?: unknown }).content);
}

function isLocalDraft(value: unknown): value is LocalDraft {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<LocalDraft>;
  return isTiptapDocument(candidate.doc) && Number.isInteger(candidate.baseRevision) && Number(candidate.baseRevision) >= 1;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function downloadMarkdown(title: string, markdown: string) {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${title.trim().replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || '项目材料'}.md`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function MaterialsPage({ initialAiOpen = false, embedded = false, materialId: requestedMaterialId, versionId: requestedVersionId, header }: { header?: ReactNode; initialAiOpen?: boolean; embedded?: boolean; materialId?: string; versionId?: string | null }) {
  const { projectId } = useProject();
  const session = useSession();
  const queryClient = useQueryClient();
  const accountId = session.data?.id ?? '';
  const [online, setOnline] = useState(() => navigator.onLine);
  const [activeMaterialId, setActiveMaterialId] = useState<string | null>(requestedMaterialId ?? null);
  const dialogs = usePageDialogs(`${accountId}:${projectId}:${activeMaterialId ?? ""}`);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<'discussion' | 'history' | null>(requestedVersionId ? 'history' : null);
  useEffect(() => { if (requestedVersionId) { setSelectedVersionId(requestedVersionId); setOverlay('history'); } }, [requestedVersionId]);
  const [newTitle, setNewTitle] = useState('');
  const [newKind, setNewKind] = useState('document');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useSettingsDirty(dirty);
  const [draftPersisted, setDraftPersisted] = useState(true);
  const [draftStorageWarning, setDraftStorageWarning] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [editNotice, setEditNotice] = useState('');
  const [recoveryDraft, setRecoveryDraft] = useState<{ draft: LocalDraft; savedAt: string } | null>(null);
  const [reconnectConfirmation, setReconnectConfirmation] = useState(false);
  const [conflict, setConflict] = useState<ConflictCopy | null>(null);
  const [printDoc, setPrintDoc] = useState<Record<string, unknown>>(emptyDoc);
  const activeMaterialIdRef = useRef<string | null>(activeMaterialId);
  const accountIdRef = useRef(accountId);
  const currentRevisionRef = useRef(1);
  const baseRevisionRef = useRef(1);
  const lastHydratedMaterialIdRef = useRef<string | null>(null);
  const lastServerRevisionRef = useRef<number | null>(null);
  const hydratingRef = useRef(false);
  const needsReconnectConfirmationRef = useRef(false);
  activeMaterialIdRef.current = activeMaterialId;
  accountIdRef.current = accountId;

  const editor = useEditor({
    extensions: materialExtensions,
    content: emptyDoc,
    editable: false,
    immediatelyRender: false,
    editorProps: { attributes: { 'aria-label': '材料正文编辑器', class: 'tm-tiptap-editor' } },
    onUpdate: ({ editor: currentEditor }) => {
      const materialId = activeMaterialIdRef.current;
      const currentAccountId = accountIdRef.current;
      if (!materialId || !currentAccountId || hydratingRef.current) return;
      const doc = currentEditor.getJSON() as Record<string, unknown>;
      if (!navigator.onLine) needsReconnectConfirmationRef.current = true;
      const draft: LocalDraft = {
        doc,
        baseRevision: baseRevisionRef.current,
        needsReconnectConfirmation: needsReconnectConfirmationRef.current,
      };
      const saved = saveDraft(currentAccountId, projectId, materialId, draft);
      setDraftPersisted(saved);
      setDraftStorageWarning(false);
      setDirty(true);
      setSaveError(null);
    },
  });

  const materialsQuery = useQuery({
    queryKey: ['materials', projectId],
    queryFn: () => loadCursorPages<MaterialSummary>((cursor) => api.get<'MaterialListResponse'>(
      projectPath(projectId, '/materials'),
      { cursor, limit: 100 },
    )),
  });
  const materialQuery = useQuery({
    queryKey: ['material', projectId, activeMaterialId],
    enabled: Boolean(activeMaterialId),
    queryFn: () => api.get<'MaterialResponse'>(projectPath(projectId, `/materials/${encodeURIComponent(activeMaterialId!)}`)),
  });
  const historyQuery = useQuery({
    queryKey: ['materialVersions', projectId, activeMaterialId],
    enabled: Boolean(activeMaterialId),
    queryFn: () => loadCursorPages<MaterialVersionSummary>((cursor) => api.get<'MaterialVersionListResponse'>(
      projectPath(projectId, `/materials/${encodeURIComponent(activeMaterialId!)}/versions`),
      { cursor, limit: 100 },
    )),
  });
  const versionQuery = useQuery({
    queryKey: ['materialVersion', projectId, activeMaterialId, selectedVersionId],
    enabled: Boolean(activeMaterialId && selectedVersionId),
    queryFn: () => api.get<'MaterialVersionResponse'>(projectPath(projectId, `/materials/${encodeURIComponent(activeMaterialId!)}/versions/${encodeURIComponent(selectedVersionId!)}`)),
  });
  const orderedVersions = [...(historyQuery.data ?? [])].sort((a, b) => b.revision - a.revision);
  const currentHistoryPage = orderedVersions.findIndex(version => version.versionId === selectedVersionId);
  const historyPageCount = orderedVersions.length;
  const selectHistoryPage = (index: number) => setSelectedVersionId(orderedVersions[index]?.versionId ?? null);
  const openHistory = () => { if (!selectedVersionId) selectHistoryPage(0); setOverlay('history'); };
  useEffect(() => {
    if (overlay === 'history' && !selectedVersionId && orderedVersions[0]) setSelectedVersionId(orderedVersions[0].versionId);
  }, [overlay, selectedVersionId, orderedVersions]);
  const material = materialQuery.data;
  const latestMaterial = useRef(material); latestMaterial.current = material;

  const createMaterial = useMutation({
    mutationFn: (title: string) => api.post<'MaterialResponse'>(projectPath(projectId, '/materials'), { title: title.trim(), kind: newKind }),
    onSuccess: async (created) => {
      setNewTitle('');
      setSelectedVersionId(null);
      setConflict(null);
      setActiveMaterialId(created.materialId);
      await queryClient.invalidateQueries({ queryKey: ['materials', projectId] });
    },
  });

  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      if (needsReconnectConfirmationRef.current) setReconnectConfirmation(true);
    };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    if (!activeMaterialId && materialsQuery.data?.length) setActiveMaterialId(materialsQuery.data[0]!.materialId);
  }, [activeMaterialId, materialsQuery.data]);

  useEffect(() => {
    if (!editor || !material || material.materialId !== activeMaterialId) return;
    const isNewMaterial = lastHydratedMaterialIdRef.current !== material.materialId;
    if (!isNewMaterial && lastServerRevisionRef.current === material.revision) return;
    lastServerRevisionRef.current = material.revision;
    currentRevisionRef.current = material.revision;
    if (!isNewMaterial) {
      if (!dirty && !recoveryDraft && !conflict) {
        baseRevisionRef.current = material.revision;
        hydratingRef.current = true;
        editor.commands.setContent(material.currentVersion?.doc ?? emptyDoc, { emitUpdate: false });
        hydratingRef.current = false;
      }
      return;
    }
    lastHydratedMaterialIdRef.current = material.materialId;
    baseRevisionRef.current = material.revision;
    hydratingRef.current = true;
    editor.commands.setContent(material.currentVersion?.doc ?? emptyDoc, { emitUpdate: false });
    hydratingRef.current = false;
    setDirty(false);
    setDraftPersisted(true);
    setDraftStorageWarning(false);
    setConflict(null);
    setSaveError(null);
    setSelectedVersionId(requestedVersionId ?? null);
    const storedDraft = accountId ? getDraft<unknown>(accountId, projectId, material.materialId) : null;
    if (storedDraft && isLocalDraft(storedDraft.value)) {
      setDraftPersisted(true);
      needsReconnectConfirmationRef.current = storedDraft.value.needsReconnectConfirmation === true;
      setRecoveryDraft({ draft: storedDraft.value, savedAt: storedDraft.savedAt });
      setReconnectConfirmation(navigator.onLine && needsReconnectConfirmationRef.current);
    } else {
      setDraftPersisted(true);
      needsReconnectConfirmationRef.current = false;
      setRecoveryDraft(null);
      setReconnectConfirmation(false);
    }
  }, [accountId, activeMaterialId, conflict, dirty, editor, material, projectId, recoveryDraft, requestedVersionId]);

  useEffect(() => {
    if (!editor) return;
    const detailReady = material?.materialId === activeMaterialId;
    // Editable-state changes do not modify the document or create a local draft.
    editor.setEditable(Boolean(material && material.canEdit !== false && detailReady && !saving && !conflict && !recoveryDraft), false);
  }, [activeMaterialId, conflict, editor, material, recoveryDraft, saving]);

  const selectMaterial = async (materialId: string) => {
    const leavingDraftMessage = draftPersisted
      ? '当前材料有未保存的编辑，已写入本机草稿。切换材料？'
      : '浏览器未能写入本机草稿；切换后当前编辑可能丢失。仍要切换材料吗？';
    if (dirty && activeMaterialId !== materialId && !await dialogs.confirm(leavingDraftMessage)) return;
    setActiveMaterialId(materialId);
    setSelectedVersionId(null);
    setOverlay(null);
    setConflict(null);
    setSaveError(null);
  };

  const restoreDraft = () => {
    if (!editor || !recoveryDraft) return;
    baseRevisionRef.current = recoveryDraft.draft.baseRevision;
    needsReconnectConfirmationRef.current = recoveryDraft.draft.needsReconnectConfirmation;
    hydratingRef.current = true;
    editor.commands.setContent(recoveryDraft.draft.doc, { emitUpdate: false });
    hydratingRef.current = false;
    setRecoveryDraft(null);
    setDirty(true);
    setDraftPersisted(true);
    if (online && needsReconnectConfirmationRef.current) setReconnectConfirmation(true);
  };

  const discardDraft = async () => {
    if (!activeMaterialId || !accountId) return;
    if (!await dialogs.confirm('确定放弃这份本机草稿吗？此操作不会修改服务端版本。')) return;
    if (accountIdRef.current !== accountId || activeMaterialIdRef.current !== activeMaterialId) return;
    const current = latestMaterial.current;
    const removed = removeDraft(accountId, projectId, activeMaterialId);
    setDraftPersisted(removed);
    setDraftStorageWarning(!removed);
    needsReconnectConfirmationRef.current = false;
    baseRevisionRef.current = currentRevisionRef.current;
    if (editor && !editor.isDestroyed && current?.materialId === activeMaterialId) {
      hydratingRef.current = true;
      editor.commands.setContent(current.currentVersion?.doc ?? emptyDoc, { emitUpdate: false });
      hydratingRef.current = false;
    }
    setRecoveryDraft(null);
    setReconnectConfirmation(false);
    setDirty(false);
  };

  const saveMaterial = async (expectedRevision = baseRevisionRef.current, docOverride?: Record<string, unknown>) => {
    if (!editor || !material || material.canEdit === false || material.materialId !== activeMaterialId || !activeMaterialId || !accountId || saving) return;
    const doc = docOverride ?? editor.getJSON() as Record<string, unknown>;
    const markdown = docToMarkdown(doc);
    if (online && needsReconnectConfirmationRef.current) {
      if (!await dialogs.confirm('这份材料包含离线期间编辑的内容。确认后会将该本机草稿保存为新的服务端版本。')) return;
      if (accountIdRef.current !== accountId || activeMaterialIdRef.current !== activeMaterialId || editor.isDestroyed) return;
      needsReconnectConfirmationRef.current = false;
      setReconnectConfirmation(false);
      const saved = saveDraft(accountId, projectId, activeMaterialId, { doc, baseRevision: expectedRevision, needsReconnectConfirmation: false } satisfies LocalDraft);
      setDraftPersisted(saved);
      setDraftStorageWarning(false);
    }
    setSaving(true);
    setSaveError(null);
    // Another tab may have removed the shared draft after saving its own version.
    // Persist this tab's submitted copy again so a conflict or network failure remains recoverable.
    setDraftPersisted(saveDraft(accountId, projectId, activeMaterialId, {
      doc, baseRevision: expectedRevision, needsReconnectConfirmation: false,
    } satisfies LocalDraft));
    setDraftStorageWarning(false);
    try {
      const savedVersion = await api.put<'MaterialVersionResponse'>(
        projectPath(projectId, `/materials/${encodeURIComponent(activeMaterialId)}`),
        { expectedRevision, doc, markdown },
      );
      currentRevisionRef.current = savedVersion.revision;
      baseRevisionRef.current = savedVersion.revision;
      const removedDraft = removeDraft(accountId, projectId, activeMaterialId);
      setDraftPersisted(removedDraft);
      setDraftStorageWarning(!removedDraft);
      setDirty(false);
      setConflict(null);
      setReconnectConfirmation(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['material', projectId, activeMaterialId] }),
        queryClient.invalidateQueries({ queryKey: ['materials', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['materialVersions', projectId, activeMaterialId] }),
        queryClient.invalidateQueries({ queryKey: ['resource-library', projectId] }),
      ]);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === 'VERSION_CONFLICT') {
        try {
          const server = await api.get<'MaterialResponse'>(projectPath(projectId, `/materials/${encodeURIComponent(activeMaterialId)}`));
          setConflict({ server, localDoc: doc, reviewed: false });
          setSaveError(null);
          queryClient.setQueryData(['material', projectId, activeMaterialId], server);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['materials', projectId] }),
            queryClient.invalidateQueries({ queryKey: ['materialVersions', projectId, activeMaterialId] }),
          ]);
        } catch (refreshError) {
          setSaveError(refreshError);
        }
      } else {
        setSaveError(error);
      }
    } finally {
      setSaving(false);
    }
  };

  const serverDoc = material?.currentVersion?.doc ?? emptyDoc;
  const activeVersion = material?.currentVersion?.revision ?? material?.revision ?? 0;

  const printCurrentMaterial = () => {
    setPrintDoc(editor ? editor.getJSON() as Record<string, unknown> : serverDoc);
    window.requestAnimationFrame(() => window.print());
  };

  return (
    <div className={`page-stack tm-page tm-materials-page${embedded ? ' tm-material-embedded' : ''}`}>
      {!embedded && <PageHeading
        eyebrow="成果协作"
        title="成果材料"
        detail="编辑服务端正式材料并查看不可变版本。离线修改会尝试保存为当前账户、项目和材料对应的本机草稿，页面会明确显示写入是否成功。"
      />}


      {materialsQuery.error && <ErrorNotice error={materialsQuery.error} onRetry={() => void materialsQuery.refetch()} />}
      {materialQuery.error && <ErrorNotice error={materialQuery.error} onRetry={() => void materialQuery.refetch()} />}
      {createMaterial.error && <ErrorNotice error={createMaterial.error} />}
      {saveError ? <ErrorNotice error={saveError} onRetry={() => void materialQuery.refetch()} /> : null}
      {!online && <div className="tm-inline-notice"><span className="tm-offline-indicator"><WifiOff size={14} />当前离线</span> 编辑内容保存在本机草稿中；点击“保存到本机，联网同步”后进入同步队列。联网后无冲突自动保存，有冲突时保留两份内容供核对。</div>}
      {draftStorageWarning && !dirty && <div className="tm-inline-notice tm-inline-error" role="status"><AlertTriangle size={14} />服务端操作已完成，但浏览器无法确认旧本机草稿已清理。若刷新后再次提示恢复，请核对服务端版本再处理。</div>}

      <div className="tm-materials-layout">
        {!embedded && <aside className="tm-material-sidebar" aria-label="材料列表">
          <section className="card tm-material-list-card">
            <div className="tm-material-list-head"><h2>项目材料</h2><span className="status-pill status-neutral">{materialsQuery.data?.length ?? '—'}</span></div>
            {materialsQuery.isLoading && <Spinner label="正在读取材料" />}
            {!!materialsQuery.data?.length && <div className="tm-material-list">
              {materialsQuery.data.map((item) => <button key={item.materialId} className={`tm-material-list-item ${activeMaterialId === item.materialId ? 'active' : ''}`} onClick={() => selectMaterial(item.materialId)} aria-current={activeMaterialId === item.materialId ? 'page' : undefined}>
                <strong>{item.title}</strong><span>{item.currentVersionId ? `当前版本 r${item.revision}` : '尚无正文版本'} · {formatDate(item.updatedAt)}</span>
              </button>)}
            </div>}
            {!materialsQuery.isLoading && !materialsQuery.error && !materialsQuery.data?.length && <EmptyState title="还没有材料" detail="创建一份材料后开始协作编辑。" />}
            <select className="input" aria-label="材料模板" value={newKind} onChange={e => setNewKind(e.target.value)}><option value="document">空白材料</option><option value="work-introduction">作品介绍模板</option></select>
            <form className="tm-create-material" onSubmit={(event) => { event.preventDefault(); if (newTitle.trim()) createMaterial.mutate(newTitle); }}>
              <label className="tm-sr-only" htmlFor="new-material-title">材料标题</label>
              <input id="new-material-title" maxLength={200} value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="新材料名称" />
              <button className="button button-primary button-small" type="submit" disabled={!newTitle.trim() || createMaterial.isPending}><Plus size={14} />{createMaterial.isPending ? '创建中' : '创建'}</button>
            </form>
          </section>

        </aside>}

        <main className="tm-material-main">
          {!activeMaterialId && <section className="card"><EmptyState title="选择或创建一份材料" detail="材料正文和版本历史由当前项目服务提供。" /></section>}
          {activeMaterialId && materialQuery.isLoading && <section className="card"><Spinner label="正在读取材料正文" /></section>}
          {activeMaterialId && !materialQuery.isLoading && materialQuery.error && <section className="card"><ErrorNotice error={materialQuery.error} onRetry={() => void materialQuery.refetch()} /></section>}
          {material && material.materialId === activeMaterialId && <>
            {recoveryDraft && <div className="tm-draft-recovery" role="status">
              <div><strong>发现本机未同步草稿</strong><span>本机保存于 {formatDate(recoveryDraft.savedAt)}。恢复会保留服务端正文供后续比较。</span></div>
              <div className="tm-editor-actions"><button className="button button-primary button-small" onClick={restoreDraft}>恢复草稿</button><button className="button button-quiet button-small" onClick={discardDraft}>放弃草稿</button></div>
            </div>}
            {reconnectConfirmation && !recoveryDraft && <div className="tm-inline-notice" role="status"><span className="tm-offline-indicator"><WifiOff size={14} />离线草稿待确认</span> 联网后不会自动保存。点击“保存新版本”后还会再次询问，确认后才会提交。</div>}

            <section className="card tm-editor-card">
              <MaterialAiAssistance key={`${accountId}:${projectId}:${initialAiOpen}`} initiallyOpen={initialAiOpen} renderHeader={trigger => <>
              {header}
              <header className="tm-editor-header">
                <div className="tm-editor-title-wrap">{!header && <h2>{material.title}</h2>}<p>{material.systemManaged ? '系统背景 · 自动同步 · ' : ''}服务端当前版本 r{activeVersion} · {material.currentVersion ? formatDate(material.currentVersion.createdAt) : '初始空版本'}</p>
                  {!online && <span className="tm-offline-indicator"><WifiOff size={13} />{draftPersisted ? '离线草稿已写入本机' : '本机草稿写入失败'}</span>}
                </div>
                <div className="tm-editor-actions tm-hide-print">
                  {!material.systemManaged && trigger}
                  <button type="button" className="button button-quiet button-small" onClick={() => setOverlay('discussion')}><MessageCircle size={14} />讨论</button>
                  <button type="button" className="button button-quiet button-small" onClick={openHistory}><History size={14} />版本历史</button>
                  <DropdownMenu label="导出文件"><button className="button button-quiet button-small" onClick={() => downloadMarkdown(material.title, docToMarkdown(editor ? editor.getJSON() : serverDoc))} disabled={!editor}><Download size={14} />Markdown</button>
                  <button className="button button-quiet button-small" onClick={printCurrentMaterial}><Printer size={14} />打印 / PDF</button></DropdownMenu>
                  <button style={{ display: material.systemManaged ? 'none' : undefined }} className="button button-primary button-small" onClick={() => void saveMaterial()} disabled={material.canEdit === false || !dirty || saving || Boolean(conflict) || Boolean(recoveryDraft) || !editor}>{saving ? '保存中…' : !online ? '保存到本机，联网同步' : reconnectConfirmation ? '确认并保存新版本' : '保存新版本'}</button>
                </div>
              </header>
              </>} />
              {dirty && !draftPersisted && <div className="tm-inline-notice tm-inline-error" role="alert"><AlertTriangle size={14} />浏览器无法保存本机草稿；当前编辑只留在此页面内存，切换页面或关闭标签后会丢失。请尽快连接服务并保存。</div>}
              {saveError ? <div className="tm-inline-notice"><AlertTriangle size={14} />保存失败，正文仍在编辑器{draftPersisted ? '和本机草稿中' : '内存中；本机草稿写入也未成功'}。修复连接后可以手动重试。</div> : null}
              {editNotice && <p className="tm-inline-notice" role="status">{editNotice}</p>}
              <div style={{ display: material.systemManaged ? 'none' : undefined }} className="tm-editor-toolbar tm-hide-print" role="toolbar" aria-label="材料格式">
                <button type="button" aria-label="粗体" title="粗体" onClick={() => editor?.chain().focus().toggleBold().run()} disabled={material.canEdit === false || !editor || Boolean(recoveryDraft) || Boolean(conflict)}><Bold size={15} /></button>
                <button type="button" aria-label="斜体" title="斜体" onClick={() => editor?.chain().focus().toggleItalic().run()} disabled={material.canEdit === false || !editor || Boolean(recoveryDraft) || Boolean(conflict)}><Italic size={15} /></button>
                <span className="tm-toolbar-divider" />
                <button type="button" aria-label="二级标题" title="二级标题" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} disabled={material.canEdit === false || !editor || Boolean(recoveryDraft) || Boolean(conflict)}><Heading2 size={16} /></button>
                <button type="button" aria-label="三级标题" title="三级标题" onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} disabled={material.canEdit === false || !editor || Boolean(recoveryDraft) || Boolean(conflict)}><Heading3 size={15} /></button>
                <button type="button" aria-label="无序列表" title="无序列表" onClick={() => editor?.chain().focus().toggleBulletList().run()} disabled={material.canEdit === false || !editor || Boolean(recoveryDraft) || Boolean(conflict)}><List size={15} /></button>
                <button type="button" aria-label="有序列表" title="有序列表" onClick={() => editor?.chain().focus().toggleOrderedList().run()} disabled={material.canEdit === false || !editor || Boolean(recoveryDraft) || Boolean(conflict)}><ListOrdered size={15} /></button>
                <span className="tm-toolbar-divider" />
                <button type="button" aria-label="插入表格" title="插入 3 × 3 表格" onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} disabled={material.canEdit === false || !editor || Boolean(recoveryDraft) || Boolean(conflict)}><Table2 size={15} /></button>
                <button type="button" aria-label="设置链接" title="设置链接" onClick={async () => {
                  if (!editor) return;
                  setEditNotice('');
                  const existing = editor.getAttributes('link').href as string | undefined;
                  const selection = { from: editor.state.selection.from, to: editor.state.selection.to };
                  const originalDoc = editor.state.doc;
                  const originalRevision = latestMaterial.current?.revision;
                  const href = await dialogs.prompt('输入完整网址（仅 http、https 或 mailto 链接）', existing ?? 'https://');
                  if (href === null || editor.isDestroyed) return;
                  if (latestMaterial.current?.revision !== originalRevision || !editor.state.doc.eq(originalDoc)) { setEditNotice('材料内容已变化，请重新选择文字后设置链接。'); return; }
                  if (!href.trim()) editor.chain().focus().setTextSelection(selection).unsetLink().run();
                  else editor.chain().focus().setTextSelection(selection).setLink({ href }).run();
                }} disabled={material.canEdit === false || !editor || Boolean(recoveryDraft) || Boolean(conflict)}><Link2 size={15} /></button>
              </div>
              <div className="tm-editor-content">
                {editor && <EditorContent editor={editor} />}
                {!editor && <Spinner label="正在准备编辑器" />}
              </div>
              <>{material.canEdit === false && <p className="form-note">此材料可查看；修改需创建者或资料管理权限。</p>}<MaterialAttachments material={material} disabled={material.canEdit === false || dirty || !online || saving || Boolean(conflict) || Boolean(recoveryDraft)} /></>
              <footer className="tm-editor-footer"><span>{dirty ? '有未同步修改' : '内容与服务端版本一致'}</span><span>标题、段落、列表、表格和链接会随版本保存</span></footer>
            </section>

            {conflict && <section className="tm-conflict-panel" aria-labelledby="tm-conflict-title">
              <h3 id="tm-conflict-title">服务端版本已更新，需要先对照内容</h3>
              <p>本次保存的 expectedRevision 已过期。编辑器中的本地版本保持不变；请检查两份正文后，明确确认再以服务端 r{conflict.server.revision} 为基准重试。</p>
              <div className="tm-conflict-grid">
                <div className="tm-conflict-copy"><h4>本机草稿</h4><MaterialDocumentView doc={conflict.localDoc} className="tm-document-preview" /></div>
                <div className="tm-conflict-copy"><h4>服务端当前版本 r{conflict.server.revision}</h4><MaterialDocumentView doc={conflict.server.currentVersion?.doc ?? emptyDoc} className="tm-document-preview" /></div>
              </div>
              <label className="tm-conflict-confirm"><input type="checkbox" checked={conflict.reviewed} onChange={(event) => setConflict({ ...conflict, reviewed: event.target.checked })} />我已对照本机草稿与服务端版本，确认保留本机内容并以服务端当前 revision 提交。</label>
              <div className="tm-conflict-actions">
                <button className="button button-quiet button-small" onClick={() => { setConflict(null); setSaveError(null); }}>继续编辑本机草稿</button>
                <button className="button button-primary button-small" disabled={material.canEdit === false || !conflict.reviewed || saving || !online} onClick={() => void saveMaterial(conflict.server.revision, conflict.localDoc)}>{saving ? '重试中…' : `按 r${conflict.server.revision} 重试保存`}</button>
              </div>
            </section>}

            <div className="tm-hide-print">
              <Modal title="材料讨论" mode={overlay === 'discussion' ? 'dialog' : 'hidden'} onClose={() => setOverlay(null)}>
                <CommentsPanel projectId={projectId} targetType="material" targetId={material.materialId} presentation="content" />
              </Modal>
              <Modal title="材料版本历史" mode={overlay === 'history' ? 'dialog' : 'hidden'} onClose={() => setOverlay(null)}>
                <section className="stack" aria-label="版本快照">
                  {historyQuery.isLoading && <Spinner label="正在读取版本" />}
                  {historyQuery.error && <ErrorNotice error={historyQuery.error} onRetry={() => void historyQuery.refetch()} />}
                  {!historyQuery.isLoading && !historyQuery.error && !orderedVersions.length && <p>保存正文后会生成新的不可变版本。</p>}
                  {!!orderedVersions.length && <nav className="tm-list-pagination" aria-label="版本历史分页">
                    <button type="button" className="button button-quiet button-small" disabled={currentHistoryPage <= 0} onClick={() => selectHistoryPage(currentHistoryPage - 1)}>上一页</button>
                    <label className="field"><span className="field-label">选择材料版本</span><select className="input" value={selectedVersionId ?? ''} onChange={event => setSelectedVersionId(event.target.value)}>{selectedVersionId && currentHistoryPage < 0 && <option value={selectedVersionId}>指定版本（不在当前列表）</option>}{orderedVersions.map(version => <option key={version.versionId} value={version.versionId}>版本 r{version.revision}{version.revision === activeVersion ? ' · 当前' : ''}</option>)}</select></label>
                    <span aria-live="polite">{currentHistoryPage < 0 ? '指定版本不在当前列表中' : `第 ${currentHistoryPage + 1} / ${historyPageCount} 页`}</span>
                    <button type="button" className="button button-quiet button-small" disabled={currentHistoryPage < 0 || currentHistoryPage >= historyPageCount - 1} onClick={() => selectHistoryPage(currentHistoryPage + 1)}>下一页</button>
                  </nav>}
                  {selectedVersionId && <div className="tm-history-detail">
                    {versionQuery.isLoading && <Spinner label="正在读取版本快照" />}
                    {versionQuery.error && <ErrorNotice error={versionQuery.error} onRetry={() => void versionQuery.refetch()} />}
                    {versionQuery.data && <>
                      <header><strong>不可变快照 · r{versionQuery.data.revision}</strong><time>{formatDate(versionQuery.data.createdAt)}</time></header>
                      <p className="muted">{versionQuery.data.origin === 'ai_adoption' ? '人工采纳的 AI 草稿' : '人工编辑'}</p>
                      <MaterialDocumentView doc={versionQuery.data.doc} className="tm-document-preview" />
                      <ul>{versionQuery.data.attachments?.map(a => <li key={a.fileId}>{a.availability === 'unavailable' ? <span>{a.name} · 原文件不可用{a.deletedAt ? '（已移入回收站，可恢复）' : ''}；历史关联保留</span> : <a href={projectPath(projectId, `/files/${encodeURIComponent(a.fileId)}/content`)} download={a.name}>{a.name}</a>}</li>)}</ul>
                    </>}
                  </div>}
                </section>
              </Modal>
            </div>
            <article className="tm-print-document" aria-hidden="true"><h1>{material.title}</h1><p>项目材料 · 服务端版本 r{activeVersion}{dirty ? ' · 含本机未保存修改' : ''}</p><MaterialDocumentView doc={printDoc} className="tm-document-preview" /></article>
          </>}
        </main>
      </div>
    </div>
  );
}
