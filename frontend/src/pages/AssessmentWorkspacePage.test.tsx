import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AssessmentReportView, AssessmentWorkspacePage } from './AssessmentWorkspacePage';
import type { AssessmentReport } from '../api/simplification';

vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p', project: { myRole: 'owner' } }) }));
vi.mock('../auth', () => ({ useCapabilities: () => ({ data: { features: { aiEnabled: false } } }) }));
vi.mock('./FixedMaterialVersions', () => ({ FixedMaterialVersions: () => <p>固定文档选择</p> }));
vi.mock('./RehearsalsPage', () => ({ RehearsalsPage: ({ rehearsalId }: { rehearsalId?: string }) => <p>保留真实问答 {rehearsalId}</p> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });
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
