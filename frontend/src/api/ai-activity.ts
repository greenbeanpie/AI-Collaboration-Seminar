import type { ExecutionView } from '../api/ai-execution';
import { request } from './client';
import type { Job } from './types';

export type AiProgress = { completed: number; total?: number; unit?: string };
export type AiActivity = { code: string; updatedAt: string | null; lastResponseAt: string | null; progress: AiProgress | null; canResume: boolean; resumeReason: string | null; uncertain: boolean };
export type ActivityJob = Job & { activity?: AiActivity | null; execution?: ExecutionView | null };
export type AiActivityEvent = { id: number; code: string; state: 'started' | 'completed' | 'failed' | 'resumed'; at: string; progress: AiProgress | null };
export type ActivityEventPage = { items: AiActivityEvent[]; nextCursor: number | null };
export async function readActivityEvents(jobId: string, cursor?: number, signal?: AbortSignal, eventsPath?: string, order?: 'asc' | 'desc'): Promise<ActivityEventPage> {
  // Uses the shared authenticated transport; no offline snapshot can imply live AI execution.
  return await request<'AiActivityEventsResponse'>(eventsPath ?? `/api/v1/jobs/${encodeURIComponent(jobId)}/activity-events`, { query: { cursor, limit: 20, order }, signal, networkOnly: true });
}

const labels: Record<string, string> = {
  repairing: '正在核对并修正结果', summarizing: '总结资料', retrying: '已恢复，继续处理', queued: '等待执行', reading: '读取资料', reading_sources: '读取资料', model: '调用模型', model_request: '调用模型', calling_model: '调用模型', model_response: '已收到模型回复', tool: '执行工具', executing_tool: '执行工具', chunk: '处理分块', processing_chunk: '处理分块', ocr: '识别文档页面', transcribing: '转录音视频', validating: '校验结果', validation: '校验结果', saving: '保存结果', persisted: '结果已保存', succeeded: '已完成', completed: '已完成', failed: '执行失败', resumed: '已恢复，继续处理', waiting_input: '等待补充信息', waiting_retry: '等待重试', cancelled: '已取消', preparing: '准备资料', saving_result: '保存结果', validate_result: '校验结果', read_sources: '读取资料', model_call: '调用模型', tool_call: '执行工具', processing: '处理资料',
};
export function activityLabel(code: string): string { return labels[code] ?? '处理任务'; }
export function activityProgressText(code: string, progress: AiProgress | null | undefined): string {
  if (!progress) return '';
  const tool = ['executing_tool', 'tool', 'tool_call'].includes(code);
  if (tool && (progress.unit === 'tool_call' || progress.unit === 'step')) return `累计执行工具 ${progress.completed} 次（含失败尝试）`;
  // Old records inherited a tool count under other stages. Do not guess its meaning.
  const units: Record<string, string> = { page: '页', chunk: '块', window: '个窗口' };
  const unit = progress.unit && units[progress.unit];
  if (!unit) return '';
  return `已处理 ${progress.completed}${typeof progress.total === 'number' ? ` / ${progress.total}` : ''} ${unit}`;
}
export function activityTime(value: string | null | undefined): string {
  if (!value) return '尚未收到回复';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间不可用';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date);
}
