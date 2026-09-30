import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { CalendarDays, Check, ClipboardList, Plus, RefreshCw, UserRound } from 'lucide-react';
import { api, projectPath } from '../api/client';
import type { DataOf, Task } from '../api/types';
import { useProject } from '../components/ProjectShell';
import { EmptyState, ErrorNotice, Field, Modal, PageHeading, Spinner, StatusPill } from '../components/ui';
import { CommentsPanel, loadCursorPages } from './TasksMaterialsShared';
import './TasksMaterials.css';

type TaskListItem = DataOf<'TaskListResponse'>['items'][number];
type MemberItem = DataOf<'MemberListResponse'>['items'][number];
type RequirementItem = DataOf<'RequirementSetListResponse'>['items'][number]['requirements'][number];
type TaskStatus = Task['status'];
type StatusFilter = TaskStatus | 'all';

type TaskDraft = {
  title: string;
  detail: string;
  assigneeId: string;
  dueDate: string;
  requirementId: string;
  status: TaskStatus;
};

const statuses: { value: TaskStatus; label: string; tone: 'neutral' | 'blue' | 'warn' | 'good' }[] = [
  { value: 'todo', label: '待开始', tone: 'neutral' },
  { value: 'doing', label: '进行中', tone: 'blue' },
  { value: 'blocked', label: '遇到阻塞', tone: 'warn' },
  { value: 'done', label: '已完成', tone: 'good' },
];

function emptyTaskDraft(): TaskDraft {
  return { title: '', detail: '', assigneeId: '', dueDate: '', requirementId: '', status: 'todo' };
}

function toTaskDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    detail: task.detail,
    assigneeId: task.assigneeId ?? '',
    dueDate: task.dueDate ?? '',
    requirementId: task.requirementId ?? '',
    status: task.status,
  };
}

