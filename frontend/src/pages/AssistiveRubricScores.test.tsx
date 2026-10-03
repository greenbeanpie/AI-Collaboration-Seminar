import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AssistiveRubricScores } from './AssistiveRubricScores';
import type { TaskSubmission } from '../api/collaboration';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });
const submission: TaskSubmission = { submissionId: 's1', taskId: 't1', round: 1, submittedBy: 'm1', body: '完成', materialVersionIds: ['v1'], criteria: '可核对成果', status: 'evaluated', aiDecision: 'improve', aiFeedback: '补充测试', decision: null, feedback: null, evaluationJobId: null, evaluationAttempts: 1, revision: 3, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', aiReport: { decision: 'improve', feedback: '补充测试', evidence: [{ materialVersionId: 'v1', quote: '已实现三个页面' }], limitations: [], coverage: 'complete', rubricScoring: { kind: 'assistive', status: 'scored', rubricVersionId: 'rubric1', rubricVersion: 2, weights: [{ key: 'quality', label: '质量', weight: 60 }, { key: 'evidence', label: '证据', weight: 40 }], weightedTotal: 76, scores: [{ key: 'quality', score: 80, confidence: 0.85, comment: '主路径实现完整', evidence: [{ materialVersionId: 'v1', quote: '已实现三个页面' }] }, { key: 'evidence', score: 70, confidence: 0.7, comment: '需补充测试', evidence: [{ materialVersionId: 'v1', quote: '已实现三个页面' }] }] } } };
function setup(owner = true) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const onChanged = vi.fn(async () => {});
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => { void url; void init; return Response.json({ data: { ...submission, revision: 4 }, requestId: 'scores' }); });
  vi.stubGlobal('fetch', fetch);
  const view = render(<QueryClientProvider client={client}><AssistiveRubricScores projectId="p1" submission={submission} owner={owner} onChanged={onChanged} /></QueryClientProvider>);
  return { client, onChanged, fetch, view };
}
it('renders assistive scores, frozen weights, confidence and evidence without calling a model', () => {
  const { fetch } = setup(false);
  expect(screen.getByText('AI 辅助总分：76.00 / 100')).toBeInTheDocument();
  expect(screen.getByText(/置信度 85%/)).toBeInTheDocument();
  expect(screen.queryByText(/不作为正式课程成绩/)).not.toBeInTheDocument();
  expect(screen.queryByText('负责人复核或调整辅助分数')).not.toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});
it('requires a reason and submits only owner score intent with the reviewed revision', async () => {
  const { fetch, onChanged } = setup();
  fireEvent.click(screen.getByText('负责人复核或调整辅助分数'));
  const save = screen.getByText('保存辅助分数复核');
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText('复核质量分数'), { target: { value: '90' } });
  fireEvent.change(screen.getByLabelText('辅助分数复核理由'), { target: { value: '补充测试已经人工核对' } });
  fireEvent.click(save);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(String(fetch.mock.calls[0]![0])).toContain('/collaboration/submissions/s1/scores');
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ expectedRevision: 3, scores: [{ key: 'quality', score: 90 }, { key: 'evidence', score: 70 }], reason: '补充测试已经人工核对' });
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
});
it('preserves a draft on newer submission revision and requires explicit reload', async () => {
  const { view, client, onChanged, fetch } = setup();
  fireEvent.click(screen.getByText('负责人复核或调整辅助分数'));
  fireEvent.change(screen.getByLabelText('复核质量分数'), { target: { value: '99' } });
  fireEvent.change(screen.getByLabelText('辅助分数复核理由'), { target: { value: '旧复核草稿' } });
  view.rerender(<QueryClientProvider client={client}><AssistiveRubricScores projectId="p1" submission={{ ...submission, revision: 4 }} owner onChanged={onChanged} /></QueryClientProvider>);
  expect(screen.getByText('保存辅助分数复核')).toBeDisabled();
  expect(screen.getByLabelText('复核质量分数')).toHaveValue(99);
  expect(screen.getByLabelText('辅助分数复核理由')).toHaveValue('旧复核草稿');
  fireEvent.click(screen.getByText('保存辅助分数复核'));
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('重新核对最新辅助评分'));
  expect(screen.getByLabelText('复核质量分数')).toHaveValue(80);
  expect(screen.getByLabelText('辅助分数复核理由')).toHaveValue('');
});
it('shows absence of confirmed rubric without invented scores', () => {
  const { view, client, onChanged } = setup();
  view.rerender(<QueryClientProvider client={client}><AssistiveRubricScores projectId="p1" submission={{ ...submission, aiReport: { ...submission.aiReport!, rubricScoring: { kind: 'assistive', status: 'unavailable', reason: '没有已确认评分标准' } } }} owner onChanged={onChanged} /></QueryClientProvider>);
  expect(screen.getByText('辅助评分不可用：没有已确认评分标准')).toBeInTheDocument();
  expect(screen.queryByText(/AI 辅助总分/)).not.toBeInTheDocument();
});
