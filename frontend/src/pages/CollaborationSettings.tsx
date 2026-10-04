import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useProject } from '../components/ProjectShell';
import { ErrorNotice, Field, SectionCard, Spinner } from '../components/ui';
import { ApiError } from '../api/client';
import { collaborationApi, type CollaborationMode, type CollaborationSettingsData } from '../api/collaboration';

export function CollaborationSettings() {
  const { projectId } = useProject();
  return <ProjectCollaborationSettings key={projectId} />;
}

function ProjectCollaborationSettings() {
  const { projectId, project } = useProject();
  const client = useQueryClient();
  const owner = project.myRole === 'owner';
  const query = useQuery({ queryKey: ['collaboration-settings', projectId], queryFn: () => collaborationApi.settings(projectId) });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [assignment, setAssignment] = useState<CollaborationMode | null>(null);
  const [evaluation, setEvaluation] = useState<CollaborationMode | null>(null);
  const [planning, setPlanning] = useState<CollaborationMode | null>(null);
  const [progression, setProgression] = useState<CollaborationMode | null>(null);
  const [base, setBase] = useState<(CollaborationSettingsData & { projectId: string }) | null>(null);
  const [conflict, setConflict] = useState(false);
  const outdated = conflict || Boolean(base && (base.revision !== query.data?.revision || base.projectId !== projectId));
  const save = useMutation({
    mutationFn: () => { if (outdated || !base) throw new Error('设置版本已变化，请重新载入后编辑。'); return collaborationApi.saveSettings(projectId, { expectedRevision: base.revision, aiCollaborationEnabled: enabled ?? base.aiCollaborationEnabled, assignmentMode: assignment ?? base.assignmentMode, evaluationMode: evaluation ?? base.evaluationMode, ...(planning !== null ? { planningMode: planning } : {}), ...(progression !== null ? { progressionMode: progression } : {}) }); },
    onSuccess: (data) => { client.setQueryData(['collaboration-settings', projectId], data); void client.invalidateQueries({ queryKey: ['project', projectId] }); setEnabled(null); setAssignment(null); setEvaluation(null); setPlanning(null); setProgression(null); setBase(null); setConflict(false); },
    onError: error => { if (error instanceof ApiError && error.status === 409) setConflict(true); void client.invalidateQueries({ queryKey: ['collaboration-settings', projectId] }); },
  });
  return <SectionCard title="AI 智能协作" detail="新项目默认启用 AI，可分别调整四项协作行为。只有当前项目负责人能启停与调整规则；全局账号权限不会替代项目授权。">
    {query.isLoading && <Spinner label="读取协作规则" />}
    {query.error && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
    {query.data && <form className="stack" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <label className="checkbox-row"><input type="checkbox" disabled={!owner || save.isPending} checked={enabled ?? base?.aiCollaborationEnabled ?? query.data.aiCollaborationEnabled ?? false} onChange={event => { if (!base) setBase({ ...query.data!, projectId }); setEnabled(event.target.checked); }} /><span>开启本项目 AI 智能协作</span></label>

      <div className="form-grid-two">
        <Field label="分工方式"><select className="input" disabled={!owner || save.isPending} value={assignment ?? base?.assignmentMode ?? query.data.assignmentMode} onChange={event => { if (!base) setBase({ ...query.data!, projectId }); setAssignment(event.target.value as CollaborationMode); }}><option value="manual">负责人确认分工</option><option value="automatic">自动应用 AI 分工</option></select></Field>
        <Field label="成果验收方式"><select className="input" disabled={!owner || save.isPending} value={evaluation ?? base?.evaluationMode ?? query.data.evaluationMode} onChange={event => { if (!base) setBase({ ...query.data!, projectId }); setEvaluation(event.target.value as CollaborationMode); }}><option value="manual">负责人确认验收</option><option value="automatic">自动应用 AI 评价</option></select></Field>
        <Field label="任务规划审核"><select className="input" disabled={!owner || save.isPending} value={planning ?? base?.planningMode ?? query.data.planningMode ?? 'manual'} onChange={event=>{if(!base)setBase({...query.data!,projectId});setPlanning(event.target.value as CollaborationMode);}}><option value="manual">事先确认 AI 规划</option><option value="automatic">允许自动应用 AI 规划</option></select></Field>
        <Field label="进度推进审核"><select className="input" disabled={!owner || save.isPending} value={progression ?? base?.progressionMode ?? query.data.progressionMode ?? 'manual'} onChange={event=>{if(!base)setBase({...query.data!,projectId});setProgression(event.target.value as CollaborationMode);}}><option value="manual">事先确认 AI 推进</option><option value="automatic">允许 AI 自主推进</option></select></Field>
      </div>

      {outdated && <div className="notice notice-warn">协作规则已更新。请重新载入最新设置后再修改，避免覆盖他人的选择。</div>}
      {outdated && <button type="button" className="button button-quiet" onClick={() => { setBase(null); setEnabled(null); setAssignment(null); setEvaluation(null); setPlanning(null); setProgression(null); setConflict(false); save.reset(); }}>重新载入协作规则</button>}
      {save.error && <ErrorNotice error={save.error} />}
      {owner && <button className="button button-primary" disabled={save.isPending || outdated || (enabled === null && assignment === null && evaluation === null && planning === null && progression === null)}>{save.isPending ? '保存中…' : '保存协作规则'}</button>}
    </form>}
  </SectionCard>;
}
