import { ProjectSectionNavigation } from '../components/ProjectNavigation';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AssessmentReportView, AssessmentWorkspacePage } from './AssessmentWorkspacePage';
import type { Assessment, AssessmentReport } from '../api/simplification';
const authState = vi.hoisted(() => ({ enabled: false }));

vi.mock('../components/ProjectShell', () => ({ useProject: () => ({ projectId: 'p', project: { myRole: 'owner' } }) }));
vi.mock('../auth', () => ({ useCapabilities: () => ({ data: { features: { aiEnabled: authState.enabled } } }), useSession: () => ({ data: { id: 'user' } }) }));
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
  client.setQueryData(['standards', 'p'], { items: [] }); client.setQueryData(['current-standard', 'p'], { standard: null });
  client.setQueryData(['assessments', 'p', 'pages', { kind: 'material_review' }, ''], { pages: [{ items: [{ assessmentId: 'old', kind: 'rehearsal', status: 'finished', historical: true, createdAt: '2026-10-01', rehearsalId: 'old', standardsVersion: null }], nextCursor: null }], pageParams: [null] });
  client.setQueryData(['assessments', 'p', 'pages', { kind: 'rehearsal' }, ''], { pages: [{ items: [{ assessmentId: 'old', kind: 'rehearsal', status: 'finished', historical: true, createdAt: '2026-10-01', rehearsalId: 'old', standardsVersion: null }], nextCursor: null }], pageParams: [null] });
  client.setQueryData(['assessment', 'p', 'old'], { assessmentId: 'old', kind: 'rehearsal', status: 'finished', historical: true, rehearsalId: 'old', goal: null, standardsVersion: null, report: null, materialVersionIds: [] });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/app/projects/p/assessment?section=rehearsals&rehearsalId=old']}><ProjectSectionNavigation projectId="p" canManage/><AssessmentWorkspacePage /></MemoryRouter></QueryClientProvider>);
  expect(await screen.findByText('保留真实问答 old')).toBeInTheDocument();
  expect(screen.getByText(/历史反馈：本记录未绑定/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '开始本轮答辩演练' })).toBeDisabled();
  expect(screen.getByRole('link', { name: '材料检查' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: '项目标准' }));
  await waitFor(() => expect(screen.getByRole('heading', { name: '项目标准' })).toBeInTheDocument());
});

it('recovers a failed assessment job from server history and retries its real job after refresh', async () => {
  authState.enabled = true;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const assessment = { assessmentId: 'failed', kind: 'material_review', status: 'failed', goal: { title: '冻结目标', detail: '原始目标说明' }, goalRevision: 2, standardsVersionId: 's', standardsVersion: 1, materialVersionIds: ['v1'], rehearsalId: null, jobId: 'j-failed', jobError: '评分作业失败，请重试', historical: false, report: null, createdAt: '2026-10-01' };
  client.setQueryData(['project-goal', 'p'], { title: '共同目标', revision: 3 });
  client.setQueryData(['standards', 'p'], { items: [] }); client.setQueryData(['current-standard', 'p'], { standard: { standardsVersionId: 's', title: '规则', version: 1, rubric: { weights: [] } } });
  client.setQueryData(['assessments', 'p', 'pages', { kind: 'material_review' }, ''], { pages: [{ items: [assessment], nextCursor: null }], pageParams: [null] });
  client.setQueryData(['assessments', 'p', 'pages', { kind: 'rehearsal' }, ''], { pages: [{ items: [assessment], nextCursor: null }], pageParams: [null] });
  client.setQueryData(['assessment', 'p', 'failed'], assessment);
  const writes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') { writes.push(String(url)); return Response.json({ requestId: 'retry', data: { jobId: 'j-retry' } }); }
    return Response.json({ requestId: 'job', data: { jobId: String(url).includes('j-retry') ? 'j-retry' : 'j-failed', status: String(url).includes('j-retry') ? 'running' : 'failed', activity:{code:'failed',updatedAt:null,lastResponseAt:null,progress:null,canResume:true,resumeReason:null,uncertain:false}, attempts: 1 } });
  }));
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/assessment?section=checks&assessmentId=failed']}><AssessmentWorkspacePage /></MemoryRouter></QueryClientProvider>);
  const retry = await screen.findByRole('button', { name: '从停止处继续' });
  expect(screen.getByText('评分作业失败，请重试')).toBeInTheDocument(); expect(retry).not.toBeDisabled();
  fireEvent.click(retry);
  await waitFor(() => expect(writes).toEqual(['/api/v1/jobs/j-failed/retry']));
  await waitFor(() => expect(JSON.parse(localStorage.getItem('ai-office:account:user:pending-assessment-job:p')!).jobId).toBe('j-retry'));
});

