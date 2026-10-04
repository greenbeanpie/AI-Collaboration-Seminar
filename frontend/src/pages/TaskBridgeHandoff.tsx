import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { bridgeApi, type BridgeState } from '../api/agent-bridges';
import type { CollaborationTask } from '../api/collaboration';
import { useSession } from '../auth';
import { ErrorNotice, Field, Spinner } from '../components/ui';
import { boundBridgeDevices, bridgeActive, bridgeHandoffsKey, preferredBridgeDevice, rememberBridgeDevice, useAgentBridge, useBridgeDevices } from './useAgentBridge';
import { useTaskAgentEligibility } from './useTaskAgentEligibility';

const labels: Record<BridgeState, string> = { checking: 'AI 正在判断任务适用性', waiting_device: '等待 DSH 接收', claimed: 'DSH 已领取任务', running: 'Agent 正在执行', waiting_input: '请在 DSH 中处理审批或输入', uploading: '正在同步成果', ready_for_review: '成果草稿待核对', blocked: '无法交给 AI 执行', failed: '执行失败', cancel_requested: '等待 DSH 确认取消', cancelled: '已取消', dispatch_uncertain: '执行状态待核对，请查看 DSH 会话' };

export function TaskBridgeHandoff({ projectId, task, children }: { projectId: string; task: CollaborationTask; children: ReactNode }) {
  const client = useQueryClient();
  const session = useSession();
  const currentActor = useRef(session.data?.id);
  useEffect(() => { currentActor.current = session.data?.id; }, [session.data?.id]);
  const devices = useBridgeDevices();
  const { handoffs, dispatch } = useAgentBridge(projectId, task, true);
  const eligibility = useTaskAgentEligibility(projectId, task);
  const bound = boundBridgeDevices(devices.data?.items, projectId);
  const [selected, setSelected] = useState(() => preferredBridgeDevice(projectId, session.data?.id));
  const deviceId = bound.some(item => item.deviceId === selected) ? selected : bound.length === 1 ? bound[0].deviceId : '';
  const [reviewed, setReviewed] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  useEffect(() => { setSelected(preferredBridgeDevice(projectId, session.data?.id)); setReviewed(false); }, [projectId, session.data?.id]);
  const lock = useRef(false);
  const item = handoffs.data?.items[0];
  const showFallback = fallbackOpen || (!devices.isPending && bound.length === 0) || (!session.data && !session.isPending);
  const stale = item && !item.adoptedSubmissionId && (item.stale || item.taskRevision !== task.revision);
  const cancel = useMutation({ retry: false, networkMode: 'always', mutationFn: async () => { const actorId = session.data?.id ?? ''; await bridgeApi.cancel(item!.handoffId, actorId); return actorId; }, onSuccess: async actorId => { if (currentActor.current === actorId) await handoffs.refetch(); } });
  const adopt = useMutation({ retry: false, networkMode: 'always', mutationFn: async () => { const actorId = session.data?.id ?? ''; await bridgeApi.adopt(item!.handoffId, task.revision, actorId); return actorId; }, onSuccess: async actorId => { if (currentActor.current !== actorId) return; setReviewed(false); await Promise.all([client.invalidateQueries({ queryKey: ['collaboration-tasks', projectId] }), client.invalidateQueries({ queryKey: ['collaboration-submissions', projectId] }), client.invalidateQueries({ queryKey: ['tasks', projectId] }), client.invalidateQueries({ queryKey: bridgeHandoffsKey(projectId, task.taskId) })]); } });
  const invalid = !eligibility.eligible || eligibility.readError || eligibility.loading || eligibility.pending || eligibility.result?.taskRevision !== task.revision || ['disabled', 'failed'].includes(eligibility.result?.status ?? '') || (eligibility.result?.status === 'ready' && eligibility.result.eligible === false);
  const send = async () => { if (lock.current || invalid || !deviceId) return; lock.current = true; setReviewed(false); try { await dispatch.mutateAsync(deviceId); } catch { /* Error rendered below. */ } finally { lock.current = false; } };
  const submit = async () => { if (lock.current || !reviewed || stale || item?.adoptedSubmissionId || task.assigneeId !== session.data?.id) return; lock.current = true; try { await adopt.mutateAsync(); } catch { /* Error rendered below. */ } finally { lock.current = false; } };
  return <div className="stack">
    <p>DSH 使用已配置的模型执行任务，完整成果回传为草稿，由你核对后提交验收。</p>
    {devices.isPending && <Spinner label="读取本地 Agent 连接" />}
    {devices.error && <ErrorNotice error={devices.error} onRetry={() => void devices.refetch()} />}
    {!devices.isPending && bound.length === 0 && <p>尚未配置可执行此项目的 DSH。可在设置中的“本地 Agent”查看安装方法和项目目录绑定，或使用下方提示词。</p>}
    {handoffs.error && <ErrorNotice error={handoffs.error} onRetry={() => void handoffs.refetch()} />}
    {item && <section className="stack" aria-label="Agent 执行进度"><strong role="status">{labels[item.state]}</strong>{item.reason && item.state !== 'blocked' && item.state !== 'checking' && <p>{item.reason}</p>}{stale && <p role="alert">任务已更新，本次成果依据旧版本生成；可保留查看，不能直接提交。</p>}{item.state === 'dispatch_uncertain' && <p>连接恢复后会核对已有会话，请勿重复执行。</p>}{item.state === 'waiting_device' && <p>保持 DSH 打开。关闭期间任务等待，重新打开后恢复接收。</p>}{bridgeActive(item) && item.state !== 'cancel_requested' && <button className="button" disabled={cancel.isPending} onClick={() => cancel.mutate()}>取消交接</button>}
      {item.result && <><Field label="成果说明"><textarea className="input" rows={6} readOnly value={item.result.summary} /></Field><ul>{item.result.artifacts.map(file => <li key={file.artifactId}><a href={`/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(file.fileId)}/content`} target="_blank" rel="noreferrer">{file.name}</a>（{file.sizeBytes} 字节）</li>)}</ul></>}
      {item.state === 'ready_for_review' && <>{task.assigneeId !== session.data?.id && <p>仅任务负责人可以提交验收；未认领任务请先在任务卡片认领。</p>}<label><input type="checkbox" checked={reviewed} disabled={Boolean(stale) || task.assigneeId !== session.data?.id || (adopt.isSuccess && adopt.data === session.data?.id) || Boolean(item.adoptedSubmissionId)} onChange={event => setReviewed(event.target.checked)} /> 我已核对成果说明及文件</label><button className="button button-primary" disabled={!reviewed || Boolean(stale) || task.assigneeId !== session.data?.id || adopt.isPending || (adopt.isSuccess && adopt.data === session.data?.id) || Boolean(item.adoptedSubmissionId) || !item.result} onClick={() => void submit()}>{adopt.isPending ? '正在提交' : (adopt.isSuccess && adopt.data === session.data?.id) || item.adoptedSubmissionId ? '已提交验收' : '采纳并提交验收'}</button></>}
    </section>}
    {bound.length > 0 && (!item || !bridgeActive(item)) && <><Field label="执行设备"><select className="input" value={deviceId} onChange={event => { setSelected(event.target.value); rememberBridgeDevice(projectId, event.target.value, session.data?.id); }}><option value="">选择设备</option>{bound.map(device => <option key={device.deviceId} value={device.deviceId}>{device.deviceName}</option>)}</select></Field><button className="button button-primary" disabled={Boolean(invalid) || !deviceId || dispatch.isPending || handoffs.isPending || Boolean(handoffs.error)} onClick={() => void send()}>{item ? '重新代实施' : '交给 DSH 代实施'}</button>{invalid && <p role="status">{eligibility.reason}</p>}</>}
    {dispatch.error && <ErrorNotice error={dispatch.error} />}{cancel.error && <ErrorNotice error={cancel.error} />}{adopt.error && <ErrorNotice error={adopt.error} />}
    <details open={showFallback} onToggle={event => setFallbackOpen(event.currentTarget.open)}><summary>手动复制或下载提示词</summary>{showFallback && children}</details>
  </div>;
}
