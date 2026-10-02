import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { projectRequest, type ProjectGoal } from '../api/simplification';
import { useProject } from '../components/ProjectShell';
import { ErrorNotice, Field, PageHeading, SectionCard, Spinner } from '../components/ui';
import { CollaborationWorkspace } from './CollaborationWorkspace';
import './TasksMaterials.css';

export function TasksPage() {
  const { projectId, project } = useProject();
  const client = useQueryClient();
  const goal = useQuery({ queryKey: ['project-goal', projectId], queryFn: ({ signal }) => projectRequest<ProjectGoal>(projectId, '/goal', { signal }) });
  const [draft, setDraft] = useState<{ title: string; detail: string; revision: number } | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const save = useMutation({
    mutationFn: () => projectRequest<ProjectGoal>(projectId, '/goal', { method: 'PATCH', body: { expectedRevision: draft?.revision, title: draft?.title.trim(), detail: draft?.detail.trim() } }),
    onSuccess: async data => { client.setQueryData(['project-goal', projectId], data); setDraft(null); setConflicted(false); },
    onError: async error => { if (error instanceof ApiError && error.status === 409) { setConflicted(true); await goal.refetch(); } },
  });
  return <div className="page-stack tm-page tm-tasks-page">
    <PageHeading title="任务工作区" detail="一个主目标，下设有依赖关系的子任务；认领、分工、提交和验收都在同一处完成。" />
    <SectionCard title="项目主目标" detail="主目标独立保存，不计入任务数量或成员工时。AI 拆解会先生成可复核的目标和子任务预览。">
      {goal.isLoading && <Spinner label="正在读取项目主目标" />}
      {goal.error && <ErrorNotice error={goal.error} onRetry={() => void goal.refetch()} />}
      {goal.data && !draft && <><h3>{goal.data.title || '尚未填写主目标'}</h3><p className="collab-preserve">{goal.data.detail || '由负责人明确团队需要共同达成的成果。'}</p>{project.myRole === 'owner' && <button className="button button-quiet" onClick={() => { setDraft(goal.data!); setConflicted(false); save.reset(); }}>编辑主目标</button>}</>}
      {draft && <form className="stack" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
        <Field label="主目标"><input className="input" required maxLength={200} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} /></Field>
        <Field label="目标说明"><textarea className="input" maxLength={4000} rows={3} value={draft.detail} onChange={event => setDraft({ ...draft, detail: event.target.value })} /></Field>
        {conflicted && <p className="notice notice-warn">主目标已被修改，本地草稿已保留。请对照最新目标后重新编辑。</p>}
        {conflicted && <button type="button" className="button button-quiet" onClick={() => { if (goal.data) setDraft(goal.data); setConflicted(false); save.reset(); }}>载入最新目标</button>}
        {save.error && <ErrorNotice error={save.error} />}
        <div className="form-actions"><button className="button button-primary" disabled={save.isPending || conflicted || !draft.title.trim()}>保存主目标</button><button type="button" className="button button-quiet" onClick={() => setDraft(null)}>取消</button></div>
      </form>}
    </SectionCard>
    <CollaborationWorkspace />
  </div>;
}