const aliases = ['assessmentId', 'reviewId', 'rehearsalId', 'review', 'rehearsal'];
it('labels completed unscorable history separately from a scored result',async()=>{
  showRecords([record('empty','material_review'),record('scored','material_review','succeeded',{report:{...report,status:'scored',weightedTotal:80}})],'/assessment?section=checks&assessmentId=empty');
  expect(await screen.findByText('已完成 · 无法评分 · 标准 v1')).toBeInTheDocument();
  expect(screen.getByText('已评分 · 标准 v1')).toBeInTheDocument();
  expect(screen.queryByText(/succeeded/)).toBeNull();
});
function LocationProbe() { const location = useLocation(); return <output data-testid="location">{location.search}</output>; }
function record(id: string, kind: Assessment['kind'], status = 'succeeded', extra: Partial<Assessment> = {}): Assessment {
  return { assessmentId: id, kind, status, goal: { projectId:'p', title: id + '-goal', detail: '', revision:1, graphRevision:1 }, goalRevision:1, standardsVersionId:'s', standardsVersion:1, materialVersionIds:[], rehearsalId:kind === 'rehearsal' ? id + '-session' : null, report: { ...report, summary:id + '-summary' }, createdAt:'2026-10-03T00:00:00Z', historical:false, canOperate:true, ...extra };
}
function showRecords(records: Assessment[], entry: string) {
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
  client.setQueryData(['project-goal','p'],{title:'共同目标',revision:1});
  client.setQueryData(['standards','p'],{items:[]});client.setQueryData(['current-standard','p'],{standard:{standardsVersionId:'s',title:'生效规则',version:1,rubric:{weights:[]}}});
  for (const kind of ['material_review', 'rehearsal']) client.setQueryData(['assessments','p', 'pages', { kind }, ''], { pages: [{ items: records, nextCursor: null }], pageParams: [null] });
  for (const item of records) client.setQueryData(['assessment','p',item.assessmentId],item);
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry.replace(/^\/assessment/, '/app/projects/p/assessment')]}><ProjectSectionNavigation projectId="p" canManage/><AssessmentWorkspacePage/><LocationProbe/></MemoryRouter></QueryClientProvider>);
  return client;
}
it('clears every selection alias when switching kind and renders only the matching scoring form',async()=>{
  const material=record('material','material_review'), rehearsal=record('rehearsal','rehearsal');
  showRecords([material,rehearsal],'/assessment?section=checks&assessmentId=material&reviewId=old&rehearsalId=other&review=legacy&rehearsal=legacy-session');
  expect(await screen.findByText('material-summary',{selector:'p'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('link',{name:'答辩演练'}));
  expect(await screen.findByText('rehearsal-summary',{selector:'p'})).toBeInTheDocument();
  expect(screen.queryByText('material-summary')).toBeNull();
  const query=new URLSearchParams(screen.getByTestId('location').textContent!);
  for (const key of aliases) expect(query.has(key)).toBe(false);
});
it.each(['assessmentId','reviewId','rehearsalId','review','rehearsal'])('rejects a wrong-kind %s deep link and falls back without displaying or fetching its detail',async alias=>{
  const material=record('wrong','material_review'), rehearsal=record('right','rehearsal');
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  showRecords([material,rehearsal],`/assessment?section=rehearsals&${alias}=wrong`);
  expect(await screen.findByText('right-summary',{selector:'p'})).toBeInTheDocument();
  expect(screen.queryByText('wrong-summary')).toBeNull();
  expect(screen.queryByText('wrong-goal')).toBeNull();
  expect(fetch.mock.calls.every(([url]) => String(url).includes('/assessments?'))).toBe(true);
  await waitFor(()=>expect(new URLSearchParams(screen.getByTestId('location').textContent!).get('assessmentId')).toBe('right'));
});
it('maps a valid rehearsal session deep link to the correct assessment record',async()=>{
  showRecords([record('material','material_review'),record('right','rehearsal')],'/assessment?section=rehearsals&rehearsalId=right-session');
  expect(await screen.findByText('right-summary',{selector:'p'})).toBeInTheDocument();
  await waitFor(()=>expect(new URLSearchParams(screen.getByTestId('location').textContent!).get('assessmentId')).toBe('right'));
});
it('ignores a legacy failed pending job for another entity while viewing successful history',async()=>{
  localStorage.setItem('ai-office:account:user:pending-assessment-job:p',JSON.stringify({entityId:'other',jobId:'other-failed',action:'create'}));
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  showRecords([record('saved','material_review')],'/assessment?section=checks&assessmentId=saved');
  expect(await screen.findByText('saved-summary',{selector:'p'})).toBeInTheDocument();
  expect(screen.queryByText(/本轮评分任务/)).toBeNull();
  expect(screen.queryByRole('button',{name:'从停止处继续'})).toBeNull();
  expect(fetch.mock.calls.every(([url]) => String(url).includes('/assessments?'))).toBe(true);
});
it('keeps a saved score authoritative when its original job failed and explains that failure as history',async()=>{
  const saved=record('saved','material_review','succeeded',{jobId:'original-failed',jobError:'评分作业失败，请重试'});
  localStorage.setItem('ai-office:account:user:pending-assessment-job:p',JSON.stringify({entityId:'saved',jobId:'original-failed',action:'create'}));
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  showRecords([saved],'/assessment?section=checks&assessmentId=saved');
  expect(await screen.findByText('saved-summary',{selector:'p'})).toBeInTheDocument();
  expect(screen.getByText('本轮评分已保存；原作业曾失败，此历史提示不影响已保存评分。')).toBeInTheDocument();
  expect(screen.queryByText('评分未完成，服务端失败状态与已有证据已保留。')).toBeNull();
  expect(screen.queryByRole('button',{name:'从停止处继续'})).toBeNull();
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/jobs/original-failed'))).toBe(true);
});
it('retries only the selected real failure even when another kind owns the old local pending job',async()=>{
  authState.enabled=true;
  const failed=record('failed','material_review','failed',{jobId:'current-failed',report:null});
  localStorage.setItem('ai-office:account:user:pending-assessment-job:p',JSON.stringify({entityId:'other-rehearsal',jobId:'foreign-failed',action:'create'}));
  const requests:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:unknown,init?:RequestInit)=>{
    const path=String(url);requests.push(path);
    if(init?.method==='POST')return Response.json({data:{jobId:'current-retry'}});
    if(path.includes('/jobs/'))return Response.json({data:{jobId:path.endsWith('current-retry')?'current-retry':'current-failed',status:path.endsWith('current-retry')?'running':'failed',activity:{code:'failed',updatedAt:null,lastResponseAt:null,progress:null,canResume:true,resumeReason:null,uncertain:false},attempts:1}});
    if(path.includes('/assessments/failed'))return Response.json({data:failed});
    return Response.json({data:{items:[failed],nextCursor:null}});
  }));
  showRecords([failed,record('other-rehearsal','rehearsal')],'/assessment?section=checks&assessmentId=failed');
  fireEvent.click(await screen.findByRole('button',{name:'从停止处继续'}));
  await waitFor(()=>expect(requests).toContain('/api/v1/jobs/current-failed/retry'));
  expect(requests.some(path=>path.includes('foreign-failed'))).toBe(false);
  await waitFor(()=>expect(JSON.parse(localStorage.getItem('ai-office:account:user:pending-assessment-job:p')!)).toMatchObject({entityId:'failed',jobId:'current-retry',kind:'material_review',previousJobId:'current-failed'}));
});
it('continues reading the selected running record after refresh without a local pending entry',async()=>{
  const running=record('running','material_review','running',{jobId:'current-running',report:null});
  const fetch=vi.fn(async()=>Response.json({data:{jobId:'current-running',status:'running',activity:{code:'failed',updatedAt:null,lastResponseAt:null,progress:null,canResume:true,resumeReason:null,uncertain:false},attempts:1}}));vi.stubGlobal('fetch',fetch);
  showRecords([running],'/assessment?section=checks&assessmentId=running');
  expect(await screen.findByText('AI 处理中')).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith('/api/v1/jobs/current-running',expect.any(Object));
  expect(screen.queryByRole('button',{name:'从停止处继续'})).toBeNull();
});

