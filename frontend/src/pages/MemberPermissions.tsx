import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, projectPath } from '../api/client';
import type { Member } from '../api/types';
import { administratorPermissions, ordinaryPermissions, type ProjectPermissions } from '../project-permissions';
import { ErrorNotice } from '../components/ui';

const labels: Record<keyof ProjectPermissions,string> = { teamManage:'团队管理',taskManage:'任务管理',resourceManage:'资料管理',scoreInitiate:'评分与答辩发起',scoreCorrect:'历史评分修正' };
export function MemberPermissions({ projectId, member }: { projectId:string; member:Member }) {
  const client = useQueryClient();
  const [draft,setDraft] = useState<ProjectPermissions>(member.permissions ?? ordinaryPermissions);
  const save = useMutation({mutationFn: () => api.patch<'MemberResponse'>(projectPath(projectId,`/members/${encodeURIComponent(member.userId)}/permissions`),{expectedRevision:member.permissionsRevision ?? 1,permissions:draft}),onSuccess:async()=>{await Promise.all([client.invalidateQueries({queryKey:['members',projectId]}),client.invalidateQueries({queryKey:['member-me',projectId]}),client.invalidateQueries({queryKey:['project',projectId]})]);}});
  if (member.role === 'owner' || member.canGrantPermissions) return null;
  return <details><summary>调整 {member.displayName} 的权限</summary><form onSubmit={e=>{e.preventDefault();save.mutate();}} className="stack">
    <label>权限模板<select className="input" value="custom" onChange={e=>setDraft({...(e.target.value==='ordinary'?ordinaryPermissions:administratorPermissions)})}><option value="custom">逐项设置</option><option value="ordinary">普通成员</option><option value="manager">协作管理员</option></select></label>
    <fieldset disabled={save.isPending}>{Object.entries(labels).map(([key,label])=><label key={key} style={{display:'block'}}><input type="checkbox" checked={draft[key as keyof ProjectPermissions]} onChange={e=>setDraft(d=>({...d,[key]:e.target.checked}))}/>{label}</label>)}</fieldset>
    <button className="button button-primary button-small" disabled={save.isPending}>保存权限</button>{save.error && <ErrorNotice error={save.error}/>}
  </form></details>;
}
