import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clipboard, Copy, Lightbulb, Plus, RefreshCw, UserMinus, UsersRound } from 'lucide-react';
import { api, listAllItems, projectPath } from '../api/client';
import type { Member, RequirementSet, Task } from '../api/types';
import { useCapabilities } from '../auth';
import { invitationStatus } from './invitation-status';
import { useProject } from '../components/ProjectShell';
import { ConfirmButton, EmptyState, ErrorNotice, Field, PageHeading, SectionCard, Spinner, StatusPill } from '../components/ui';

type Assignment = { taskId: string; assigneeId: string | null; reason: string; expectedRevision: number };
type AssignmentResult = { assignments: Assignment[]; considerations: string[] };
type SuggestionRequest = { requirementSetId?: string | null; taskIds?: string[] };

function parseAssignmentResult(value: unknown): AssignmentResult | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.assignments) || !Array.isArray(result.considerations)) return null;
  const assignments: Assignment[] = [];
  for (const item of result.assignments) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    if (typeof row.taskId !== 'string' || (row.assigneeId !== null && typeof row.assigneeId !== 'string') || typeof row.reason !== 'string' || !Number.isInteger(row.expectedRevision)) return null;
    assignments.push({ taskId: row.taskId, assigneeId: row.assigneeId as string | null, reason: row.reason, expectedRevision: row.expectedRevision as number });
  }
  if (!result.considerations.every((item) => typeof item === 'string')) return null;
  return { assignments, considerations: result.considerations as string[] };
}

function jobFailureMessage(value: unknown): string {
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') return value.message;
  return '分工建议任务失败。';
}

function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString('zh-CN');
}

