import { useRef, useState } from 'react';
import { adminRequest, useSession } from '../auth';
import { ErrorNotice } from '../components/ui';

type Entry = { timestamp: string; requestId: string; operation: string; phase: string; status: string; durationMs: number; errorCode: string; httpStatus?: number; configVersion?: number; expectedVersion?: number; purpose?: string; finalHost?: string; finalPath?: string; redirectHost?: string; redirectPath?: string; protocol?: string; method?: string; redirectMode?: string; failureKind?: string; exceptionType?: string };
type Report = { items: Entry[]; retention: { maxEntries: number; maxBytes: number; retainedEntries: number; retainedBytes: number } };
const operations: Record<string, string> = { config_read: '读取配置', config_save: '保存配置', config_disable: '停用 AI', probe: '连接与能力测试', model_call: '模型调用' };
const phases: Record<string, string> = { request_started: '请求开始', request_finished: '请求结束', snapshot_loaded: '已读取版本', config_persisted: '已保存版本', probe_result: '测试结果', model_result: '模型结果', fetch_received: '已收到供应商 HTTP 响应', fetch_failed: '未收到 HTTP 响应的请求异常' };
const statuses: Record<string, string> = { started: '进行中', succeeded: '成功', failed: '失败' };

export function AiDiagnosticsPanel() {
  const session = useSession();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  if (session.data?.role !== 'super_admin') return null;
  async function refresh() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    try { setReport(await adminRequest<Report>('/api/v1/admin/ai-diagnostics')); }
    catch (value) { setError(value); }
    finally { pending.current = false; setBusy(false); }
  }
  return <details className="ai-diagnostics"><summary>AI 诊断日志（仅超级管理员）</summary>
    <div className="stack">
      <p className="muted">保留最后 1000 条关键步骤，UTF-8 总大小不超过 1 MB。记录阶段、耗时和状态，不记录密钥、请求头、提示词、模型回答或个人资料。读取日志不会发起模型请求。</p>
      <button className="button button-quiet" disabled={busy} onClick={() => void refresh()}>{busy ? '正在读取诊断日志……' : '刷新诊断日志'}</button>
      {Boolean(error) && <ErrorNotice error={error} />}
      {report && <>
        <p role="status">已保留 {report.retention.retainedEntries} 条 · {report.retention.retainedBytes.toLocaleString()} / {report.retention.maxBytes.toLocaleString()} 字节 · 最新记录在前</p>
        {!report.items.length ? <p>暂无诊断记录。重试保存或测试后可刷新这里。</p> : <ol style={{ maxHeight: '28rem', overflow: 'auto', paddingInlineStart: '1.5rem' }}>{report.items.map((entry, index) => <li key={`${entry.timestamp}-${entry.requestId}-${entry.phase}-${index}`}>
          <p><strong>{operations[entry.operation] ?? 'AI 步骤'} · {phases[entry.phase] ?? '处理步骤'} · {statuses[entry.status] ?? '未知'}</strong> · {entry.durationMs} ms{entry.httpStatus !== undefined ? ` · HTTP ${entry.httpStatus}` : ''}</p>
          <p className="muted">{entry.timestamp}{entry.expectedVersion !== undefined ? ` · 提交版本 v${entry.expectedVersion}` : ''}{entry.configVersion !== undefined ? ` · 配置版本 v${entry.configVersion}` : ''}{entry.purpose ? ` · 用途 ${entry.purpose}` : ''}</p>
          {entry.finalHost && <p className="muted">请求目标：{entry.method ?? 'POST'} {entry.finalHost}{entry.finalPath} · 协议：{entry.protocol ?? '未知'}{entry.redirectMode ? ` · 跳转策略：${entry.redirectMode}（不跟随）` : ''}{entry.failureKind ? ` · 类别：${entry.failureKind}` : ''}{entry.exceptionType ? ` · 异常类型：${entry.exceptionType}` : ''}{entry.redirectHost ? ` · 被拒绝的跳转：${entry.redirectHost}${entry.redirectPath ?? ''}` : ''}</p>}
        </li>)}</ol>}
      </>}
    </div>
  </details>;
}