function TaskFields({
  draft,
  onChange,
  members,
  requirements,
  includeStatus,
}: {
  draft: TaskDraft;
  onChange: (field: keyof TaskDraft, value: string) => void;
  members: MemberItem[];
  requirements: RequirementItem[];
  includeStatus: boolean;
}) {
  return (
    <div className="tm-form-grid">
      <Field label="任务名称">
        <input required maxLength={200} value={draft.title} onChange={(event) => onChange('title', event.target.value)} placeholder="例如：整理作品介绍初稿" />
      </Field>
      {includeStatus && <Field label="状态">
        <select value={draft.status} onChange={(event) => onChange('status', event.target.value)}>
          {statuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
        </select>
      </Field>}
      <Field label="负责人">
        <select value={draft.assigneeId} onChange={(event) => onChange('assigneeId', event.target.value)}>
          <option value="">暂不分配</option>
          {members.map((member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}
        </select>
      </Field>
      <Field label="截止日期" hint="只记录日期，不补造具体时刻。">
        <input type="date" value={draft.dueDate} onChange={(event) => onChange('dueDate', event.target.value)} />
      </Field>
      <Field label="关联要求">
        <select value={draft.requirementId} onChange={(event) => onChange('requirementId', event.target.value)}>
          <option value="">暂不关联</option>
          {requirements.map((requirement) => <option key={requirement.requirementId} value={requirement.requirementId}>{requirement.title}</option>)}
        </select>
      </Field>
      <Field label="任务说明">
        <textarea rows={4} maxLength={4000} value={draft.detail} onChange={(event) => onChange('detail', event.target.value)} placeholder="补充交付内容、背景或协作约定" />
      </Field>
    </div>
  );
}

function taskBody(draft: TaskDraft) {
  return {
    title: draft.title.trim(),
    detail: draft.detail.trim(),
    assigneeId: draft.assigneeId || null,
    dueDate: draft.dueDate || null,
    duePrecision: draft.dueDate ? 'date' as const : 'unknown' as const,
    requirementId: draft.requirementId || null,
  };
}

export function TasksPage() {
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [createDraft, setCreateDraft] = useState<TaskDraft>(emptyTaskDraft);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [editDraft, setEditDraft] = useState<TaskDraft>(emptyTaskDraft);

  const tasksQuery = useQuery({
    queryKey: ['tasks', projectId, statusFilter],
    queryFn: () => loadCursorPages<TaskListItem>((cursor) => api.get<'TaskListResponse'>(
      projectPath(projectId, '/tasks'),
      { cursor, limit: 100, status: statusFilter },
    )),
  });
  const membersQuery = useQuery({
    queryKey: ['members', projectId],
    queryFn: () => api.get<'MemberListResponse'>(projectPath(projectId, '/members')),
  });
  const requirementsQuery = useQuery({
    queryKey: ['requirementSets', projectId],
    queryFn: () => api.get<'RequirementSetListResponse'>(projectPath(projectId, '/requirement-sets')),
  });
  const requirements = useMemo(() => requirementsQuery.data?.items.flatMap((set) => set.requirements) ?? [], [requirementsQuery.data]);

  const createTask = useMutation({
    mutationFn: (draft: TaskDraft) => api.post<'TaskResponse'>(projectPath(projectId, '/tasks'), taskBody(draft)),
    onSuccess: async () => {
      setShowCreate(false);
      setCreateDraft(emptyTaskDraft());
      await queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
  });
  const updateTask = useMutation({
    mutationFn: ({ taskId, expectedRevision, fields }: { taskId: string; expectedRevision: number; fields: Partial<TaskDraft> }) => {
      const { title, detail, assigneeId, dueDate, duePrecision, requirementId } = taskBody({ ...emptyTaskDraft(), ...fields });
      return api.patch<'TaskResponse'>(projectPath(projectId, `/tasks/${encodeURIComponent(taskId)}`), {
        expectedRevision,
        ...('title' in fields ? { title } : {}),
        ...('detail' in fields ? { detail } : {}),
        ...('assigneeId' in fields ? { assigneeId } : {}),
        ...('dueDate' in fields ? { dueDate, duePrecision } : {}),
        ...('requirementId' in fields ? { requirementId } : {}),
        ...('status' in fields ? { status: fields.status } : {}),
      });
    },
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['tasks', projectId] }),
    onError: async (error) => {
      if (typeof error === 'object' && error !== null && 'status' in error && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ['tasks', projectId] });
      }
    },
  });

  const openTask = (task: TaskListItem) => {
    setSelectedTask(task);
    setEditDraft(toTaskDraft(task));
    updateTask.reset();
  };

  const changeDraft = (setter: (next: TaskDraft) => void, current: TaskDraft, field: keyof TaskDraft, value: string) => {
    setter({ ...current, [field]: value });
  };

  const handleCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    createTask.mutate(createDraft);
  };

  const handleEdit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedTask) return;
    try {
      await updateTask.mutateAsync({ taskId: selectedTask.taskId, expectedRevision: selectedTask.revision, fields: editDraft });
      setSelectedTask(null);
    } catch {
      // The mutation error remains visible so a stale edit is never reported as saved.
    }
  };

  const handleStatus = (task: TaskListItem, value: string) => {
    updateTask.mutate({ taskId: task.taskId, expectedRevision: task.revision, fields: { status: value as TaskStatus } });
  };

  const memberNames = useMemo(() => new Map((membersQuery.data?.items ?? []).map((member) => [member.userId, member.displayName])), [membersQuery.data]);
  const requirementNames = useMemo(() => new Map(requirements.map((requirement) => [requirement.requirementId, requirement.title])), [requirements]);
  const tasks = tasksQuery.data ?? [];
  const completed = tasks.filter((task) => task.status === 'done').length;

  return (
    <div className="page-stack tm-page tm-tasks-page">
      <PageHeading
        eyebrow="项目协作"
        title="任务工作台"
        detail="从真实项目服务读取任务；状态、负责人、截止日期和关联要求会留在项目记录中。"
        action={<button className="button button-primary" onClick={() => { setCreateDraft(emptyTaskDraft()); createTask.reset(); setShowCreate(true); }}><Plus size={16} />新建任务</button>}
      />

      <section className="tm-task-summary" aria-label="任务概况">
        <div><span>当前筛选任务</span><strong>{tasksQuery.isLoading ? '—' : tasks.length}</strong></div>
        <div><span>已完成</span><strong>{tasksQuery.isLoading ? '—' : completed}</strong></div>
        <div><span>团队成员</span><strong>{membersQuery.data?.items.length ?? '—'}</strong></div>
      </section>

      {tasksQuery.error && <ErrorNotice error={tasksQuery.error} onRetry={() => void tasksQuery.refetch()} />}
      {membersQuery.error && <ErrorNotice error={membersQuery.error} onRetry={() => void membersQuery.refetch()} />}
      {requirementsQuery.error && <ErrorNotice error={requirementsQuery.error} onRetry={() => void requirementsQuery.refetch()} />}
      {updateTask.error && <ErrorNotice error={updateTask.error} />}

      <section className="card tm-task-board">
        <div className="tm-board-head">
          <div><span className="eyebrow">分工与跟进</span><h2><ClipboardList size={19} />项目任务</h2><p>任务状态更新使用服务端 revision 乐观锁。</p></div>
          <label className="tm-filter-label">筛选状态
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
              <option value="all">全部任务</option>
              {statuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
            </select>
          </label>
        </div>

        {tasksQuery.isLoading && <Spinner label="正在读取服务端任务" />}
        {!tasksQuery.isLoading && !tasksQuery.error && tasks.length === 0 && <EmptyState title="当前没有任务" detail="创建第一条任务，再分配负责人、截止日期并关联已提取的项目要求。" action={<button className="button button-primary" onClick={() => setShowCreate(true)}><Plus size={15} />创建任务</button>} />}
        {!!tasks.length && <div className="tm-task-list">
          {tasks.map((task) => {
            const status = statuses.find((item) => item.value === task.status) ?? statuses[0]!;
            return <article key={task.taskId} className="tm-task-row">
              <button className="tm-task-open" onClick={() => openTask(task)} aria-label={`编辑任务：${task.title}`}>
                <span className={`tm-task-check tm-check-${task.status}`}>{task.status === 'done' ? <Check size={14} /> : null}</span>
                <span className="tm-task-copy"><strong>{task.title}</strong><span>{task.detail || '尚未填写任务说明'}</span></span>
              </button>
              <div className="tm-task-meta">
                <label className="tm-status-control"><span className="tm-sr-only">更新“{task.title}”状态</span>
                  <select value={task.status} disabled={updateTask.isPending} onChange={(event) => handleStatus(task, event.target.value)} aria-label={`${task.title}状态`}>
                    {statuses.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <StatusPill tone={status.tone}>{status.label}</StatusPill>
                <span className="tm-meta-item"><UserRound size={14} />{task.assigneeId ? memberNames.get(task.assigneeId) ?? '项目成员' : '未分配'}</span>
                <span className="tm-meta-item"><CalendarDays size={14} />{task.dueDate || '无截止日期'}</span>
                {task.requirementId && <span className="tm-requirement-chip">{requirementNames.get(task.requirementId) ?? '关联要求'}</span>}
              </div>
            </article>;
          })}
        </div>}
        <div className="tm-board-footer"><span>状态筛选和任务内容均来自项目 API。</span><button className="button button-quiet button-small" onClick={() => void tasksQuery.refetch()} disabled={tasksQuery.isFetching}><RefreshCw size={14} className={tasksQuery.isFetching ? 'tm-spin' : ''} />刷新</button></div>
      </section>

      {showCreate && <Modal title="新建任务" onClose={() => setShowCreate(false)}>
        <form className="tm-modal-form" onSubmit={handleCreate}>
          <p className="tm-form-intro">任务会直接写入当前项目。负责人和要求来自后端当前记录。</p>
          <TaskFields draft={createDraft} onChange={(field, value) => changeDraft(setCreateDraft, createDraft, field, value)} members={membersQuery.data?.items ?? []} requirements={requirements} includeStatus={false} />
          {createTask.error && <ErrorNotice error={createTask.error} />}
          <div className="tm-form-actions"><button type="button" className="button button-quiet" onClick={() => setShowCreate(false)}>取消</button><button type="submit" className="button button-primary" disabled={createTask.isPending}>{createTask.isPending ? '创建中…' : '创建任务'}</button></div>
        </form>
      </Modal>}

      {selectedTask && <Modal title="编辑任务与讨论" onClose={() => setSelectedTask(null)}>
        <div className="tm-task-detail">
          <form className="tm-modal-form" onSubmit={handleEdit}>
            <p className="tm-form-intro">当前版本 r{selectedTask.revision} · 更新时会提交 expectedRevision。</p>
            <TaskFields draft={editDraft} onChange={(field, value) => changeDraft(setEditDraft, editDraft, field, value)} members={membersQuery.data?.items ?? []} requirements={requirements} includeStatus />
            {updateTask.error && <ErrorNotice error={updateTask.error} />}
            <div className="tm-form-actions"><button type="button" className="button button-quiet" onClick={() => setSelectedTask(null)}>关闭</button><button type="submit" className="button button-primary" disabled={updateTask.isPending}>{updateTask.isPending ? '保存中…' : '保存修改'}</button></div>
          </form>
          <CommentsPanel projectId={projectId} targetType="task" targetId={selectedTask.taskId} />
        </div>
      </Modal>}
    </div>
  );
}
