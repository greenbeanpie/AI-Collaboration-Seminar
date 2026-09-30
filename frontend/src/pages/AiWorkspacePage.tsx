import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FileText, Play, RefreshCw, Send } from 'lucide-react';
import { api, ApiError, projectPath, listAllItems } from '../api/client';
import { useCapabilities } from '../auth';
import { useProject } from '../components/ProjectShell';
import { EmptyState, ErrorNotice, Field, PageHeading, SectionCard, Spinner, StatusPill } from '../components/ui';
import type { DataOf } from '../api/types';
import { clearPendingJob, completeIntent, formatWorkflowDate, idempotencyKeyForIntent, isRecord, jobStatusLabel, markdownToTiptapDoc, readPendingJob, retryBackendJob, useVisibleJobPoller, writePendingJob } from './aiWorkflowSupport';

type AgentSession = DataOf<'AgentSessionResponse'>;
type MaterialItem = DataOf<'MaterialListResponse'>['items'][number];
type PendingAgentJob = { jobId: string; entityId: string; action: string };
type AdoptionIntent = { signature: string; body: { materialId: string; expectedRevision: number; reviewed: true; doc: Record<string, unknown>; markdown: string } };

const modeOptions = [
  { value: 'do', label: '代做', detail: '生成可编辑草稿' },
  { value: 'guide', label: '带做', detail: '逐步提问并共同形成成果' },
  { value: 'review_only', label: '只审', detail: '检查已有材料并给出意见' },
] as const;

const pendingJobKey = (projectId: string) => `ai-office:pending-agent-job:${projectId}`;
const adoptionIntentKey = (projectId: string, runId: string) => `ai-office:adoption-intent:${projectId}:${runId}`;

function readAdoptionIntent(key: string): AdoptionIntent | null {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!isRecord(parsed) || typeof parsed.signature !== 'string' || !isRecord(parsed.body)) return null;
    const { materialId, expectedRevision, reviewed, doc, markdown } = parsed.body;
    if (typeof materialId !== 'string' || typeof expectedRevision !== 'number' || reviewed !== true || !isRecord(doc) || typeof markdown !== 'string') return null;
    return { signature: parsed.signature, body: { materialId, expectedRevision, reviewed, doc, markdown } };
  } catch { return null; }
}

function writeAdoptionIntent(key: string, value: AdoptionIntent | null): void {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch { /* In-memory state keeps the retry body stable during this page visit. */ }
}