it('shows no foreign detail or correction when a deep link has no record of the current kind',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  showRecords([record('foreign','material_review')],'/assessment?section=rehearsals&assessmentId=foreign');
  expect(await screen.findByText('尚无此形式的评分记录')).toBeInTheDocument();
  expect(screen.queryByText('foreign-goal')).toBeNull();
  expect(screen.queryByRole('heading',{name:'修正本轮评分'})).toBeNull();
  expect(fetch.mock.calls.every(([url]) => String(url).includes('/assessments?'))).toBe(true);
});
it('keeps a retry response attached to its originating record after selection changes',async()=>{
  authState.enabled=true;
  const failed=record('failed','material_review','failed',{jobId:'failed-job',report:null}),saved=record('saved','material_review');
  let releaseRetry: ((response: Response) => void) | undefined;
  const retryResponse=new Promise<Response>(resolve=>{releaseRetry=resolve;});
  const writes:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:unknown,init?:RequestInit)=>{
    const path=String(url);
    if(init?.method==='POST'){writes.push(path);return retryResponse;}
    if(path.includes('/jobs/'))return Response.json({data:{jobId:'failed-job',status:'failed',activity:{code:'failed',updatedAt:null,lastResponseAt:null,progress:null,canResume:true,resumeReason:null,uncertain:false},attempts:1}});
    if(path.endsWith('/assessments/failed'))return Response.json({data:failed});
    return Response.json({data:{items:[failed,saved],nextCursor:null}});
  }));
  showRecords([failed,saved],'/assessment?section=checks&assessmentId=failed');
  fireEvent.click(await screen.findByRole('button',{name:'从停止处继续'}));
  await waitFor(()=>expect(writes).toEqual(['/api/v1/jobs/failed-job/retry']));
  fireEvent.click(screen.getAllByRole('button',{name:/材料检查 ·/}).find(button => !button.classList.contains('active'))!);
  expect(await screen.findByText('saved-summary',{selector:'p'})).toBeInTheDocument();
  releaseRetry!(Response.json({data:{jobId:'retried-job'}}));
  await waitFor(()=>expect(JSON.parse(localStorage.getItem('ai-office:account:user:pending-assessment-job:p')!)).toMatchObject({entityId:'failed',jobId:'retried-job'}));
  expect(screen.queryByRole('button',{name:'从停止处继续'})).toBeNull();
  expect(screen.queryByText(/本轮评分任务/)).toBeNull();
});

