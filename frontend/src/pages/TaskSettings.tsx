import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ApiError } from '../api/client';
import { collaborationApi, type CollaborationTask } from '../api/collaboration';
import { projectRequest, type ProjectGoal } from '../api/simplification';
import { Field, Modal } from '../components/ui';
import { mergeFields } from './task-settings-merge';

type Draft = { title: string; detail: string; criteria: string; effortHours: string; assigneeId: string; dependencies: string[] };
const draftOf = (task: CollaborationTask): Draft => ({ title: task.title, detail: task.detail, criteria: task.criteria, effortHours: String(task.effortHours), assigneeId: task.assigneeId ?? '', dependencies: [...(task.dependsOnTaskIds ?? [])].sort() });
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export type SettingsCloseGuard = RefObject<(() => Promise<boolean>) | null>;

export function TaskSettings({ projectId, task, tasks, graphRevision, canManage, meId, members, onChanged, closeGuard, stateLabel, statusContent }: {
  projectId: string; task: CollaborationTask; tasks: CollaborationTask[]; graphRevision?: number; canManage: boolean; meId?: string;
  members: { userId: string; displayName: string }[]; onChanged: () => Promise<void>; closeGuard?: SettingsCloseGuard; stateLabel: string; statusContent: ReactNode;
}) {
  const [draft, setDraft] = useState(() => draftOf(task));
  const [editing, setEditing] = useState(false), [assignmentEditing, setAssignmentEditing] = useState(false);
  const [dependenciesOpen, setDependenciesOpen] = useState(false), [statusOpen, setStatusOpen] = useState(false), [search, setSearch] = useState('');
  const [reason, setReason] = useState(''), [statusReason, setStatusReason] = useState('');
  const [notice, setNotice] = useState(''), [saving, setSaving] = useState(false), [conflicts, setConflicts] = useState<string[]>([]);
  const live = useRef({ task, base: draftOf(task), draft, graphRevision, reason, onChanged });
  const running = useRef<Promise<boolean> | null>(null);
  const blocked = useRef(false);
  const [change, setChange] = useState(0);
  useEffect(() => { live.current.onChanged = onChanged; }, [onChanged]);
  useEffect(() => {
    const current = live.current;
    // An older query response must not undo a write that has already succeeded.
    if (task.revision < current.task.revision) return;
    const latest = draftOf(task);
    const merged = mergeFields(current.base, current.draft, latest);
    current.task = task; current.base = latest; current.draft = merged.value;
    if (graphRevision !== undefined) current.graphRevision = graphRevision;
    setDraft(merged.value);
    if (merged.conflicts.length) { blocked.current = true; setConflicts(merged.conflicts); setNotice('内容已被其他人修改，请选择保留内容。'); }
  }, [task, graphRevision]);
  const update = (fields: Partial<Draft>) => {
    live.current.draft = { ...live.current.draft, ...fields }; setDraft(live.current.draft);
    if (!conflicts.length) blocked.current = false;
    setNotice('待自动保存'); setChange(value => value + 1);
  };
  const flush = useCallback((): Promise<boolean> => {
    if (running.current) return running.current;
    const execute = async () => {
      if (!canManage) return true;
      if (blocked.current) return false;
      if (equal(live.current.draft, live.current.base)) return true;
      setSaving(true);
      try {
        for (let attempt = 0; attempt < 8; attempt++) {
          const current = live.current, submitted = { ...current.draft }, base = { ...current.base };
          if (equal(submitted, base)) { setNotice('已保存'); return true; }
          const effort = Number(submitted.effortHours);
          if (!submitted.title.trim() || !submitted.criteria.trim() || !Number.isFinite(effort) || effort < .25 || effort > 200 || effort * 4 % 1 !== 0) throw new Error('请填写任务名称、验收标准及有效的预计投入（0.25 至 200 小时）。');
          if (submitted.assigneeId !== base.assigneeId && !current.reason.trim()) throw new Error('请填写分工理由，当前修改已保留。');
          try {
            const contentChanged = ['title', 'detail', 'criteria', 'effortHours'].some(key => submitted[key as keyof Draft] !== base[key as keyof Draft]);
            if (contentChanged) {
              const saved = await collaborationApi.updateTask(projectId, current.task, { title: submitted.title.trim(), detail: submitted.detail.trim(), criteria: submitted.criteria.trim(), effortHours: effort });
              current.task = { ...current.task, ...saved };
              for (const key of ['title', 'detail', 'criteria', 'effortHours'] as const) {
                const normalized = key === 'effortHours' ? String(effort) : submitted[key].trim();
                current.base[key] = normalized;
                if (current.draft[key] === submitted[key]) current.draft[key] = normalized;
              }
            }
            if (!equal(submitted.dependencies, base.dependencies)) {
              if (current.graphRevision === undefined) throw new Error('依赖图尚未加载，请稍后重试。');
              const saved = await projectRequest<{ graphRevision: number }>(projectId, `/tasks/${task.taskId}/dependencies`, { method: 'PUT', body: { expectedGraphRevision: current.graphRevision, dependsOnTaskIds: submitted.dependencies } });
              current.graphRevision = saved.graphRevision; current.base.dependencies = submitted.dependencies;
              // Dependency writes may also change task revisions; read before assigning.
              current.task = await projectRequest<CollaborationTask>(projectId, `/tasks/${task.taskId}`, { networkOnly: true });
            }
            if (submitted.assigneeId !== base.assigneeId) {
              const assignmentReason = current.reason;
              const saved = await collaborationApi.assign(projectId, current.task, submitted.assigneeId || null, assignmentReason.trim());
              current.task = { ...current.task, ...saved }; current.base.assigneeId = submitted.assigneeId;
              if (current.reason === assignmentReason && current.draft.assigneeId === submitted.assigneeId) { current.reason = ''; setReason(''); }
            }
            setDraft({ ...current.draft });
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 409) throw error;
            const latestTask = await projectRequest<CollaborationTask>(projectId, `/tasks/${task.taskId}`, { networkOnly: true });
            const goal = await projectRequest<ProjectGoal>(projectId, '/goal', { networkOnly: true });
            const latest = draftOf(latestTask), merged = mergeFields(current.base, current.draft, latest);
            current.task = latestTask; current.base = latest; current.draft = merged.value; current.graphRevision = goal.graphRevision;
            setDraft({ ...merged.value });
            if (merged.conflicts.length) { setConflicts(merged.conflicts); throw new Error('内容已被其他人修改，请选择保留内容。', { cause: error }); }
          }
        }
        throw new Error('任务持续发生变化，请稍后重试；当前修改已保留。');
      } catch (error) {
        blocked.current = true; setNotice(error instanceof Error ? error.message : '保存失败，当前修改已保留。'); return false;
      } finally { setSaving(false); await live.current.onChanged(); }
    };
    running.current = execute().catch(error => {
      blocked.current = true; setNotice(error instanceof Error ? error.message : '刷新失败，请重试。'); return false;
    }).finally(() => { running.current = null; });
    return running.current;
  }, [canManage, projectId, task.taskId]);
  useEffect(() => {
    if (!change) return;
    const timer = window.setTimeout(() => { void flush(); }, 3000);
    return () => window.clearTimeout(timer);
  }, [change, flush]);
  useEffect(() => {
    if (!closeGuard) return;
    closeGuard.current = async () => {
      do { if (!await flush()) return false; } while (!equal(live.current.draft, live.current.base));
      return true;
    };
    return () => { closeGuard.current = null; };
  }, [closeGuard, flush]);
  const statusAction = async (action: 'reopen' | 'claim') => {
    if (!await flush()) return;
    setSaving(true);
    try {
      const current = live.current;
      if (action === 'reopen') await projectRequest(projectId, `/collaboration/tasks/${task.taskId}/reopen`, { method: 'POST', body: { expectedRevision: current.task.revision, feedback: statusReason.trim() } });
      else await collaborationApi.claim(projectId, current.task);
      setStatusReason(''); await current.onChanged(); setStatusOpen(false);
    } catch (error) { setNotice(error instanceof Error ? error.message : '状态更新失败'); }
    finally { setSaving(false); }
  };
  const resolve = (useLocal: boolean) => {
    if (!useLocal) for (const key of conflicts as (keyof Draft)[]) Object.assign(live.current.draft, { [key]: live.current.base[key] });
    blocked.current = false; setConflicts([]); setDraft({ ...live.current.draft }); setChange(value => value + 1); setNotice('待自动保存');
  };
  const editable = canManage && editing;
  return <section className="stack task-settings" aria-label="任务设置" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void flush(); }}>
    <div className="stack" hidden={dependenciesOpen}>
    <div className="task-settings-heading"><span>任务状态：</span><span className={`task-settings-status task-settings-status-${task.lifecycleState}`}>{stateLabel}</span><button className="button button-quiet button-small" onClick={async () => { if (await flush()) setStatusOpen(true); }}>更新</button></div>
    <div className="task-settings-heading"><h3>任务内容</h3>{canManage && <button className="button button-quiet button-small" onClick={() => setEditing(value => !value)}>修改任务内容</button>}</div>
    <div className="task-settings-title-row"><Field label="任务名称">{editable ? <input className="input" maxLength={200} value={draft.title} onChange={event => update({ title: event.target.value })}/> : <p>{draft.title}</p>}</Field><Field label="预计投入（小时）">{editable ? <input className="input" type="number" min="0.25" max="200" step="0.25" value={draft.effortHours} onChange={event => update({ effortHours: event.target.value })}/> : <p>{draft.effortHours}</p>}</Field></div>
    <Field label="任务说明">{editable ? <textarea className="input" rows={3} maxLength={4000} value={draft.detail} onChange={event => update({ detail: event.target.value })}/> : <p className="collab-preserve">{draft.detail || '暂无任务说明'}</p>}</Field>
    <Field label="验收标准">{editable ? <textarea className="input" rows={4} maxLength={4000} value={draft.criteria} onChange={event => update({ criteria: event.target.value })}/> : <p className="collab-preserve">{draft.criteria}</p>}</Field>
    <div className="task-settings-heading"><h3>前置依赖</h3>{canManage && <button className="button button-quiet button-small" onClick={() => { setSearch(''); setDependenciesOpen(true); }}>修改前置任务</button>}</div>
    <p>{tasks.filter(item => draft.dependencies.includes(item.taskId)).map(item => item.title).join('、') || '无前置任务'}</p>
    {!!task.unfinishedDependencyIds?.length && <p className="notice notice-warn">尚有未完成的前置任务；可以提前认领、执行和提交。</p>}
    <div className="task-settings-heading"><h3>安排分工</h3>{canManage && <button className="button button-quiet button-small" onClick={() => setAssignmentEditing(value => !value)}>修改分工</button>}</div>
    {canManage && assignmentEditing ? <><Field label="任务执行人"><select className="input" value={draft.assigneeId} onChange={event => update({ assigneeId: event.target.value })}><option value="">暂不分配</option>{members.map(member => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}</select></Field><Field label="分工理由"><textarea className="input" maxLength={2000} value={reason} onChange={event => { live.current.reason = event.target.value; setReason(event.target.value); blocked.current = conflicts.length > 0; setChange(value => value + 1); }}/></Field>{task.lifecycleState === 'submitted' && <p className="notice notice-warn">重新分配会撤回当前提交并使待处理评价失效，历史保留。</p>}</> : <p>{members.find(member => member.userId === draft.assigneeId)?.displayName ?? (draft.assigneeId ? '项目成员' : '暂不分配')}</p>}
    {!!task.citations?.length && <section><h3>任务来源原文依据</h3>{task.citations.map((citation, index) => <p className="collab-preserve" key={index}>固定来源 {citation.sourceVersionId}{citation.pageNumber ? ` · 第${citation.pageNumber}页` : ''}：{citation.quote}{citation.availability === 'unavailable' && <small> · 原始来源不可用，历史引文保留</small>}</p>)}</section>}
    </div>
    {(notice || saving) && <p role="status">{saving ? '保存中…' : notice}</p>}
    {!!conflicts.length && <div className="notice notice-warn"><p>存在冲突的字段：{conflicts.map(key => ({ title: '任务名称', detail: '任务说明', criteria: '验收标准', effortHours: '预计投入', assigneeId: '任务执行人', dependencies: '前置依赖' })[key as keyof Draft]).join('、')}</p><p>最新内容：{conflicts.map(key => { const value = live.current.base[key as keyof Draft]; return Array.isArray(value) ? tasks.filter(item => value.includes(item.taskId)).map(item => item.title).join('、') : String(value); }).join('；')}</p><button className="button" onClick={() => resolve(true)}>保留我的修改</button><button className="button button-quiet" onClick={() => resolve(false)}>使用最新内容</button></div>}
    {!!notice && !conflicts.length && blocked.current && <button className="button button-quiet" onClick={() => { blocked.current = false; void flush(); }}>重试</button>}
    {dependenciesOpen && <Modal title={`前置任务·${task.title}`} mode="page" onClose={async () => { if (await flush()) setDependenciesOpen(false); }}><Field label="搜索任务"><input className="input" value={search} onChange={event => setSearch(event.target.value)}/></Field><fieldset><legend>选择前置任务</legend>{tasks.filter(item => item.taskId !== task.taskId && item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(item => <label className="collab-version" key={item.taskId}><input type="checkbox" checked={draft.dependencies.includes(item.taskId)} onChange={event => update({ dependencies: (event.target.checked ? [...draft.dependencies, item.taskId] : draft.dependencies.filter(id => id !== item.taskId)).sort() })}/>{item.title}</label>)}</fieldset></Modal>}
    {statusOpen && <Modal title={`更新任务状态·${task.title}`} onClose={() => setStatusOpen(false)}>{!task.assigneeId && task.lifecycleState === 'open' && meId && <button className="button" disabled={saving} onClick={() => void statusAction('claim')}>我来认领</button>}{canManage && task.lifecycleState === 'accepted' && <><Field label="重新打开理由"><textarea className="input" maxLength={4000} value={statusReason} onChange={event => setStatusReason(event.target.value)}/></Field><button className="button" disabled={saving || !statusReason.trim()} onClick={() => void statusAction('reopen')}>重新打开任务</button></>}{statusContent}</Modal>}
  </section>;
}
