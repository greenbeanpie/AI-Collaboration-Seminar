import { useEffect, useRef, useState } from 'react';
import { request } from '../api/client';
import { completeIntent, idempotencyKeyForIntent } from '../pages/aiWorkflowSupport';
import { ErrorNotice } from './ui';

import { executionOf, type ExecutionView } from '../api/ai-execution';
const reasons: Record<string, string> = { request_uncertain: '模型请求已发出，但响应结果未知', output_invalid: '当前结果未通过校验，进度已保留', interrupted: '处理已中断，进度已保留', round_limit: '已达到本窗口调用上限', window_limit: '已达到本窗口调用上限', model_call_limit: '已达到本窗口调用上限', request_unknown: '模型请求已发出，但响应结果未知', result_unknown: '模型请求已发出，但响应结果未知' };
const states = { running: '处理中', paused: '已暂停', finalizing: '正在输出当前结果', cancelled: '已取消', completed: '已完成' };
export function ExecutionControlPanel({ execution, path, enabled = true, onUpdated, onBeforeAction }: { execution?: ExecutionView | null; path: string; enabled?: boolean; onUpdated: (snapshot: unknown) => void | Promise<void>; onBeforeAction?: () => void }) {
  const [pending, setPending] = useState(false), [error, setError] = useState<unknown>(null);
  const lock = useRef(false), current = useRef({ execution, path, onUpdated });
  current.current = { execution, path, onUpdated };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!execution) return null;
  const act = async (action: 'continue' | 'output' | 'cancel') => {
    if (lock.current || !enabled) return;
    const generation = execution.generation, actionPath = path;
    lock.current = true; setPending(true); setError(null); onBeforeAction?.();
    const namespace = `execution:${path}:${generation}:${action}`;
    try {
      const body = { expectedGeneration: generation, ...(execution.pauseReason === 'request_uncertain' && action !== 'cancel' ? { allowUncertainDispatch: true } : {}) };
      const idempotencyKey = await idempotencyKeyForIntent(namespace, body);
      const snapshot = await request(`${path}/execution/${action}`, { method: 'POST', body, idempotencyKey, networkOnly: true });
      completeIntent(namespace);
      if (!mounted.current || current.current.path !== actionPath || (current.current.execution?.generation ?? generation) > (executionOf(snapshot)?.generation ?? generation)) return;
      await current.current.onUpdated(snapshot);
    } catch (failure) { if (mounted.current && current.current.path === actionPath) setError(failure); }
    finally { lock.current = false; if (mounted.current) setPending(false); }
  };
  return <section className="callout" aria-label="AI 持续处理控制"><p role="status" aria-live="polite">已处理 {execution.windowCalls} 轮 / {execution.limit} 轮 · 累计 {execution.totalCalls} 轮 · {states[execution.state]}</p>
    {execution.pauseReason && <p>{reasons[execution.pauseReason] ?? execution.pauseReason}</p>}
    <div className="form-actions">{execution.canContinue && <button type="button" className="button button-primary" disabled={pending || !enabled} onClick={() => void act('continue')}>继续处理</button>}{execution.canOutput && <button type="button" className="button button-quiet" disabled={pending || !enabled} onClick={() => void act('output')}>输出当前结果</button>}{!['completed', 'cancelled'].includes(execution.state) && <button type="button" className="button button-quiet" disabled={pending || !enabled} onClick={() => void act('cancel')}>取消处理</button>}</div>
    {execution.pauseReason === 'request_uncertain' && <p className="muted">上次请求是否完成尚不明确；点击继续或输出将允许重新请求未完成步骤，可能再次产生用量。</p>}{execution.canOutput && <p className="muted">输出将使用已保存的资料，可能额外调用一次模型；结果通过校验后才会保存。</p>}{pending && <p role="status">正在更新处理状态…</p>}{error !== null && <ErrorNotice error={error} />}
  </section>;
}