it('creates scoring using the server effective standard without a standard selection or version override', async () => {
  authState.enabled = true;
  const writes: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === 'POST') writes.push(JSON.parse(String(init.body)));
    return Response.json({ requestId:'r', data: init?.method === 'POST' ? { assessmentId:'new', jobId:'new-job' } : { items:[], nextCursor:null } });
  }));
  showRecords([], '/assessment?section=checks');
  expect(screen.getByText('生效标准：生效规则 · v1')).toBeInTheDocument();
  expect(screen.queryByRole('combobox',{name:/标准/})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'开始本轮材料检查'}));
  await waitFor(()=>expect(writes).toHaveLength(1));
  expect(writes[0]).toMatchObject({kind:'material_review', goalRevision:1});
  expect(writes[0]).not.toHaveProperty('standardsVersionId');
  expect(writes[0]).not.toHaveProperty('rubricVersionId');
});

it('places running AI activity below initiation settings beside history', async () => {
  const running = record('running', 'material_review', 'running', { jobId: 'running-job', report: null });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { jobId: 'running-job', status: 'running', activity: { code: 'repairing', updatedAt: null, lastResponseAt: null, progress: null, canResume: false, uncertain: false } } })));
  showRecords([running], '/assessment?section=checks&assessmentId=running');
  const activity = await screen.findByRole('region', { name: 'AI 处理状态' });
  const column = activity.closest('.assessment-initiation-column')!;
  expect(column).toContainElement(screen.getByRole('heading', { name: '发起成果检查' }));
  expect(column).not.toContainElement(screen.getByRole('heading', { name: '独立评分记录' }));
  expect(screen.getByRole('button', { name: '开始本轮材料检查' }).compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getAllByRole('region', { name: 'AI 处理状态' })).toHaveLength(1);
  expect(screen.getByText('正在核对并修正结果', { selector: 'strong' })).toBeInTheDocument();
});
it('keeps completed AI activity in the left column and orders history by newest date with stable ties', async () => {
  const saved = record('new-z', 'material_review', 'succeeded', { jobId: 'saved-job', createdAt: '2026-10-07T01:00:00Z' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: { jobId: 'saved-job', status: 'succeeded' } })));
  showRecords([record('old', 'material_review', 'succeeded', { createdAt: '2026-10-01T01:00:00Z' }), record('new-a', 'material_review', 'succeeded', { createdAt: saved.createdAt }), saved], '/assessment?section=checks&assessmentId=new-z');
  const activity = await screen.findByRole('region', { name: 'AI 处理状态' });
  expect(activity.closest('.assessment-initiation-column')).toBeTruthy();
  expect(screen.getAllByRole('region', { name: 'AI 处理状态' })).toHaveLength(1);
  const rows = screen.getAllByRole('button', { name: /材料检查 ·/ });
  expect(rows[0]).toHaveClass('active');
  expect(rows[2]?.textContent).toContain('2026/10/1');
});
