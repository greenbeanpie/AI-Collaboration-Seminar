import { useState } from 'react';
import './MemberPermissions.css';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, projectPath } from '../api/client';
import type { Member } from '../api/types';
import { ErrorNotice } from '../components/ui';
import { Modal } from '../dialogs/Modal';
import {
  ordinaryPermissions,
  permissionOptions,
  permissionTemplate,
  permissionTemplates,
  withTemplate,
  type PermissionKey,
  type PermissionTemplate,
  type ProjectPermissions,
} from '../project-permissions';

const groups = Array.from(new Set(permissionOptions.map(option => option.group)));

/** 权限编辑入口只对普通成员开放；owner 与平台管理员的项目权限由身份决定。 */
export function MemberPermissionsDialog({ projectId, member, onClose }: { projectId: string; member: Member; onClose: () => void }) {
  const client = useQueryClient();
  const initial = { ...ordinaryPermissions, ...(member.permissions ?? {}) };
  const [draft, setDraft] = useState<ProjectPermissions>(initial);
  const [template, setTemplate] = useState<PermissionTemplate>(() => permissionTemplate(initial));
  const [conflict, setConflict] = useState(false);
  const save = useMutation({
    mutationFn: () => api.patch<'MemberResponse'>(projectPath(projectId, `/members/${encodeURIComponent(member.userId)}/permissions`), {
      expectedRevision: member.permissionsRevision ?? 1,
      permissions: {
        teamManage: Boolean(draft.teamManage), taskManage: Boolean(draft.taskManage), resourceManage: Boolean(draft.resourceManage),
        scoreInitiate: Boolean(draft.scoreInitiate), scoreCorrect: Boolean(draft.scoreCorrect),
      },
    }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['members', projectId] }),
        client.invalidateQueries({ queryKey: ['member-me', projectId] }),
        client.invalidateQueries({ queryKey: ['project', projectId] }),
      ]);
      onClose();
    },
    onError: error => {
      if (error instanceof ApiError && (error.status === 409 || error.code === 'VERSION_CONFLICT')) {
        setConflict(true);
        void client.invalidateQueries({ queryKey: ['members', projectId] });
      }
    },
  });
  function applyTemplate(value: PermissionTemplate) {
    setTemplate(value);
    if (value !== 'custom') setDraft(withTemplate(value));
  }
  function toggle(key: PermissionKey, checked: boolean) {
    const next = { ...draft, [key]: checked };
    setDraft(next);
    setTemplate(permissionTemplate(next));
  }
  return <Modal title={`${member.displayName} 的项目权限`} onClose={onClose}>
    <form className="stack permission-form" onSubmit={event => { event.preventDefault(); setConflict(false); save.mutate(); }}>
      <label className="permission-template">权限模板
        <select className="input" aria-label="权限模板" value={template} disabled={save.isPending} onChange={event => applyTemplate(event.target.value as PermissionTemplate)}>
          {permissionTemplates.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </label>
      <p className="form-note">模板只是快速填写权限的方式，不是账户角色；保存后以逐项权限为准。</p>
      {conflict && <div className="notice notice-warn" role="alert">该成员的权限已被其他管理员修改，请刷新后重新确认。</div>}
      {groups.map(group => <fieldset className="permission-group" key={group} disabled={save.isPending}>
        <legend>{group}</legend>
        {permissionOptions.filter(option => option.group === group).map(option => <label className="permission-option" key={option.key}>
          <input type="checkbox" checked={Boolean(draft[option.key])} onChange={event => toggle(option.key, event.target.checked)} />
          <span><strong>{option.label}</strong><small>{option.detail}</small></span>
        </label>)}
      </fieldset>)}
      {save.error && !conflict && <ErrorNotice error={save.error} />}
      <div className="form-actions">
        <button type="button" className="button button-quiet" disabled={save.isPending} onClick={onClose}>取消</button>
        <button type="submit" className="button button-primary" disabled={save.isPending}>{save.isPending ? '保存中…' : conflict ? '刷新后重新保存' : '保存'}</button>
      </div>
    </form>
  </Modal>;
}
