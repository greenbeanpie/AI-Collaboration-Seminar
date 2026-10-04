import { DateInput } from '../components/DateInput';
import { useEffect, useState } from 'react';
import { ProjectGoalSettings } from './ProjectGoalSettings';
import { CollaborationSettings } from './CollaborationSettings';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Save } from 'lucide-react';
import { ApiError, api, projectPath } from '../api/client';
import { useProject } from '../components/ProjectShell';
import { ErrorNotice, Field, PageHeading, SectionCard, StatusPill } from '../components/ui';

export function ProjectSettingsPage() {
  const { projectId, project } = useProject();
  const queryClient = useQueryClient();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [deadlineDate, setDeadlineDate] = useState(project.deadlineDate?.slice(0, 10) ?? '');
  const [deadlinePrecision, setDeadlinePrecision] = useState(project.deadlinePrecision);
  const [deadlineDateChanged, setDeadlineDateChanged] = useState(false);
  const [status, setStatus] = useState(project.status);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const owner = project.myRole === 'owner';

  useEffect(() => {
    if (dirty) return;
    setName(project.name); setDescription(project.description); setDeadlineDate(project.deadlineDate?.slice(0, 10) ?? '');
    setDeadlinePrecision(project.deadlinePrecision); setDeadlineDateChanged(false); setStatus(project.status);
  }, [project, dirty]);

  const save = useMutation({
    mutationFn: () => api.patch<'ProjectResponse'>(projectPath(projectId), {
      expectedRevision: project.revision,
      name: name.trim(), description: description.trim(),
      deadlineDate: deadlineDateChanged ? deadlineDate || null : project.deadlineDate,
      deadlinePrecision: deadlineDateChanged ? deadlineDate ? 'date' : 'unknown' : deadlinePrecision,
      status,
    }),
    onSuccess: async (updated) => {
      setConflict(false); setDirty(false); setDeadlineDateChanged(false);
      queryClient.setQueryData(['project', projectId], updated);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        setConflict(true);
        await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
        await queryClient.refetchQueries({ queryKey: ['project', projectId], type: 'active' });
      }
    },
  });

  return <div className="page-stack settings-page">
    <PageHeading eyebrow="项目配置" title="项目设置" detail="修改项目资料时使用 revision 乐观锁。" action={<StatusPill tone={owner ? 'blue' : 'neutral'}>{owner ? '负责人' : '成员只读'}</StatusPill>} />
    <SectionCard title="项目基本信息" detail={`当前数据版本 revision ${project.revision} · 最近更新 ${new Date(project.updatedAt).toLocaleString('zh-CN')}`}>
      <form className="settings-form" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <Field label="项目名称"><input className="input" required maxLength={100} disabled={!owner} value={name} onChange={(event) => { setName(event.target.value); setDirty(true); }} /></Field>
        <Field label="项目说明"><textarea className="input textarea" rows={4} maxLength={2000} disabled={!owner} value={description} onChange={(event) => { setDescription(event.target.value); setDirty(true); }} /></Field>
        <div className="form-grid-two"><Field label="比赛或项目截止日期" hint="此页面只编辑日期；修改日期后会保存为日期精度。"><DateInput className="input" type="date" disabled={!owner} value={deadlineDate} onChange={(event) => { const date = event.target.value; setDeadlineDate(date); setDeadlinePrecision(date ? 'date' : 'unknown'); setDeadlineDateChanged(true); setDirty(true); }} /></Field><Field label="服务端日期精度"><div className="form-note">{deadlinePrecision === 'datetime' ? `后端已有时刻记录：${project.deadlineDate ?? '日期未返回'}。未改日期时将原样保留；编辑日期后按日期保存。` : deadlinePrecision === 'date' ? '精确到日期；页面不会补充未提供的时刻。' : '日期精度未确认。'}</div></Field></div>
        <Field label="项目状态"><select className="input" disabled={!owner} value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setDirty(true); }}><option value="active">进行中</option><option value="archived">已归档</option></select></Field>
        {!owner && <div className="form-note"><AlertTriangle size={16} />只有负责人可以修改项目资料。其他协作功能仍受项目成员角色授权。</div>}
        {conflict && <div className="conflict-panel"><h3>项目内容已被其他成员更新</h3><p className="muted">本地编辑仍保留在表单中。请对照当前服务端版本，再决定是否用本地内容提交到新 revision。</p><div className="conflict-columns"><div><strong>服务端当前值 · revision {project.revision}</strong><pre>{JSON.stringify({ name: project.name, description: project.description, deadlineDate: project.deadlineDate, deadlinePrecision: project.deadlinePrecision, status: project.status }, null, 2)}</pre></div><div><strong>你本地保留的修改</strong><pre>{JSON.stringify({ name, description, deadlineDate: deadlineDate || null, deadlinePrecision, status }, null, 2)}</pre></div></div></div>}
        {save.error && <ErrorNotice error={save.error} />}
        {dirty && <div className="notice notice-warn"><AlertTriangle size={16} /><span>有尚未提交的本地修改。联网后请明确保存；服务端不会自动覆盖旧版本。</span></div>}
        {owner && <div className="form-actions"><button className="button button-primary" type="submit" disabled={save.isPending || !dirty || !name.trim()}><Save size={15} />{save.isPending ? '保存中…' : conflict ? '确认对照后提交本地版本' : '保存项目设置'}</button></div>}
      </form>
    </SectionCard>

    <ProjectGoalSettings />
    <CollaborationSettings />
  </div>;
}
