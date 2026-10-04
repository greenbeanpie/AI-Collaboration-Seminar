import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, listAllItems, projectPath } from '../api/client';
import { collaborationApi, type CollaborationTask } from '../api/collaboration';
import { projectRequest, type ProjectGoal, type StandardVersion } from '../api/simplification';
import { ErrorNotice, Field, Spinner } from '../components/ui';
import { buildTaskAgentPrompt, type AgentMaterial } from './task-agent-prompt';
import { useTaskAgentEligibility } from './useTaskAgentEligibility';
import { TaskAgentEligibilityNotice } from './TaskAgentEligibilityNotice';
import { TaskBridgeHandoff } from './TaskBridgeHandoff';

export function TaskAgentHandoff({ projectId, task, tasks }: { projectId: string; task: CollaborationTask; tasks: CollaborationTask[] }) {
  return <TaskBridgeHandoff key={`${projectId}:${task.taskId}:${task.revision}`} projectId={projectId} task={task}><LegacyTaskAgentHandoff projectId={projectId} task={task} tasks={tasks} /></TaskBridgeHandoff>;
}

function LegacyTaskAgentHandoff({ projectId, task, tasks }: { projectId: string; task: CollaborationTask; tasks: CollaborationTask[] }) {
  const eligibility = useTaskAgentEligibility(projectId, task);
  const [status, setStatus] = useState('');
  const [transferError, setTransferError] = useState<Error | null>(null);
  const context = useQuery({
    enabled: eligibility.eligible,
    queryKey: ['task-agent-handoff', projectId, task.taskId, task.revision, eligibility.result?.sourceHash],
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      const [goal, standards, materials] = await Promise.all([
        projectRequest<ProjectGoal>(projectId, '/goal'),
        projectRequest<{ standard: StandardVersion | null }>(projectId, '/standards/current'),
        listAllItems<'MaterialListResponse'>(projectPath(projectId, '/materials')),
      ]);
      const dependencies: CollaborationTask[] = [];
      const seen = new Set([task.taskId]);
      const pending = [...task.dependsOnTaskIds];
      while (pending.length) {
        const id = pending.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const dependency = tasks.find(item => item.taskId === id);
        if (!dependency) throw new Error('部分前置任务尚未读取，请刷新任务列表后重试。');
        dependencies.push(dependency); pending.push(...dependency.dependsOnTaskIds);
      }
      const dependencyContext = await Promise.all(dependencies.map(async dependency => {
        const history = dependency.currentSubmissionId ? await collaborationApi.submissions(projectId, dependency.taskId) : null;
        const submission = history?.items.find(item => item.submissionId === dependency.currentSubmissionId);
        if (dependency.currentSubmissionId && !submission) throw new Error('前置任务的当前成果不可用，请刷新任务列表后重试。');
        return { task: dependency, submission };
      }));
      const materialContext: AgentMaterial[] = [];
      // Bound parallel reads without truncating the exported context.
      for (let offset = 0; offset < materials.length; offset += 4) {
        materialContext.push(...await Promise.all(materials.slice(offset, offset + 4).map(async material => {
          if (!material.currentVersionId) return { materialId: material.materialId, title: material.title, versionId: null };
          const version = await api.get<'MaterialVersionResponse'>(projectPath(projectId, `/materials/${encodeURIComponent(material.materialId)}/versions/${encodeURIComponent(material.currentVersionId)}`));
          return { materialId: material.materialId, title: material.title, versionId: version.versionId, revision: version.revision, markdown: version.markdown, attachments: version.attachments.map(file => ({ name: file.name, unavailable: file.availability === 'unavailable', url: new URL(projectPath(projectId, `/files/${encodeURIComponent(file.fileId)}/content`), window.location.origin).href })) };
        })));
      }
      // A prerequisite may have submitted an older version than the library's current one.
      for (const dependency of dependencyContext) {
        for (const bound of dependency.submission?.materialVersions ?? []) {
          if (materialContext.some(item => item.versionId === bound.versionId)) continue;
          const version = await api.get<'MaterialVersionResponse'>(projectPath(projectId, `/materials/${encodeURIComponent(bound.materialId)}/versions/${encodeURIComponent(bound.versionId)}`));
          materialContext.push({ materialId: bound.materialId, title: `${bound.title}（前置任务成果）`, versionId: version.versionId, revision: version.revision, markdown: version.markdown, attachments: version.attachments.map(file => ({ name: file.name, unavailable: file.availability === 'unavailable', url: new URL(projectPath(projectId, `/files/${encodeURIComponent(file.fileId)}/content`), window.location.origin).href })) });
        }
      }
      const projectUrl = new URL(window.location.href); projectUrl.search = ''; projectUrl.searchParams.set('task', task.taskId);
      return buildTaskAgentPrompt({ projectId, projectUrl: projectUrl.href, task, goal, standards: standards.standard ? [standards.standard] : [], dependencies: dependencyContext, materials: materialContext });
    },
  });
  const copy = async () => {
    if (!eligibility.eligible || !context.data || context.isFetching || context.error) return;
    setTransferError(null); setStatus('');
    try { await navigator.clipboard.writeText(context.data!); setStatus('提示词已复制，可粘贴给本地 Agent 执行。'); }
    catch { setTransferError(new Error('复制失败，请选择下方提示词手动复制，或下载提示词文件。')); }
  };
  const download = () => {
    if (!eligibility.eligible || !context.data || context.isFetching || context.error) return;
    setTransferError(null); setStatus('');
    let url: string | undefined;
    try {
      url = URL.createObjectURL(new Blob([context.data!], { type: 'text/markdown;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `task-${task.taskId}.md`; document.body.append(link); link.click(); link.remove(); setStatus('提示词文件已生成。请将文件交给本地 Agent 执行。');
    } catch { setTransferError(new Error('下载失败，请选择下方提示词手动复制。')); }
    finally { if (url) { const exportedUrl = url; window.setTimeout(() => URL.revokeObjectURL(exportedUrl), 1000); } }
  };
  if (!eligibility.eligible) return <div className="stack"><TaskAgentEligibilityNotice eligibility={eligibility} /></div>;
  return <div className="stack"><p>复制提示词或下载文件，然后交给本地 Agent 执行。</p>{context.isPending && <Spinner label="生成任务提示词" />}{context.error && <ErrorNotice error={context.error} onRetry={() => void context.refetch()} />}{context.data && !context.error && !context.isFetching && <><Field label="任务执行提示词"><textarea className="input" rows={14} readOnly value={context.data} onFocus={event => event.currentTarget.select()} /></Field><div className="collab-toolbar"><button className="button button-primary" disabled={context.isFetching} onClick={() => void copy()}>复制提示词</button><button className="button" disabled={context.isFetching} onClick={download}>下载提示词</button><button className="button button-quiet" disabled={context.isFetching} onClick={() => { setStatus(''); setTransferError(null); void context.refetch(); }}>重新生成</button></div></>}{transferError && <ErrorNotice error={transferError}/>}<p role="status">{status}</p></div>;
}
