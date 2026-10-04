import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorNotice } from '../components/ui';
import { archiveMaterial } from './task-files-client';
export function MaterialArchiveActions({ projectId, materialId, revision, archivedAt, canArchive, disabled }: { projectId: string; materialId: string; revision: number; archivedAt?: string | null; canArchive: boolean; disabled: boolean }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const change = async () => {
    setBusy(true); setError(undefined);
    try {
      await archiveMaterial(projectId, materialId, revision, !!archivedAt);
      await Promise.all(['material', 'materials', 'materialVersions', 'resource-library', 'task-files', 'files'].map(key => client.invalidateQueries({ queryKey: [key, projectId] })));
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  };
  return <>{archivedAt && <span className="status-pill status-warn">已归档 · 只读</span>}{canArchive && <button type="button" className="button button-quiet button-small" disabled={disabled || busy} onClick={() => void change()}>{busy ? '处理中…' : archivedAt ? '撤销材料归档' : '归档材料'}</button>}{error != null && <ErrorNotice error={error}/>}</>;
}