export function AiWorkspacePage() {
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const capabilities = useCapabilities();
  const taskQuery = useQuery({ queryKey: ['tasks', projectId], queryFn: () => listAllItems<'TaskListResponse'>(projectPath(projectId, '/tasks'), { limit: 100 }) });
  const materialQuery = useQuery({ queryKey: ['materials', projectId], queryFn: () => listAllItems<'MaterialListResponse'>(projectPath(projectId, '/materials'), { limit: 100 }) });
  const sourceQuery = useQuery({ queryKey: ['sources', projectId], queryFn: () => listAllItems<'SourceListResponse'>(projectPath(projectId, '/sources'), { limit: 100 }) });
  const sessionListQuery = useQuery({
    queryKey: ['agentSessions', projectId],
    queryFn: () => listAllItems<'AgentSessionListResponse'>(projectPath(projectId, '/agent-sessions'), { status: 'all', limit: 100 }, { requireNextCursor: true }),
    staleTime: 10_000,
  });
  const materials = useMemo(() => materialQuery.data ?? [], [materialQuery.data]);
  const sources = useMemo(() => sourceQuery.data ?? [], [sourceQuery.data]);
  const materialVersionQueries = useQueries({ queries: materials.map((material) => ({
    queryKey: ['materialVersions', projectId, material.materialId],
    queryFn: () => listAllItems<'MaterialVersionListResponse'>(projectPath(projectId, `/materials/${encodeURIComponent(material.materialId)}/versions`), { limit: 100 }),
    staleTime: 15_000,
  })) });
  const sourceVersionQueries = useQueries({ queries: sources.filter((source) => source.currentVersionId).map((source) => ({
    queryKey: ['sourceVersion', projectId, source.sourceId, source.currentVersionId],
    queryFn: () => api.get<'SourceVersionResponse'>(projectPath(projectId, `/sources/${encodeURIComponent(source.sourceId)}/versions/${encodeURIComponent(source.currentVersionId!)}`)),
    staleTime: 30_000,
  })) });

  const [mode, setMode] = useState<'do' | 'guide' | 'review_only'>('do');
  const [roleTemplate, setRoleTemplate] = useState('项目方案撰写协作者');
  const [taskId, setTaskId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [selectedMaterialVersionIds, setSelectedMaterialVersionIds] = useState<string[]>([]);
  const [selectedSourceVersionIds, setSelectedSourceVersionIds] = useState<string[]>([]);
  const [adoptionMaterialId, setAdoptionMaterialId] = useState('');
  const [createError, setCreateError] = useState<unknown>(null);
  const [answerError, setAnswerError] = useState<unknown>(null);
  const [retryError, setRetryError] = useState<unknown>(null);
  const [retryingJob, setRetryingJob] = useState(false);
  const [answerText, setAnswerText] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [pendingAgentJob, setPendingAgentJob] = useState<PendingAgentJob | null>(() => readPendingJob<PendingAgentJob>(pendingJobKey(projectId)));

  const selectedSessionQuery = useQuery({
    queryKey: ['agentSession', projectId, selectedSessionId],
    queryFn: () => api.get<'AgentSessionResponse'>(projectPath(projectId, `/agent-sessions/${encodeURIComponent(selectedSessionId)}`)),
    enabled: Boolean(selectedSessionId),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const session = selectedSessionQuery.data as AgentSession | undefined;
  const sessionSummaries = useMemo(() => sessionListQuery.data ?? [], [sessionListQuery.data]);
  const selectedSessionSummary = sessionSummaries.find((item) => item.sessionId === selectedSessionId);
  const currentJobId = pendingAgentJob?.entityId === selectedSessionId ? pendingAgentJob.jobId : null;
  const job = useVisibleJobPoller(currentJobId);
  const aiEnabled = capabilities.data?.features.aiEnabled === true;
  const selectedMaterials = useMemo(() => materials.flatMap((material, index) => (materialVersionQueries[index]?.data ?? []).map((version) => ({
    versionId: version.versionId,
    materialId: material.materialId,
    title: material.title,
    revision: version.revision,
    current: version.versionId === material.currentVersionId,
    origin: version.origin,
    createdAt: version.createdAt,
  }))), [materials, materialVersionQueries]);
  const selectedSources = useMemo(() => sources.filter((source) => source.currentVersionId).map((source) => {
    const queryIndex = sources.filter((item) => item.currentVersionId).findIndex((item) => item.sourceId === source.sourceId);
    return { ...source, version: sourceVersionQueries[queryIndex]?.data };
  }), [sources, sourceVersionQueries]);
  const activeJobPending = Boolean(pendingAgentJob && !job.isSettled);
  const jobIsWaitingForInput = job.job?.status === 'waiting_input';
  const latestTurn = session?.turns.at(-1);
  const canAnswerGuide = latestTurn?.role === 'assistant' && latestTurn.kind === 'question';

  useEffect(() => {
    if (materials.length > 0 && !adoptionMaterialId) setAdoptionMaterialId(materials[0]?.materialId ?? '');
  }, [materials, adoptionMaterialId]);

  useEffect(() => {
    if (!selectedSessionId && sessionSummaries.length > 0) setSelectedSessionId(sessionSummaries[0]?.sessionId ?? '');
  }, [selectedSessionId, sessionSummaries]);

  useEffect(() => {
    const summary = selectedSessionSummary;
    if (!summary?.latestJobId || !['running', 'failed'].includes(summary.latestRunStatus ?? '') || pendingAgentJob?.entityId === summary.sessionId) return;
    const pending = { jobId: summary.latestJobId, entityId: summary.sessionId, action: 'resume' };
    writePendingJob(pendingJobKey(projectId), pending);
    setPendingAgentJob(pending);
  }, [pendingAgentJob?.entityId, projectId, selectedSessionSummary]);

  useEffect(() => {
    if (!job.job || !job.isSettled || !pendingAgentJob || job.job.jobId !== pendingAgentJob.jobId) return;
    if (job.job.status === 'failed' || job.job.status === 'waiting_input') return;
    if (job.job.status === 'succeeded') {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agentSession', projectId, pendingAgentJob.entityId] }),
        queryClient.invalidateQueries({ queryKey: ['materials', projectId] }),
      ]).finally(() => {
        clearPendingJob(pendingJobKey(projectId), pendingAgentJob.jobId);
        setPendingAgentJob((current) => current?.jobId === pendingAgentJob.jobId ? null : current);
      });
    } else {
      clearPendingJob(pendingJobKey(projectId), pendingAgentJob.jobId);
      setPendingAgentJob((current) => current?.jobId === pendingAgentJob.jobId ? null : current);
    }
  }, [job.job, job.isSettled, pendingAgentJob, projectId, queryClient]);

  const savePending = (sessionId: string, jobId: string, action: string) => {
    const pending = { jobId, entityId: sessionId, action };
    writePendingJob(pendingJobKey(projectId), pending);
    setPendingAgentJob(pending);
  };

  const handleRetryJob = async () => {
    if (!aiEnabled || !pendingAgentJob || job.job?.status !== 'failed' || retryingJob) return;
    setRetryingJob(true);
    setRetryError(null);
    try {
      const nextJobId = await retryBackendJob(projectId, pendingAgentJob.jobId);
      savePending(pendingAgentJob.entityId, nextJobId, pendingAgentJob.action);
    } catch (error) {
      setRetryError(error);
    } finally {
      setRetryingJob(false);
    }
  };

  const handleCreateSession = async (event: FormEvent) => {
    event.preventDefault();
    if (!aiEnabled || activeJobPending) return;
    const body = {
      mode,
      roleTemplate: roleTemplate.trim() || undefined,
      taskId: taskId || null,
      instruction: instruction.trim() || null,
      materialVersionIds: [...selectedMaterialVersionIds].sort(),
      sourceVersionIds: [...selectedSourceVersionIds].sort(),
    };
    if (mode === 'review_only' && body.materialVersionIds.length === 0) {
      setCreateError(new Error('只审模式至少选择一个材料版本。'));
      return;
    }
    setCreateError(null);
    try {
      const namespace = `agent-create:${projectId}`;
      const key = await idempotencyKeyForIntent(namespace, body);
      const result = await api.post<'AgentSessionCreateResponse'>(projectPath(projectId, '/agent-sessions'), body, { idempotencyKey: key });
      completeIntent(namespace);
      setSelectedSessionId(result.sessionId);
      savePending(result.sessionId, result.jobId, 'create');
      setAnswerText('');
      await queryClient.invalidateQueries({ queryKey: ['agentSession', projectId, result.sessionId] });
      void queryClient.invalidateQueries({ queryKey: ['agentSessions', projectId] });
    } catch (error) {
      setCreateError(error);
    }
  };

  const handleGuideAnswer = async (event: FormEvent) => {
    event.preventDefault();
    const content = answerText.trim();
    if (!session || session.capability !== 'guide' || session.status !== 'active' || !content || activeJobPending || !aiEnabled) return;
    setAnswerError(null);
    const body = { content };
    try {
      const namespace = `agent-answer:${projectId}:${session.sessionId}`;
      const key = await idempotencyKeyForIntent(namespace, body);
      const result = await api.post<'AgentTurnResponse'>(projectPath(projectId, `/agent-sessions/${encodeURIComponent(session.sessionId)}/turns`), body, { idempotencyKey: key });
      completeIntent(namespace);
      setAnswerText('');
      savePending(session.sessionId, result.jobId, 'answer');
      void queryClient.invalidateQueries({ queryKey: ['agentSession', projectId, session.sessionId] });
    } catch (error) {
      setAnswerError(error);
    }
  };

  const capabilityStatus = capabilities.isLoading
    ? <div className="ai-workflow-note">正在读取后端能力状态。状态确认前不会发起 AI 请求。</div>
    : capabilities.error
      ? <div className="ai-workflow-note is-error"><strong>无法确认后端 AI 能力。</strong> 为避免产生模拟结果，本页暂不开放生成操作。<ErrorNotice error={capabilities.error} onRetry={() => void capabilities.refetch()} /></div>
      : aiEnabled
        ? <div className="ai-workflow-note">后端真实 AI 已启用。新内容会先保存为草稿，需人工复核后才能采纳。</div>
        : <div className="ai-workflow-note is-warning"><strong>后端 AI 当前未启用。</strong> 生成和答辩辅导已停用；此处不会展示或生成模拟 AI 内容。已有真实会话仍可查看。</div>;

  const materialErrors = materialVersionQueries.filter((query) => query.error);
  const sourceErrors = sourceVersionQueries.filter((query) => query.error);
  const isLoadingInputs = taskQuery.isLoading || materialQuery.isLoading || sourceQuery.isLoading;

  return <div className="page-stack ai-workflow-layout">
    <PageHeading eyebrow="协作 / AI 工作区" title="让 AI 补上团队暂时缺少的能力" detail="选择真实任务、材料和来源版本。AI 输出始终是待复核草稿，不会自动完成任务或覆盖正式材料。" />
    {capabilityStatus}

    <div className="ai-workflow-grid">
      <SectionCard title="发起 AI 补位" detail="输入会发送至项目服务端，并由当前后端模型能力处理。">
        {isLoadingInputs ? <Spinner label="正在读取项目任务、材料和来源" /> : <form className="ai-workflow-form-grid" onSubmit={(event) => void handleCreateSession(event)}>
          <Field label="协作方式" hint="代做和带做产出草稿；只审只给出审阅意见。">
            <select className="ai-workflow-select" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
              {modeOptions.map((option) => <option key={option.value} value={option.value}>{option.label} · {option.detail}</option>)}
            </select>
          </Field>
          <Field label="AI 扮演角色" hint="作为项目上下文的一部分传给后端。">
            <input className="input" maxLength={200} value={roleTemplate} onChange={(event) => setRoleTemplate(event.target.value)} placeholder="例如：竞赛方案撰写协作者" />
          </Field>
          <Field label="关联任务" hint="可留空；选择后 AI 会依据该任务补位。">
            <select className="ai-workflow-select" value={taskId} onChange={(event) => setTaskId(event.target.value)}>
              <option value="">不关联任务</option>
              {(taskQuery.data ?? []).map((task) => <option key={task.taskId} value={task.taskId}>{task.title} · {task.status === 'done' ? '已完成' : task.status === 'doing' ? '进行中' : task.status === 'blocked' ? '受阻' : '待处理'}</option>)}
            </select>
          </Field>
          <Field label="补充说明" hint="最多 4,000 个字符。请勿提供密钥或不应发送给 AI 的内容。">
            <textarea className="input textarea ai-workflow-textarea" maxLength={4000} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="说明目标、约束、已有结论或需要重点核对的地方。" />
          </Field>
          <div className="ai-workflow-field ai-workflow-field-wide">
            <div className="field-label">材料版本 <small>选择后会传入这些不可变版本 ID；最多选择 10 个。</small></div>
            {materialQuery.error && <ErrorNotice error={materialQuery.error} onRetry={() => void materialQuery.refetch()} />}
            {materialErrors.map((query, index) => <ErrorNotice key={index} error={query.error} onRetry={() => void query.refetch()} />)}
            <div className="ai-workflow-choice-list">
              {selectedMaterials.length === 0 ? <EmptyState title="没有可选的材料版本" detail="先到材料中心创建材料并保存一个正式版本。" /> : selectedMaterials.map((version) => {
                const checked = selectedMaterialVersionIds.includes(version.versionId);
                return <label className="ai-workflow-choice" key={version.versionId}>
                  <input type="checkbox" checked={checked} disabled={!checked && selectedMaterialVersionIds.length >= 10} onChange={() => setSelectedMaterialVersionIds((current) => checked ? current.filter((id) => id !== version.versionId) : [...current, version.versionId])} />
                  <span className="ai-workflow-choice-copy"><strong>{version.title} · v{version.revision}{version.current ? '（当前）' : ''}</strong><small>{version.origin === 'ai_adoption' ? 'AI 草稿采纳' : '人工版本'} · {formatWorkflowDate(version.createdAt)} · {version.versionId}</small></span>
                </label>;
              })}
            </div>
          </div>
          <div className="ai-workflow-field ai-workflow-field-wide">
            <div className="field-label">通知与项目来源版本 <small>当前后端只提供每个来源的当前版本。</small></div>
            {sourceQuery.error && <ErrorNotice error={sourceQuery.error} onRetry={() => void sourceQuery.refetch()} />}
            {sourceErrors.map((query, index) => <ErrorNotice key={index} error={query.error} onRetry={() => void query.refetch()} />)}
            <div className="ai-workflow-choice-list">
              {selectedSources.length === 0 ? <EmptyState title="没有可选的来源版本" detail="来源导入后会在这里显示当前版本。" /> : selectedSources.map((source) => {
                const versionId = source.currentVersionId!;
                const checked = selectedSourceVersionIds.includes(versionId);
                const version = source.version;
                return <label className="ai-workflow-choice" key={versionId}>
                  <input type="checkbox" checked={checked} disabled={!checked && (selectedSourceVersionIds.length >= 10 || version?.status !== 'ready')} onChange={() => setSelectedSourceVersionIds((current) => checked ? current.filter((id) => id !== versionId) : [...current, versionId])} />
                  <span className="ai-workflow-choice-copy"><strong>{source.title} · 当前版本</strong><small>{version ? `第 ${version.revision} 版 · ${version.status === 'ready' ? '已就绪' : version.status === 'failed' ? '解析失败' : '处理中'} · ${version.charCount ?? '—'} 字符` : '正在读取来源版本'} · {versionId}</small></span>
                </label>;
              })}
            </div>
          </div>
          {Boolean(createError) && <div className="ai-workflow-field ai-workflow-field-wide"><ErrorNotice error={createError} /></div>}
          <div className="ai-workflow-actions ai-workflow-field-wide">
            <button className="button button-primary" type="submit" disabled={!aiEnabled || capabilities.isLoading || Boolean(capabilities.error) || activeJobPending || (mode === 'review_only' && selectedMaterialVersionIds.length === 0)}><Play size={15} />{activeJobPending ? '当前 AI 任务处理中' : '开始真实 AI 协作'}</button>
            {mode === 'review_only' && selectedMaterialVersionIds.length === 0 && <span className="muted">只审模式需先选择材料版本</span>}
          </div>
        </form>}
      </SectionCard>

      <SectionCard title="真实会话记录" detail="会话列表和对话内容都来自后端；选择一条真实会话 ID 后再加载其完整历史。">
        {sessionListQuery.isLoading ? <Spinner label="正在读取后端会话列表" /> : sessionListQuery.error ? <ErrorNotice error={sessionListQuery.error} onRetry={() => void sessionListQuery.refetch()} /> : sessionSummaries.length > 0 ? <div className="stack">
          <div className="ai-workflow-session-picker">
            <select className="ai-workflow-select" aria-label="选择最近的 AI 会话" value={selectedSessionId} onChange={(event) => setSelectedSessionId(event.target.value)}>
              {sessionSummaries.map((item) => <option key={item.sessionId} value={item.sessionId}>{item.title} · {modeOptions.find((option) => option.value === item.capability)?.label ?? item.capability} · {item.status === 'active' ? '进行中' : '已关闭'} · {item.sessionId}</option>)}
            </select>
            <button className="button button-quiet button-small" onClick={() => void sessionListQuery.refetch()} disabled={sessionListQuery.isFetching}><RefreshCw size={14} />刷新列表</button>
            <button className="button button-quiet button-small" onClick={() => void selectedSessionQuery.refetch()} disabled={!selectedSessionId || selectedSessionQuery.isFetching}>读取对话</button>
          </div>
          {selectedSessionSummary && <div className="ai-workflow-meta"><span>{selectedSessionSummary.title}</span><span>更新于 {formatWorkflowDate(selectedSessionSummary.updatedAt)}</span><span>最近运行 {selectedSessionSummary.latestRunStatus ?? '无'}</span><span className="mono">会话 ID {selectedSessionSummary.sessionId}</span></div>}
          {selectedSessionQuery.isLoading ? <Spinner label="正在从后端恢复会话" /> : selectedSessionQuery.error ? <ErrorNotice error={selectedSessionQuery.error} onRetry={() => void selectedSessionQuery.refetch()} /> : session ? <>
            <div className="ai-workflow-meta"><StatusPill tone={session.status === 'active' ? 'blue' : 'neutral'}>{session.status === 'active' ? '会话进行中' : '会话已关闭'}</StatusPill><span>{modeOptions.find((option) => option.value === session.capability)?.label ?? session.capability}</span><span className="mono">ID {session.sessionId}</span><span>{session.turns.length} 个对话回合</span></div>
            {currentJobId && <JobPanel jobId={currentJobId} job={job.job} error={job.error} retryError={retryError} loading={job.loading} retrying={retryingJob} canRetry={aiEnabled && !capabilities.isLoading && Boolean(!capabilities.error)} onRetry={() => void handleRetryJob()} />}
            {jobIsWaitingForInput && <div className="ai-workflow-note is-warning">此任务需要后端补充输入才能继续；请根据后端任务状态处理后再重新载入会话。</div>}
            <div className="ai-workflow-chat">
              {session.turns.map((turn) => <div className={`ai-workflow-turn ${turn.role === 'user' ? 'is-user' : 'is-assistant'}`} key={`${session.sessionId}-${turn.sequence}`}>
                <div className="ai-workflow-turn-head"><strong>{turn.role === 'user' ? '项目成员' : 'AI 助手'} · {turnLabel(turn.kind)}</strong><span>{formatWorkflowDate(turn.createdAt)}</span></div>
                {turn.kind === 'draft' && turn.runId ? <DraftReviewCard key={turn.runId} projectId={projectId} runId={turn.runId} runStatus={session.runs.find((run) => run.runId === turn.runId)?.status} payload={turn.payload} materials={materials} adoptionMaterialId={adoptionMaterialId} onTargetChange={setAdoptionMaterialId} onAdopted={() => {
                  void queryClient.invalidateQueries({ queryKey: ['agentSession', projectId, session.sessionId] });
                  void queryClient.invalidateQueries({ queryKey: ['materials', projectId] });
                }} /> : <p className="ai-workflow-turn-body">{turnText(turn.kind, turn.payload)}</p>}
              </div>)}
              {session.turns.length === 0 && <EmptyState title="会话尚无对话回合" detail="服务端尚未返回会话内容。" />}
            </div>
            {session.capability === 'guide' && session.status === 'active' && canAnswerGuide && <form className="stack" onSubmit={(event) => void handleGuideAnswer(event)}>
              <Field label="回答 AI 的问题" hint="回答保存到服务端后，AI 会生成下一步问题或阶段草稿。">
                <textarea className="input textarea ai-workflow-textarea" maxLength={8000} value={answerText} onChange={(event) => setAnswerText(event.target.value)} placeholder="结合团队实际情况回答，不确定的内容可以注明待确认。" disabled={activeJobPending || !aiEnabled} />
              </Field>
              {Boolean(answerError) && <ErrorNotice error={answerError} />}
              <div className="ai-workflow-actions"><button className="button button-primary" type="submit" disabled={!aiEnabled || !answerText.trim() || activeJobPending}><Send size={15} />提交回答</button>{!aiEnabled && <span className="muted">后端 AI 未启用，不能生成下一轮内容。</span>}</div>
            </form>}
          </> : <EmptyState title="选择一个真实会话" detail="会话内容会通过服务端返回的会话 ID 读取。" />}
        </div> : <EmptyState title="后端暂时没有 AI 会话" detail="创建成功的真实会话会出现在这个列表中；页面不会用本机记录或示例内容代替服务端历史。" />}
      </SectionCard>
    </div>

    {!isLoadingInputs && <div className="ai-workflow-meta"><FileText size={15} /><span>任务、材料与来源来自项目 API。已选择 {selectedMaterialVersionIds.length} 个材料版本、{selectedSourceVersionIds.length} 个来源版本。</span><span>来源版本选择受当前 OpenAPI 版本接口限制。</span></div>}
  </div>;
}

function DraftReviewCard({ projectId, runId, runStatus, payload, materials, adoptionMaterialId, onTargetChange, onAdopted }: { projectId: string; runId: string; runStatus?: string; payload: Record<string, unknown>; materials: MaterialItem[]; adoptionMaterialId: string; onTargetChange: (materialId: string) => void; onAdopted: () => void }) {
  const originalMarkdown = typeof payload.markdown === 'string' ? payload.markdown : '';
  const originalDoc = isRecord(payload.doc) && payload.doc.type === 'doc' ? payload.doc : null;
  const initialText = originalMarkdown || (originalDoc ? docText(originalDoc) : '');
  const [markdown, setMarkdown] = useState(initialText);
  const [edited, setEdited] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [adopted, setAdopted] = useState<{ versionId: string; revision: number } | null>(null);
  const [adoptionIntent, setAdoptionIntent] = useState<AdoptionIntent | null>(() => readAdoptionIntent(adoptionIntentKey(projectId, runId)));
  const namespace = `agent-adopt:${projectId}:${runId}`;
  const storedIntentKey = adoptionIntentKey(projectId, runId);
  const target = materials.find((material) => material.materialId === adoptionMaterialId);

  useEffect(() => {
    setMarkdown(initialText);
    setEdited(false);
    setReviewed(false);
    setAdoptionIntent(readAdoptionIntent(adoptionIntentKey(projectId, runId)));
  }, [initialText, projectId, runId]);

  const adopt = async () => {
    const selectedTarget = target;
    if (!selectedTarget || !reviewed || !markdown.trim() || adopted || saving) return;
    setSaving(true);
    setError(null);
    const doc = edited ? markdownToTiptapDoc(markdown) : originalDoc ?? markdownToTiptapDoc(markdown);
    const signature = JSON.stringify({ materialId: selectedTarget.materialId, markdown, doc });
    try {
      let intent = adoptionIntent?.signature === signature ? adoptionIntent : readAdoptionIntent(storedIntentKey);
      if (intent?.signature !== signature) {
        const latestMaterial = await api.get<'MaterialResponse'>(projectPath(projectId, `/materials/${encodeURIComponent(selectedTarget.materialId)}`));
        intent = { signature, body: { materialId: selectedTarget.materialId, expectedRevision: latestMaterial.revision, reviewed: true, doc, markdown } };
        setAdoptionIntent(intent);
        writeAdoptionIntent(storedIntentKey, intent);
      } else {
        setAdoptionIntent(intent);
      }
      const key = await idempotencyKeyForIntent(namespace, intent.body);
      const result = await api.post<'AgentAdoptResponse'>(projectPath(projectId, `/agent-runs/${encodeURIComponent(runId)}/adopt`), intent.body, { idempotencyKey: key });
      completeIntent(namespace);
      writeAdoptionIntent(storedIntentKey, null);
      setAdoptionIntent(null);
      setAdopted({ versionId: result.materialVersionId, revision: result.revision });
      onAdopted();
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'VERSION_CONFLICT') {
        completeIntent(namespace);
        writeAdoptionIntent(storedIntentKey, null);
        setAdoptionIntent(null);
        onAdopted();
        setError(new Error('目标材料在采纳前已更新。材料信息已刷新，请再次检查内容并确认；重试会使用新的期望修订号。'));
        return;
      }
      setError(reason);
    } finally {
      setSaving(false);
    }
  };

  return <div className="ai-workflow-draft">
    <div className="ai-workflow-note">AI 草稿。请检查事实、引用与缺失占位符，并自行修改后再采纳。</div>
    <div className="ai-workflow-meta"><StatusPill tone={runStatus === 'adopted' ? 'good' : 'blue'}>{runStatus === 'adopted' ? '已采纳' : '待人工复核'}</StatusPill><span>运行 ID {runId}</span>{typeof payload.title === 'string' && <strong>{payload.title}</strong>}</div>
    <Field label="草稿 Markdown" hint="编辑这里的内容会按段落、标题、列表和引用转换为 Tiptap 文档。">
      <textarea className="input textarea" maxLength={200000} value={markdown} onChange={(event) => { setMarkdown(event.target.value); setEdited(true); }} disabled={Boolean(adopted)} />
    </Field>
    <Field label="采纳到材料">
      <select className="ai-workflow-select" value={adopted ? '' : adoptionMaterialId} disabled={Boolean(adopted) || materials.length === 0} onChange={(event) => onTargetChange(event.target.value)}>
        <option value="">选择目标材料</option>
        {materials.map((material) => <option key={material.materialId} value={material.materialId}>{material.title} · 当前修订 {material.revision}</option>)}
      </select>
    </Field>
    <label className="ai-workflow-human-check"><input type="checkbox" checked={reviewed} disabled={Boolean(adopted)} onChange={(event) => setReviewed(event.target.checked)} /><span>我已人工复核并确认此内容可以进入正式材料版本。提交会创建新版本，保留材料修订校验。</span></label>
    {Boolean(error) && <ErrorNotice error={error} />}
    {adopted && <div className="ai-workflow-note"><strong>已创建正式材料版本 v{adopted.revision}。</strong><span className="mono"> 版本 ID {adopted.versionId}</span></div>}
    {!adopted && runStatus === 'adopted' && <div className="ai-workflow-note">此运行已被采纳为正式材料版本。</div>}
    <div className="ai-workflow-actions"><button className="button button-primary" onClick={() => void adopt()} disabled={!reviewed || !markdown.trim() || saving || Boolean(adopted) || runStatus !== 'succeeded' || !target}><Check size={15} />{saving ? '正在保存新版本' : adopted || runStatus === 'adopted' ? '已采纳' : '确认复核并采纳'}</button>{!adopted && runStatus !== 'adopted' && <span className="muted">采纳会创建新版本，并保留 AI 草稿与人工修改记录。</span>}</div>
  </div>;
}

