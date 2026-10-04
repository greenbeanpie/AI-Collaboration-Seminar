import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useProject } from '../components/ProjectShell';
import { ErrorNotice, Field, SectionCard, Spinner } from '../components/ui';
import { projectRequest, type ProjectGoal } from '../api/simplification';

export function ProjectGoalSettings() {
  const { projectId } = useProject();
  return <GoalSettings key={projectId} />;
}

function GoalSettings() {
  const { projectId, project } = useProject();
  const client = useQueryClient();
  const owner = project.myRole === 'owner';
  const query = useQuery({ queryKey: ['project-goal', projectId], queryFn: () => projectRequest<ProjectGoal>(projectId, '/goal') });
  const [edit, setEdit] = useState<ProjectGoal | null>(null);
  const outdated = Boolean(edit && query.data && edit.revision !== query.data.revision);
  const save = useMutation({
    mutationFn: () => {
      if (!edit || outdated) throw new Error('主目标已更新，请重新载入后编辑。');
      return projectRequest<ProjectGoal>(projectId, '/goal', { method: 'PATCH', body: { expectedRevision: edit.revision, title: edit.title.trim(), detail: edit.detail } });
    },
    onSuccess: async data => {
      client.setQueryData(['project-goal', projectId], data);
      setEdit(null);
      await Promise.all(['materials', 'material', 'resource-library', 'project-overview', 'goal'].map(key => client.invalidateQueries({ queryKey: [key, projectId] })));
    },
    onError: () => { void query.refetch(); },
  });
  const displayed = edit ?? query.data;
  return <SectionCard title="项目主目标" detail="修改目标后，系统背景自动同步并保留历史版本；已有任务保持当前安排。">
    {query.isLoading && <Spinner label="读取项目主目标" />}
    {query.error && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
    {displayed && <form className="stack" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <Field label="主目标"><input className="input" maxLength={200} required value={displayed.title} disabled={!owner || save.isPending} onChange={event => setEdit({ ...displayed, title: event.target.value })} /></Field>
      <Field label="目标说明（可选）"><textarea className="input textarea" rows={4} maxLength={12000} value={displayed.detail} disabled={!owner || save.isPending} onChange={event => setEdit({ ...displayed, detail: event.target.value })} /></Field>
      {outdated && <div className="notice notice-warn">主目标已有新版本。本地修改仍保留，请核对最新内容后重新编辑。<p>最新目标：{query.data?.title}</p><p style={{ whiteSpace: 'pre-wrap' }}>{query.data?.detail}</p><button type="button" className="button button-quiet" onClick={() => { setEdit(null); save.reset(); }}>载入最新目标</button></div>}
      {save.error && <ErrorNotice error={save.error} />}
      {owner && <button className="button button-primary" disabled={!edit || !edit.title.trim() || outdated || save.isPending}>{save.isPending ? '保存中…' : '保存项目目标'}</button>}
    </form>}
  </SectionCard>;
}
