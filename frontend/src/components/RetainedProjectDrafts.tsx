import { useState } from 'react';
import { listProjectDrafts, removeDraft } from '../storage';
import { offlineAccount } from '../offline/store';
import { confirmPage } from '../dialogs/dialog-service';

export function RetainedProjectDrafts({ accountId, projectId }: { accountId: string; projectId: string }) {
  const [drafts, setDrafts] = useState(() => listProjectDrafts(accountId, projectId));
  const [error, setError] = useState('');
  if (offlineAccount()?.id !== accountId || !drafts.length) return null;
  const exportDraft = (draft: typeof drafts[number]) => {
    if (offlineAccount()?.id !== accountId) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ projectId, ...draft }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'retained-project-draft.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const discard = async (materialId: string) => {
    if (!await confirmPage('确认永久删除这份尚未同步的本机草稿？可先导出备份。') || offlineAccount()?.id !== accountId) return;
    if (!removeDraft(accountId, projectId, materialId)) { setError('删除本机草稿失败，请重试。'); return; }
    setDrafts(listProjectDrafts(accountId, projectId));
  };
  return <section aria-label="保留的本机草稿"><h2>保留的本机草稿</h2><p>这些是原账号尚未提交的本机内容，不会自动同步到已失权项目。</p>{drafts.map(draft => <div key={draft.materialId} className="button-row"><span>{draft.savedAt}</span><button className="button button-quiet" onClick={() => exportDraft(draft)}>导出本机草稿</button><button className="button button-danger" onClick={() => void discard(draft.materialId)}>删除此草稿</button></div>)}{error && <p role="alert">{error}</p>}</section>;
}
