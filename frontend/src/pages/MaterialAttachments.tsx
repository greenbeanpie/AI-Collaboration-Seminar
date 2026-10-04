import { ContributorNames, FileContributorPicker } from '../components/FileContributors';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, projectPath } from '../api/client';
import type { DataOf } from '../api/types';
import { useProject } from '../components/ProjectShell';
import { ErrorNotice } from '../components/ui';
import { uploadProjectFile } from './source-workflows';
import { archiveFile } from './task-files-client';

export function MaterialAttachments({ material, disabled, archiveDisabled = disabled }: { material: DataOf<'MaterialResponse'>; disabled: boolean; archiveDisabled?: boolean }) {
  const { projectId } = useProject();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [contributorIds, setContributorIds] = useState<string[] | undefined>();
  const [error, setError] = useState<unknown>();
  const [showArchived, setShowArchived] = useState(false);
  const current = material.currentVersion;
  const attachments = current?.attachments ?? [];
  async function update(ids: string[]) {
    if (!current) return;
    await api.put<'MaterialVersionResponse'>(projectPath(projectId, `/materials/${material.materialId}`), { expectedRevision: material.revision, doc: current.doc, attachmentIds: ids });
    await Promise.all(['material', 'materials', 'materialVersions'].map(key => qc.invalidateQueries({ queryKey: [key, projectId] })));
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(undefined);
    try { await action(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return <section className="stack tm-material-attachments tm-hide-print" aria-label="材料附件">
    <h3>材料附件</h3>
    <p className="muted">附件变更生成新版本；历史版本保留原附件。请先保存正文，再更改附件。</p>
    <button type="button" className="button button-quiet button-small" aria-pressed={showArchived} onClick={() => setShowArchived(value => !value)}>{showArchived ? '查看当前附件' : '查看已归档附件'}</button>
    {attachments.length > 0 && <ul>{attachments.filter(a => Boolean(a.archivedAt) === showArchived).map(a => <li key={a.fileId}>{a.availability === 'unavailable' ? <span>{a.name} · 原文件不可用{a.deletedAt ? '（已移入回收站，可恢复）' : ''}；附件历史保留</span> : <a href={projectPath(projectId, `/files/${encodeURIComponent(a.fileId)}/content`)} download={a.name}>{a.name}</a>} <ContributorNames contributors={a.contributors} />{a.archivedAt && <small>已归档 · 只读</small>}{!a.archivedAt && <button type="button" className="button button-quiet button-small" disabled={disabled || busy} onClick={() => void run(() => update(attachments.filter(v => v.fileId !== a.fileId).map(v => v.fileId)))}>移除关联</button>}{a.canManage && a.lifecycleVersion && <button type="button" className="button button-quiet button-small" disabled={archiveDisabled || busy || !!material.archivedAt} onClick={() => void run(async () => { await archiveFile(projectId, a.fileId, a.lifecycleVersion!, !!a.archivedAt); await Promise.all(['material', 'materials', 'resource-library', 'task-files', 'files'].map(key => qc.invalidateQueries({ queryKey: [key, projectId] }))); })}>{a.archivedAt ? '撤销文件归档' : '归档文件'}</button>}</li>)}</ul>}
    <FileContributorPicker projectId={projectId} value={contributorIds} onChange={setContributorIds} disabled={disabled || busy} />
    <label className="tm-attachment-upload">上传并关联附件 <input type="file" disabled={disabled || busy || contributorIds?.length === 0 || attachments.length >= 20 || !current} onChange={e => {
      const file = e.target.files?.[0]; e.target.value = '';
      if (file) void run(async () => { const id = await uploadProjectFile(projectId, file, undefined, undefined, { contributorIds }); await update([...attachments.map(a => a.fileId), id]); });
    }} /></label>
    {busy && <p role="status">正在保存附件版本……</p>}{Boolean(error) && <ErrorNotice error={error} />}
  </section>;
}
