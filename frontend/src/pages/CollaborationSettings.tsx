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
  const [assignment, setAssignment] = useState<CollaborationMode | null>(null);
  const [evaluation, setEvaluation] = useState<CollaborationMode | null>(null);
  const [base, setBase] = useState<(CollaborationSettingsData & { projectId: string }) | null>(null);
  const [conflict, setConflict] = useState(false);
  const outdated = conflict || Boolean(base && (base.revision !== query.data?.revision || base.projectId !== projectId));
  const save = useMutation({
    mutationFn: () => { if (outdated || !base) throw new Error('设置版本已变化，请重新载入后编辑。'); return collaborationApi.saveSettings(projectId, { expectedRevision: base.revision, assignmentMode: assignment ?? base.assignmentMode, evaluationMode: evaluation ?? base.evaluationMode }); },
    onSuccess: (data) => { client.setQueryData(['collaboration-settings', projectId], data); setAssignment(null); setEvaluation(null); setBase(null); setConflict(false); },
    onError: error => { if (error instanceof ApiError && error.status === 409) setConflict(true); void client.invalidateQueries({ queryKey: ['collaboration-settings', projectId] }); },
  });
  return <SectionCard title="任务协作规则" detail="分工和成果验收分别设置，默认均由负责人确认。只有负责人可以调整。">
    {query.isLoading && <Spinner label="读取协作规则" />}
    {query.error && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
    {query.data && <form className="stack" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <div className="form-grid-two">
        <Field label="分工方式"><select className="input" disabled={!owner || save.isPending} value={assignment ?? base?.assignmentMode ?? query.data.assignmentMode} onChange={event => { if (!base) setBase({ ...query.data!, projectId }); setAssignment(event.target.value as CollaborationMode); }}><option value="manual">负责人确认分工</option><option value="automatic">自动应用 AI 分工</option></select></Field>
        <Field label="成果验收方式"><select className="input" disabled={!owner || save.isPending} value={evaluation ?? base?.evaluationMode ?? query.data.evaluationMode} onChange={event => { if (!base) setBase({ ...query.data!, projectId }); setEvaluation(event.target.value as CollaborationMode); }}><option value="manual">负责人确认验收</option><option value="automatic">自动应用 AI 评价</option></select></Field>
      </div>
      <p className="form-note">自动模式会把有效 AI 结果写入协作记录。AI 不可用或执行失败时保留原状态，可继续手动操作。附件只作人工参考，不会声称已解析附件内容。</p>
      {outdated && <div className="notice notice-warn">协作规则已更新。请重新载入最新设置后再修改，避免覆盖他人的选择。</div>}
      {outdated && <button type="button" className="button button-quiet" onClick={() => { setBase(null); setAssignment(null); setEvaluation(null); setConflict(false); save.reset(); }}>重新载入协作规则</button>}
      {save.error && <ErrorNotice error={save.error} />}
      {owner && <button className="button button-primary" disabled={save.isPending || outdated || (assignment === null && evaluation === null)}>{save.isPending ? '保存中…' : '保存协作规则'}</button>}
    </form>}
  </SectionCard>;
}
