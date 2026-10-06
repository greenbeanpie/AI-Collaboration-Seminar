import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, projectPath } from '../api/client';
import { usePageDialogs } from '../dialogs/usePageDialogs';

export type LifecycleResource = {
  kind: 'file' | 'source';
  id: string;
  name: string;
  lifecycleVersion: number;
  canDelete: boolean;
  deletedAt: string | null;
};

export type LifecycleChange = { projectId: string; fileId?: string; sourceIds: string[]; restored: boolean };

export function useSourceLifecycle(
  projectId: string,
  scope: string,
  resources: LifecycleResource[],
  onChanged: (change: LifecycleChange) => void,
) {
  const queryClient = useQueryClient();
  const dialogs = usePageDialogs(`${projectId}:${scope}`);
  const current = useRef({ projectId, scope, resources, onChanged });
  current.current = { projectId, scope, resources, onChanged };
  const action = useRef(false);
  const [pending, setPending] = useState<{ projectId: string; scope: string; key: string } | null>(null);
  const [feedback, setFeedback] = useState<{ projectId: string; scope: string; error?: unknown; message?: string } | null>(null);

  const changeLifecycle = async (resource: LifecycleResource, restored: boolean) => {
    if (action.current || !resource.canDelete || Boolean(resource.deletedAt) !== restored) return;
    action.current = true;
    const actionScope = { projectId, scope };
    setPending({ ...actionScope, key: `${resource.kind}:${resource.id}` });
    setFeedback(null);
    try {
      const approved = await dialogs.confirm(restored
        ? `恢复“${resource.name}”？原文件和已有历史将重新可用。恢复不会自动启动解析、OCR、要求提取或文件总结，也不会恢复已取消的任务；需要时请手动开始处理。`
        : `将“${resource.name}”移入回收站？这会停止关联的解析、OCR、要求提取和文件总结，并从当前项目资料中移除。原文件、已有正文与历史仍会保留，可以恢复。已经发出的供应商请求及其费用无法撤回。`,
      { title: restored ? '恢复资料' : '移入回收站', confirmLabel: restored ? '确认恢复' : '确认移入回收站' });
      if (!approved || current.current.projectId !== projectId || current.current.scope !== scope) return;
      const latest = current.current.resources.find(item => item.kind === resource.kind && item.id === resource.id);
      if (!latest?.canDelete || latest.lifecycleVersion !== resource.lifecycleVersion || latest.deletedAt !== resource.deletedAt) {
        throw new Error('资料状态或操作权限已变化，请刷新列表后再操作。');
      }
      const path = projectPath(projectId, `/${resource.kind === 'file' ? 'files' : 'sources'}/${encodeURIComponent(resource.id)}`);
      const body = { expectedLifecycleVersion: resource.lifecycleVersion };
      let sourceIds: string[];
      if (resource.kind === 'file') {
        const result = restored
          ? await api.post<'FileLifecycleResponse'>(`${path}/restore`, body)
          : await api.delete<'FileLifecycleResponse'>(path, { body });
        sourceIds = result.affectedSourceIds;
      } else {
        const result = restored
          ? await api.post<'SourceLifecycleResponse'>(`${path}/restore`, body)
          : await api.delete<'SourceLifecycleResponse'>(path, { body });
        sourceIds = [result.sourceId];
      }
      // Hide old records immediately, so stale parse/retry controls cannot survive the mutation.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ['sources', projectId] }),
        queryClient.cancelQueries({ queryKey: ['files', projectId] }),
        queryClient.cancelQueries({ queryKey: ['sourceFragments', projectId] }),
        queryClient.cancelQueries({ queryKey: ['sourceVersion', projectId] }),
        queryClient.cancelQueries({ queryKey: ['sourceProcessing', projectId] }),
        queryClient.cancelQueries({ queryKey: ['project-assistant-source-version', projectId] }),
        queryClient.cancelQueries({ queryKey: ['project-assistant-source-processing', projectId] }),
      ]);
      queryClient.setQueriesData({ queryKey: ['sources', projectId] }, data => removeCachedRecords(data, 'sourceId', sourceIds));
      queryClient.setQueriesData({ queryKey: ['project-assistant-sources', projectId] }, data => removeCachedRecords(data, 'sourceId', sourceIds));
      for (const sourceId of sourceIds) {
        // Restored records must reload server-cancelled job metadata before showing retry controls.
        for (const key of ['sourceVersion', 'sourceProcessing', 'project-assistant-source-version', 'project-assistant-source-processing']) queryClient.removeQueries({ queryKey: [key, projectId, sourceId] });
      }
      if (resource.kind === 'file') queryClient.setQueriesData({ queryKey: ['files', projectId] }, data => removeCachedRecords(data, 'fileId', [resource.id]));
      current.current.onChanged({ projectId, fileId: resource.kind === 'file' ? resource.id : undefined, sourceIds, restored });
      if (current.current.projectId === projectId && current.current.scope === scope) {
        setFeedback({ ...actionScope, message: restored ? '资料已恢复。未自动启动任何 AI 处理，请按需手动开始。' : '资料已移入回收站，原文件和历史已保留。' });
      }
      await Promise.all(['files', 'sources', 'sourceVersion', 'sourceProcessing', 'sourceFragments', 'jobs', 'materials', 'material', 'materialVersions', 'materialVersion', 'project', 'projectContext', 'projectAiContext', 'project-assistant-sources', 'project-assistant-source-version', 'project-assistant-source-processing', 'requirementSets', 'requirementSet'].map(key => queryClient.invalidateQueries({ queryKey: [key, projectId] })));
      await queryClient.invalidateQueries({ queryKey: ['job'] });
    } catch (error) {
      if (current.current.projectId === projectId && current.current.scope === scope) setFeedback({ ...actionScope, error });
      // A stale lifecycle version or revoked permission must never be retried automatically.
      void queryClient.invalidateQueries({ queryKey: ['files', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['sources', projectId] });
    } finally {
      action.current = false;
      setPending(null);
    }
  };

  const inScope = (value: { projectId: string; scope: string } | null) => value?.projectId === projectId && value.scope === scope;
  return {
    changeLifecycle,
    busy: inScope(pending),
    pendingKey: inScope(pending) ? pending!.key : null,
    error: inScope(feedback) ? feedback?.error : undefined,
    message: inScope(feedback) ? feedback?.message : undefined,
  };
}

/** Preserve pagination metadata while hiding stale lifecycle controls in every loaded page. */
function removeCachedRecords(data: unknown, key: 'sourceId' | 'fileId', ids: string[]): unknown {
  if (Array.isArray(data)) return data.filter(item => !ids.includes(item?.[key]));
  if (!data || typeof data !== 'object') return data;
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.pages)) return { ...record, pages: record.pages.map(page => removeCachedRecords(page, key, ids)) };
  if (Array.isArray(record.items)) return { ...record, items: removeCachedRecords(record.items, key, ids) };
  return data;
}
