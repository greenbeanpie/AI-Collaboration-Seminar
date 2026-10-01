import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useProject } from '../components/ProjectShell';
import { ErrorNotice, Field, SectionCard, Spinner } from '../components/ui';
import { collaborationApi, type CollaborationMode } from '../api/collaboration';

export function CollaborationSettings() {
  const { projectId, project } = useProject();
  const client = useQueryClient();
  const owner = project.myRole === 'owner';
  const query = useQuery({ queryKey: ['collaboration-settings', projectId], queryFn: () => collaborationApi.settings(projectId) });
  const [assignment, setAssignment] = useState<CollaborationMode | null>(null);
  const [evaluation, setEvaluation] = useState<CollaborationMode | null>(null);
  const save = useMutation({
    mutationFn: () => collaborationApi.saveSettings(projectId, { expectedRevision: query.data!.revision, assignmentMode: assignment ?? query.data!.assignmentMode, evaluationMode: evaluation ?? query.data!.evaluationMode }),
    onSuccess: (data) => { client.setQueryData(['collaboration-settings', projectId], data); setAssignment(null); setEvaluation(null); },
    onError: () => { void client.invalidateQueries({ queryKey: ['collaboration-settings', projectId] }); },
  });
  return <SectionCard title="任务协作规则" detail="分工和成果验收分别设置，默认均由负责人确认。只有负责人可以调整。">
    {query.isLoading && <Spinner label="读取协作规则" />}
    {query.error && <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />}
    {query.data && <form className="stack" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <div className="form-grid-two">
        <Field label="分工方式"><select className="input" disabled={!owner || save.isPending} value={assignment ?? query.data.assignmentMode} onChange={event => setAssignment(event.target.value as CollaborationMode)}><option value="manual">负责人确认分工</option><option value="automatic">自动应用 AI 分工</option></select></Field>
        <Field label="成果验收方式"><select className="input" disabled={!owner || save.isPending} value={evaluation ?? query.data.evaluationMode} onChange={event => setEvaluation(event.target.value as CollaborationMode)}><option value="manual">负责人确认验收</option><option value="automatic">自动应用 AI 评价</option></select></Field>
      </div>
      <p className="form-note">自动模式会把有效 AI 结果写入协作记录。AI 不可用或执行失败时保留原状态，可继续手动操作。附件只作人工参考，不会声称已解析附件内容。</p>
      {save.error && <ErrorNotice error={save.error} />}
      {owner && <button className="button button-primary" disabled={save.isPending || (assignment === null && evaluation === null)}>{save.isPending ? '保存中…' : '保存协作规则'}</button>}
    </form>}
  </SectionCard>;
}