function JobPanel({ jobId, job, error, retryError, loading, retrying, canRetry, onRetry }: { jobId: string; job: DataOf<'JobResponse'> | null; error: unknown; retryError: unknown; loading: boolean; retrying: boolean; canRetry: boolean; onRetry: () => void }) {
  const status = job ? jobStatusLabel(job.status) : loading ? '正在读取任务' : '等待任务状态';
  return <div className="ai-workflow-job"><RefreshCw className={job && (job.status === 'queued' || job.status === 'running') ? 'spin' : ''} size={16} /><div><strong>{status}</strong><p>后端任务 ID {jobId}{job ? ` · 第 ${job.attempts} 次执行` : ''}</p>{Boolean(error) && <p>读取状态暂时失败，页面可见时会继续重试：{error instanceof Error ? error.message : '未知错误'}</p>}{job?.status === 'failed' && <><p>后端任务已失败，失败状态已保留。</p><button className="button button-quiet button-small" onClick={onRetry} disabled={retrying || !canRetry}><RefreshCw size={13} />{retrying ? '正在重试' : canRetry ? '重试后端任务' : '后端 AI 未启用，暂不可重试'}</button></>}{Boolean(retryError) && <ErrorNotice error={retryError} />}{job?.status === 'waiting_input' && <p>后端任务在等待补充信息，当前页面不会伪造完成结果。</p>}</div></div>;
}

