import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AssessmentReportView, AssessmentWorkspacePage } from './AssessmentWorkspacePage';
import type { AssessmentReport } from '../api/simplification';
const authState = vi.hoisted(() => ({ enabled: false }));

vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p', project: { myRole: 'owner' } }) }));
vi.mock('../auth', () => ({ useCapabilities: () => ({ data: { features: { aiEnabled: authState.enabled } } }) }));
vi.mock('./FixedMaterialVersions', () => ({ FixedMaterialVersions: () => <p>固定文档选择</p> }));
vi.mock('./RehearsalsPage', () => ({ RehearsalsPage: ({ rehearsalId }: { rehearsalId?: string }) => <p>保留真实问答 {rehearsalId}</p> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear(); authState.enabled = false; });
const report: AssessmentReport = { kind: 'assistive', status: 'unscorable', weightedTotal: null, summary: '真实回答的证据不足', limitations: ['需补充现场演示证据'], scores: [{ key: 'proof', label: '论证', score: null, confidence: 'low', comment: '尚未完整回答', evidence: [{ type: 'answer', turnSequence: 2, quote: '还没有验证该结果。' }] }], requirementChecks: [{ requirementId: 'r', status: 'unknown', comment: '证据待补充', evidence: [] }] };
it('keeps an unscorable answer-based result separate from zero and identifies immutable evidence', () => {
  render(<AssessmentReportView report={report} />);
  expect(screen.getByRole('heading', { name: '本轮无法进行数值评分' })).toBeInTheDocument();
  expect(screen.getByText('论证：未评分')).toBeInTheDocument();
  expect(screen.getByText('真实回答 · 第 2 回合')).toBeInTheDocument();
  expect(screen.getByText('还没有验证该结果。')).toBeInTheDocument();
  expect(screen.queryByText(/总分：0/)).toBeNull();
});
it('routes an old rehearsal ID to its historical feedback and offers both scoring forms', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['project-goal', 'p'], { title: '共同目标', revision: 3 });
  client.setQueryData(['standards', 'p'], { items: [] });
  client.setQueryData(['assessments', 'p'], [{ assessmentId: 'old', kind: 'rehearsal', status: 'finished', historical: true, createdAt: '2026-10-01', rehearsalId: 'old', standardsVersion: null }]);
  client.setQueryData(['assessment', 'p', 'old'], { assessmentId: 'old', kind: 'rehearsal', status: 'finished', historical: true, rehearsalId: 'old', goal: null, standardsVersion: null, report: null, materialVersionIds: [] });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/assessment?section=rehearsals&rehearsalId=old']}><AssessmentWorkspacePage /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('保留真实问答 old')).toBeInTheDocument();
  expect(screen.getByText(/历史反馈：本记录未绑定/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '开始本轮答辩演练' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '材料检查' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '项目标准' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: '项目标准' })).toBeInTheDocument());
});

it('recovers a failed assessment job from server history and retries its real job after refresh', async () => {
  authState.enabled = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const assessment = { assessmentId: 'failed', kind: 'material_review', status: 'failed', goal: { title: '冻结目标', detail: '原始目标说明' }, goalRevision: 2, standardsVersionId: 's', standardsVersion: 1, materialVersionIds: ['v1'], rehearsalId: null, jobId: 'j-failed', jobError: '评分作业失败，请重试', historical: false, report: null, createdAt: '2026-10-01' };
  client.setQueryData(['project-goal', 'p'], { title: '共同目标', revision: 3 });
  client.setQueryData(['standards', 'p'], { items: [] });
  client.setQueryData(['assessments', 'p'], [assessment]);
  client.setQueryData(['assessment', 'p', 'failed'], assessment);
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { writes.push(String(url)); return Response.json({ requestId: 'retry', data: { jobId: 'j-retry' } }); }
    return Response.json({ requestId: 'job', data: { jobId: String(url).includes('j-retry') ? 'j-retry' : 'j-failed', status: String(url).includes('j-retry') ? 'running' : 'failed', attempts: 1 } });
  }));
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/assessment?section=checks&assessmentId=failed']}><AssessmentWorkspacePage /></MemoryRouter></QueryClientProvider>);
  const retry = await screen.findByRole('button', { name: '重试本轮任务' });
  expect(screen.getByText('评分作业失败，请重试')).toBeInTheDocument(); expect(retry).not.toBeDisabled();
  fireEvent.click(retry);
  await waitFor(() => expect(writes).toEqual(['/api/v1/jobs/j-failed/retry']));
  await waitFor(() => expect(JSON.parse(localStorage.getItem('ai-office:pending-assessment-job:p')!).jobId).toBe('j-retry'));
});
