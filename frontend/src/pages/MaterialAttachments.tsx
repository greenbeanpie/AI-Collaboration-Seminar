import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, projectPath } from '../api/client';
import type { DataOf } from '../api/types';
import { useProject } from '../components/ProjectShell';
import { ErrorNotice } from '../components/ui';
import { uploadProjectFile } from './source-workflows';

export function MaterialAttachments({ material, disabled }: { material: DataOf<'MaterialResponse'>; disabled: boolean }) {
  const { projectId } = useProject();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
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
  return <section className="stack tm-hide-print" aria-label="材料附件">
    <h3>材料附件</h3>
    <p className="muted">附件变更生成新版本；历史版本保留原附件。请先保存正文，再更改附件。</p>
    <ul>{attachments.map(a => <li key={a.fileId}>{a.availability === 'unavailable' ? <span>{a.name} · 原文件不可用{a.deletedAt ? '（已移入回收站，可恢复）' : ''}；附件历史保留</span> : <a href={projectPath(projectId, `/files/${encodeURIComponent(a.fileId)}/content`)} download={a.name}>{a.name}</a>} <button className="button button-quiet button-small" disabled={disabled || busy} onClick={() => void run(() => update(attachments.filter(v => v.fileId !== a.fileId).map(v => v.fileId)))}>移除关联</button></li>)}</ul>
    <label>上传并关联附件 <input type="file" disabled={disabled || busy || attachments.length >= 20 || !current} onChange={e => {
      const file = e.target.files?.[0]; e.target.value = '';
      if (file) void run(async () => { const id = await uploadProjectFile(projectId, file); await update([...attachments.map(a => a.fileId), id]); });
    }} /></label>
    {busy && <p role="status">正在保存附件版本……</p>}{Boolean(error) && <ErrorNotice error={error} />}
  </section>;
}