function turnLabel(kind: AgentSession['turns'][number]['kind']): string {
  switch (kind) {
    case 'instruction': return '请求说明';
    case 'answer': return '成员回答';
    case 'question': return 'AI 提问';
    case 'draft': return 'AI 草稿';
    case 'review_result': return 'AI 审阅结果';
  }
}

function turnText(kind: AgentSession['turns'][number]['kind'], payload: Record<string, unknown>): string {
  if (kind === 'question') return typeof payload.question === 'string' ? payload.question : '后端未返回问题内容。';
  if (kind === 'answer') return typeof payload.answer === 'string' ? payload.answer : '成员回答';
  if (kind === 'instruction') return typeof payload.instruction === 'string' ? payload.instruction : typeof payload.content === 'string' ? payload.content : '请求已发送至后端。';
  if (kind === 'draft') return typeof payload.markdown === 'string' ? payload.markdown : payload.title ? String(payload.title) : '后端未返回草稿文本。';
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  if (issues.length === 0) return '后端未返回审阅问题。';
  return issues.map((value) => {
    if (!isRecord(value)) return String(value);
    const parts = [typeof value.severity === 'string' ? value.severity : '', typeof value.title === 'string' ? value.title : '', typeof value.detail === 'string' ? value.detail : '', typeof value.suggestion === 'string' ? `建议：${value.suggestion}` : '', typeof value.quote === 'string' ? `材料依据：${value.quote}` : ''];
    return parts.filter(Boolean).join('\n');
  }).join('\n\n');
}

function docText(value: Record<string, unknown>): string {
  if (Array.isArray(value.content)) return value.content.map((node) => isRecord(node) ? nodeText(node) : '').filter(Boolean).join('\n\n');
  return '';
}

function nodeText(node: Record<string, unknown>): string {
  if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
  return Array.isArray(node.content) ? node.content.map((child) => isRecord(child) ? nodeText(child) : '').join('') : '';
}