export function TeamPage() {
  const { projectId, project } = useProject();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const membersQuery = useQuery({ queryKey: ['members', projectId], queryFn: () => listAllItems<'MemberListResponse'>(projectPath(projectId, '/members'), { limit: 100 }) });
  const meQuery = useQuery({ queryKey: ['member-me', projectId], queryFn: () => api.get<'MemberResponse'>(projectPath(projectId, '/members/me')) });
  const tasksQuery = useQuery({ queryKey: ['tasks', projectId], queryFn: () => listAllItems<'TaskListResponse'>(projectPath(projectId, '/tasks'), { limit: 100 }, { requireNextCursor: true }) });
  const requirementsQuery = useQuery({ queryKey: ['requirementSets', projectId], queryFn: () => listAllItems<'RequirementSetListResponse'>(projectPath(projectId, '/requirement-sets'), { limit: 100 }) });
  const invitationsQuery = useQuery({ queryKey: ['invitations', projectId], queryFn: () => api.get<'InvitationListResponse'>(projectPath(projectId, '/invitations')), enabled: project.myRole === 'owner' });
  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data]);
  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  const requirements = useMemo(() => requirementsQuery.data ?? [], [requirementsQuery.data]);
  const pendingTasks = tasks.filter((task) => task.status !== 'done' && !task.lifecycleState);
  const assignmentTaskLimit = capabilities.data?.limits.assignmentSuggestionMaxTasks;
  const suggestionTasks = assignmentTaskLimit ? pendingTasks.slice(0, assignmentTaskLimit) : [];
  const [majorValue, setMajorValue] = useState<string | null>(null);
  const [skillsValue, setSkillsValue] = useState<string | null>(null);
  const [hoursValue, setHoursValue] = useState<string | null>(null);
  const [maxUses, setMaxUses] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('7');
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [assignmentJobId, setAssignmentJobId] = useState('');
  const [assignmentRequirementSetId, setAssignmentRequirementSetId] = useState('');
  const [chosenAssignments, setChosenAssignments] = useState<Record<string, string>>({});
  const suggestionIntent = useRef<{ body: SuggestionRequest; key: string } | null>(null);
  const retryIntent = useRef<{ jobId: string; key: string } | null>(null);
  const applyIntentKeys = useRef(new Map<string, { assigneeId: string | null; expectedRevision: number; key: string }>());
  const [appliedTaskIds, setAppliedTaskIds] = useState<string[]>([]);

  const saveProfile = useMutation({
    mutationFn: () => api.patch<'MemberResponse'>(projectPath(projectId, '/members/me'), {
      major: (majorValue ?? meQuery.data?.major ?? '').trim(),
      skills: (skillsValue ?? (meQuery.data?.skills.join(', ') ?? '')).split(',').map((skill) => skill.trim()).filter(Boolean).slice(0, 10),
      hoursPerWeek: (hoursValue ?? (meQuery.data?.hoursPerWeek === null || meQuery.data?.hoursPerWeek === undefined ? '' : String(meQuery.data.hoursPerWeek))) === '' ? null : Number(hoursValue ?? meQuery.data?.hoursPerWeek),
    }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['member-me', projectId] }); await queryClient.invalidateQueries({ queryKey: ['members', projectId] }); },
  });
  const invite = useMutation({
    mutationFn: () => api.post<'InvitationCreateResponse'>(projectPath(projectId, '/invitations'), {
      ...(maxUses ? { maxUses: Number(maxUses) } : {}), expiresInDays: Number(expiresInDays),
    }),
    onSuccess: async (result) => { setCreatedCode(result.code); await queryClient.invalidateQueries({ queryKey: ['invitations', projectId] }); },
  });
  const revokeInvitation = useMutation({
    mutationFn: (invitationId: string) => api.delete<'InvitationRevokeResponse'>(projectPath(projectId, `/invitations/${encodeURIComponent(invitationId)}`)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invitations', projectId] }),
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => api.delete<'MemberRemoveResponse'>(projectPath(projectId, `/members/${encodeURIComponent(userId)}`)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members', projectId] }),
  });
  const leaveProject = useMutation({
    mutationFn: () => api.delete<'MemberLeaveResponse'>(projectPath(projectId, '/members/me')),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['projects'] }); window.location.assign('/app'); },
  });
  const suggestion = useMutation({
    mutationFn: (intent: { body: SuggestionRequest; key: string }) => api.post<'JobRetryResponse'>(projectPath(projectId, '/assignment-suggestions'), intent.body, { idempotencyKey: intent.key }),
    onSuccess: (data) => { suggestionIntent.current = null; setAssignmentJobId(data.jobId); setChosenAssignments({}); setAppliedTaskIds([]); },
  });
  const retrySuggestionJob = useMutation({
    mutationFn: (intent: { jobId: string; key: string }) => api.post<'JobRetryResponse'>(`/api/v1/jobs/${encodeURIComponent(intent.jobId)}/retry`, undefined, { idempotencyKey: intent.key }),
    onSuccess: (data) => { retryIntent.current = null; setAssignmentJobId(data.jobId); },
  });
  const applyAssignment = useMutation({
    mutationFn: ({ taskId, assigneeId, expectedRevision, key }: { taskId: string; assigneeId: string | null; expectedRevision: number; key: string }) => api.post<'TaskResponse'>(projectPath(projectId, '/tasks/apply-assignment'), { taskId, assigneeId, expectedRevision }, { idempotencyKey: key }),
    onSuccess: async (_result, variables) => { applyIntentKeys.current.delete(variables.taskId); setAppliedTaskIds((current) => [...new Set([...current, variables.taskId])]); await queryClient.invalidateQueries({ queryKey: ['tasks', projectId] }); },
  });

  const jobQuery = useQuery({
    queryKey: ['job', assignmentJobId],
    queryFn: () => api.get<'JobResponse'>(`/api/v1/jobs/${encodeURIComponent(assignmentJobId)}`),
    enabled: !!assignmentJobId,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      if (!assignmentJobId || document.visibilityState !== 'visible') return false;
      const status = query.state.data?.status;
      if (status && ['succeeded', 'failed', 'cancelled'].includes(status)) return false;
      return Math.min(2_000 * 2 ** Math.max(0, query.state.dataUpdateCount - 1), 10_000);
    },
  });

  const me = meQuery.data;
  const profileSkills = skillsValue ?? me?.skills.join(', ') ?? '';
  const profileHours = hoursValue ?? (me?.hoursPerWeek === null || me?.hoursPerWeek === undefined ? '' : String(me.hoursPerWeek));
  const activeInviteCount = invitationsQuery.data?.items.filter((item) => invitationStatus(item) === '有效').length ?? 0;
  const teamLimit = capabilities.data?.competitionTemplate.teamSizeLimit;
  const skillCoverage = useMemo(() => {
    const counts = new Map<string, number>();
    members.forEach((member) => member.skills.forEach((skill) => counts.set(skill, (counts.get(skill) ?? 0) + 1)));
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'));
  }, [members]);
  const assignmentResult = parseAssignmentResult(jobQuery.data?.result);
  const assignmentTasks = useMemo(() => new Map(tasks.map((task) => [task.taskId, task])), [tasks]);
  const getMemberName = (userId: string | null) => members.find((member) => member.userId === userId)?.displayName ?? '未分配';

  function requestSuggestions() {
    const body: SuggestionRequest = {
      ...(assignmentRequirementSetId ? { requirementSetId: assignmentRequirementSetId } : {}),
      taskIds: suggestionTasks.map((task) => task.taskId),
    };
    const current = suggestionIntent.current;
    const sameBody = current && JSON.stringify(current.body) === JSON.stringify(body);
    const intent = sameBody ? current : { body, key: crypto.randomUUID() };
    suggestionIntent.current = intent;
    suggestion.mutate(intent);
  }

  async function copyCode() {
    if (!createdCode) return;
    try { await navigator.clipboard.writeText(createdCode); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { setCopied(false); }
  }

  function applySuggestion(task: Task, assignment: Assignment, assigneeId: string | null) {
    const previous = applyIntentKeys.current.get(task.taskId);
    const intent = previous && previous.assigneeId === assigneeId && previous.expectedRevision === assignment.expectedRevision
      ? previous
      : { assigneeId, expectedRevision: assignment.expectedRevision, key: crypto.randomUUID() };
    applyIntentKeys.current.set(task.taskId, intent);
    applyAssignment.mutate({ taskId: task.taskId, assigneeId, expectedRevision: assignment.expectedRevision, key: intent.key });
  }

  if (membersQuery.isLoading || tasksQuery.isLoading || requirementsQuery.isLoading || meQuery.isLoading) return <Spinner label="正在读取团队和分工数据" />;
  return <div className="page-stack team-page">
    <PageHeading eyebrow="项目协作" title="团队分工" detail="依据成员登记的技能和时间安排协作；AI 建议必须由成员逐项确认后应用。" action={<StatusPill tone="blue">{members.length}{teamLimit ? ` / ${teamLimit}` : ''} 位成员</StatusPill>} />
    {[membersQuery, tasksQuery, requirementsQuery, meQuery].filter((query) => query.error).map((query, index) => <ErrorNotice key={index} error={query.error} onRetry={() => void query.refetch()} />)}
    {capabilities.error && <ErrorNotice error={capabilities.error} onRetry={() => void capabilities.refetch()} />}

    <div className="two-column">
      <SectionCard title="团队成员" detail="成员可维护自己的技能与每周可投入时间。">
        {members.length ? <div className="team-member-list">{members.map((member) => <div className="team-member" key={member.userId}>
          <span className="avatar">{member.displayName.slice(0, 1).toLocaleUpperCase()}</span>
          <div className="team-member-main"><div className="team-member-name"><strong>{member.displayName}</strong><StatusPill tone={member.role === 'owner' ? 'blue' : 'neutral'}>{member.role === 'owner' ? '负责人' : '成员'}</StatusPill></div><small>{member.email}</small><div className="chip-list">{member.skills.length ? member.skills.map((skill) => <span className="chip" key={skill}>{skill}</span>) : <span className="muted">尚未登记技能</span>}</div>{member.major && <small>专业方向：{member.major}</small>}<small>{member.hoursPerWeek === null ? '每周投入时间待填写' : `每周约 ${member.hoursPerWeek} 小时`}</small></div>
          {project.myRole === 'owner' && member.role !== 'owner' && <ConfirmButton className="icon-button" aria-label={`移除成员 ${member.displayName}`} disabled={removeMember.isPending} onClick={() => removeMember.mutate(member.userId)}><UserMinus size={17} /></ConfirmButton>}
        </div>)}</div> : <EmptyState title="暂无成员数据" detail="项目成员接口暂未返回记录。" />}
        {removeMember.error && <ErrorNotice error={removeMember.error} />}
        {project.myRole !== 'owner' && <div className="form-actions"><ConfirmButton disabled={leaveProject.isPending} onClick={() => leaveProject.mutate()}>退出项目</ConfirmButton>{leaveProject.error && <ErrorNotice error={leaveProject.error} />}</div>}
      </SectionCard>

      <SectionCard title="我的投入信息" detail="技能和可投入时间会用于分工建议；只有你可以修改自己的信息。">
        {me ? <form className="stack" onSubmit={(event) => { event.preventDefault(); saveProfile.mutate(); }}>
          <div className="profile-ident"><span className="avatar">{me.displayName.slice(0, 1).toLocaleUpperCase()}</span><div><strong>{me.displayName}</strong><small>{me.email}</small></div></div>
          <Field label="专业方向（选填）" hint="本人自愿填写，供团队协作参考，不代表能力评估。"><input className="input" maxLength={120} value={majorValue ?? me?.major ?? ''} onChange={event => setMajorValue(event.target.value)} placeholder="例如：计算机科学、视觉设计" /></Field>
          <Field label="技能关键词" hint="用逗号分隔，最多 10 项，例如：前端开发、文案、演讲。"><textarea className="input textarea" rows={3} maxLength={400} value={profileSkills} onChange={(event) => setSkillsValue(event.target.value)} placeholder="填写你愿意贡献的技能" /></Field>
          <Field label="每周可投入小时" hint="允许 0–168 小时；留空表示尚未确认。"><input className="input" type="number" min="0" max="168" step="0.5" value={profileHours} onChange={(event) => setHoursValue(event.target.value)} placeholder="例如 6" /></Field>
          {saveProfile.error && <ErrorNotice error={saveProfile.error} />}
          <button className="button button-primary" type="submit" disabled={saveProfile.isPending}>{saveProfile.isPending ? '保存中…' : '保存我的信息'}</button>
        </form> : <EmptyState title="个人成员信息不可用" detail="请重新加载或联系项目负责人确认成员权限。" />}
      </SectionCard>
    </div>

    <SectionCard title="技能覆盖" detail="根据成员主动登记的信息汇总，不代表能力评估或个人排名。">
      {skillCoverage.length ? <div className="skill-coverage">{skillCoverage.map(([skill, count]) => <div className="coverage-chip" key={skill}><span>{skill}</span><strong>{count} 人</strong></div>)}</div> : <div className="callout">目前没有成员登记技能。请团队成员在“我的投入信息”中补充。</div>}
      {teamLimit && <div className="form-note"><UsersRound size={16} />当前能力接口返回的本赛道建议人数上限为 {teamLimit} 人（不包含指导教师）；团队可在项目设置中另行维护真实成员。</div>}
    </SectionCard>

    {project.myRole === 'owner' && <SectionCard title="邀请新成员" detail="邀请码只在创建时显示一次，请复制后安全发送给受邀者。">
      {createdCode ? <div className="invite-code-box"><div><span className="eyebrow">一次性显示的邀请码</span><code>{createdCode}</code><small>离开此页后无法再次读取原码，可撤销邀请并重新生成。</small></div><button className="button button-primary" onClick={() => void copyCode()}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? '已复制' : '复制邀请码'}</button></div> : <form className="invite-form" onSubmit={(event) => { event.preventDefault(); setCreatedCode(null); invite.mutate(); }}>
        <Field label="可使用次数" hint="留空表示不按固定次数限制。"><input className="input" type="number" min="1" max="100" value={maxUses} onChange={(event) => setMaxUses(event.target.value)} placeholder="不限" /></Field>
        <Field label="有效天数"><input className="input" type="number" min="1" max="30" required value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)} /></Field>
        <button className="button button-primary" disabled={invite.isPending}><Plus size={16} />{invite.isPending ? '正在创建…' : '创建邀请码'}</button>
      </form>}
      {invite.error && <ErrorNotice error={invite.error} />}
      <p className="subtle-note">有效邀请 {activeInviteCount} 个。受邀成员需登录后提交邀请码，人数上限由后端原子校验。</p>
      {invitationsQuery.error && <ErrorNotice error={invitationsQuery.error} onRetry={() => void invitationsQuery.refetch()} />}
      {invitationsQuery.data?.items.length ? <div className="table-wrap"><table><thead><tr><th>状态</th><th>有效期至</th><th>使用次数</th><th>创建时间</th><th /></tr></thead><tbody>{invitationsQuery.data.items.map((invitation) => <tr key={invitation.invitationId}><td><StatusPill tone={invitationStatus(invitation) === '有效' ? 'good' : 'neutral'}>{invitationStatus(invitation)}</StatusPill></td><td>{displayDate(invitation.expiresAt)}</td><td>{invitation.usedCount}{invitation.maxUses ? ` / ${invitation.maxUses}` : ' / 不限'}</td><td>{displayDate(invitation.createdAt)}</td><td>{!invitation.revokedAt && <ConfirmButton className="button button-quiet button-small" disabled={revokeInvitation.isPending} onClick={() => revokeInvitation.mutate(invitation.invitationId)}>撤销</ConfirmButton>}</td></tr>)}</tbody></table></div> : invitationsQuery.isLoading ? <Spinner label="读取邀请列表" /> : <p className="muted">尚无邀请记录。</p>}
      {revokeInvitation.error && <ErrorNotice error={revokeInvitation.error} />}
    </SectionCard>}

    {project.myRole === 'owner' && <SectionCard title="AI 分工建议（普通任务）" detail="建议只供团队讨论。采用后逐条写回当前任务，负责人、状态和版本仍由后端校验。">
      {!capabilities.data ? <div className="callout">能力信息尚未加载，暂不能判断 AI 分工是否可用。</div> : !capabilities.data.features.aiEnabled ? <div className="notice notice-warn"><Lightbulb size={17} /><div className="notice-copy"><strong>后端 AI 当前未启用</strong><small>你仍可在任务页手动分配；此处不会生成模拟建议。</small></div></div> : <div className="assignment-controls">
        <Field label="参考要求集"><select className="input" value={assignmentRequirementSetId} onChange={(event) => { setAssignmentRequirementSetId(event.target.value); suggestionIntent.current = null; }}><option value="">不指定要求集</option>{requirements.filter((set) => set.status === 'confirmed').map((set: RequirementSet) => <option key={set.requirementSetId} value={set.requirementSetId}>已确认 · {set.requirementSetId.slice(0, 8)} · {set.requirements.length} 条</option>)}</select></Field>
        <button className="button button-primary" disabled={suggestion.isPending || !suggestionTasks.length || !members.length || Boolean(jobQuery.data && !['succeeded', 'failed', 'cancelled'].includes(jobQuery.data.status))} onClick={requestSuggestions}><Lightbulb size={16} />{suggestion.isPending ? '提交中…' : `为 ${suggestionTasks.length} 项未完成任务生成建议`}</button>
        {!pendingTasks.length && <p className="muted">当前没有未完成任务。</p>}
        {pendingTasks.length > suggestionTasks.length && <p className="subtle-note">后端单次最多接收 {assignmentTaskLimit ?? 0} 项分工建议，本次只提交前 {suggestionTasks.length} 项；其余 {pendingTasks.length - suggestionTasks.length} 项可在本次处理后再次发起。</p>}
        {suggestion.error && <div className="stack"><ErrorNotice error={suggestion.error} /><button className="button button-quiet button-small" disabled={suggestion.isPending || !suggestionIntent.current} onClick={() => suggestionIntent.current && suggestion.mutate(suggestionIntent.current)}><RefreshCw size={14} />使用相同请求重试</button></div>}
      </div>}
      {assignmentJobId && <div className="job-panel"><Clipboard size={17} /><div><strong>分工建议任务 · {jobQuery.data?.status ?? '正在读取'}</strong><p>{jobQuery.data?.status === 'queued' || jobQuery.data?.status === 'running' ? '后台正在处理，当前页面可继续使用。' : jobQuery.data?.status === 'failed' ? '后端任务失败；可在上方使用相同请求重试。' : jobQuery.data?.status === 'succeeded' ? '建议已生成；请逐项确认后应用。' : '正在轮询任务状态。'}</p></div>{['queued', 'running'].includes(jobQuery.data?.status ?? '') && <Spinner label="处理中" />}</div>}
      {jobQuery.error && <ErrorNotice error={jobQuery.error} onRetry={() => void jobQuery.refetch()} />}
      {jobQuery.data?.status === 'failed' && <ErrorNotice error={{ message: jobFailureMessage(jobQuery.data.error) }} />}
      {jobQuery.data?.status === 'failed' && <button className="button button-quiet button-small" disabled={retrySuggestionJob.isPending} onClick={() => {
        const current = retryIntent.current;
        const intent = current?.jobId === assignmentJobId ? current : { jobId: assignmentJobId, key: crypto.randomUUID() };
        retryIntent.current = intent;
        retrySuggestionJob.mutate(intent);
      }}><RefreshCw size={14} />{retrySuggestionJob.error ? '使用相同请求重试' : '重新运行失败任务'}</button>}
      {retrySuggestionJob.error && <ErrorNotice error={retrySuggestionJob.error} />}
      {jobQuery.data?.status === 'succeeded' && !assignmentResult && <div className="notice notice-error"><Lightbulb size={17} /><div className="notice-copy"><strong>服务端建议结果结构不符合当前契约</strong><small>为避免错误应用分工，页面未展示或写入该结果。</small></div></div>}
      {assignmentResult && <div className="assignment-list">{assignmentResult.assignments.map((assignment) => {
        const task = assignmentTasks.get(assignment.taskId);
        if (!task) return <div className="notice notice-warn" key={assignment.taskId}>任务 {assignment.taskId} 已不在当前未完成任务列表中，请刷新后重试。</div>;
        const selected = chosenAssignments[task.taskId] ?? assignment.assigneeId ?? '';
        const applied = appliedTaskIds.includes(task.taskId);
        return <div className="assignment-row" key={task.taskId}><div className="assignment-row-copy"><strong>{task.title}</strong><small>{assignment.reason || '服务端未提供理由'}</small><small>当前负责人：{getMemberName(task.assigneeId)}</small></div><Field label="建议负责人"><select className="input input-sm" value={selected} onChange={(event) => setChosenAssignments((current) => ({ ...current, [task.taskId]: event.target.value }))}><option value="">未分配</option>{members.map((member: Member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}</select></Field><button className={`button ${applied ? 'button-quiet' : 'button-primary'} button-small`} disabled={applied || applyAssignment.isPending} onClick={() => applySuggestion(task, assignment, selected || null)}>{applied ? '已应用' : '确认并应用'}</button></div>;
      })}{assignmentResult.considerations.length > 0 && <div className="callout"><strong>建议中的注意事项</strong><ul>{assignmentResult.considerations.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}</div>}
      {applyAssignment.error && <ErrorNotice error={applyAssignment.error} />}
    </SectionCard>}
  </div>;
}
