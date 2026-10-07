import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceProcessingCard } from './SourceProcessingCard';
import { api } from '../api/client';
import type { DataOf } from '../api/types';

vi.mock('../api/client', async original => ({ ...await original<typeof import('../api/client')>(), api:{ get:vi.fn(),post:vi.fn() } }));
afterEach(cleanup);
const base: DataOf<'SourceProcessingResponse'> = { activity:null,processingJobId:null,textStatus:'ready',requirementsStatus:'ready',requirementsError:null,summaryStatus:'pending',summary:null,summaryError:null,summaryJobId:null,summaryRevision:0,coveredChars:null,totalChars:null };
function view(state=base,aiEnabled=true) {
  vi.mocked(api.get).mockResolvedValue(state as never);
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><SourceProcessingCard projectId="p" sourceId="s" versionId="v" aiEnabled={aiEnabled} active={false}/></QueryClientProvider>);
}
describe('independent file summary UI',()=>{
  it('labels incomplete media summaries and retains key timestamps and failure details', async () => {
    view({...base,textStatus:'failed',media:{stage:'failed',durationSeconds:1200,completedWindows:1,error:'第二个窗口未完成',summary:{title:'会议',summary:'已读取部分会议重点',keyPoints:[],conclusions:[],actionItems:[],timestamps:[{seconds:30,description:'讨论交付范围'}],caveats:[],complete:false}}});
    expect(await screen.findByText('音视频 AI 摘要（非逐字原文）')).toBeInTheDocument();
    expect(screen.getByText('部分摘要，尚未完整覆盖：')).toBeInTheDocument();
    expect(screen.getByText('已读取部分会议重点')).toBeInTheDocument();
    expect(screen.getByText('[30s] 讨论交付范围')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('第二个窗口未完成');
  });
  it('does not invent a summary before generation and explains the separate AI action',async()=>{
    view(); expect(await screen.findByRole('button',{name:'生成文件总结'})).toBeEnabled();
    expect(screen.getByText(/可能产生 AI 用量/)).toBeInTheDocument(); expect(api.post).not.toHaveBeenCalled();
  });
  it('shows a grounded completed summary, citations and an explicit partial-coverage warning',async()=>{
    view({...base,summaryStatus:'ready',summary:{title:'文件内容',summary:'实际模型总结',keyPoints:['关键事项'],citations:[{fragmentId:'f',pageNumber:4,quote:'原文引句'}],caveats:['信息需核对']},coveredChars:50,totalChars:100});
    expect(await screen.findByText('实际模型总结')).toBeInTheDocument(); expect(screen.getByText(/50\/100/)).toBeInTheDocument(); expect(screen.getByText('第 4 页：原文引句')).toBeInTheDocument();
  });
  it('retains failure and successful requirements, sends only version metadata, and never reports fake success',async()=>{
    view({...base,summaryStatus:'failed',summaryRevision:3,summaryError:'供应商暂不可用'});
    vi.mocked(api.post).mockRejectedValue(new Error('网络连接失败'));
    fireEvent.click(await screen.findByRole('button',{name:'单独重试文件总结'}));
    await waitFor(()=>expect(api.post).toHaveBeenCalledWith('/api/v1/projects/p/sources/s/versions/v/processing/summary',{expectedSummaryRevision:3},expect.objectContaining({idempotencyKey:expect.any(String)})));
    expect(await screen.findByText('网络连接失败')).toBeInTheDocument(); expect(screen.getByText('供应商暂不可用')).toBeInTheDocument(); expect(screen.queryByText('实际模型总结')).not.toBeInTheDocument();
  });
  it('does not allow AI-disabled or incomplete sources to generate summary',async()=>{
    view({...base,textStatus:'waiting_input'},false);
    expect(await screen.findByRole('button',{name:'生成文件总结'})).toBeDisabled(); expect(api.post).not.toHaveBeenCalled();
  });
  it('uses checkpoint resume rather than starting another summary when a failed job is known', async () => {
    vi.mocked(api.post).mockClear();
    const state = { ...base, summaryStatus: 'failed' as const, summaryJobId: 'failed-summary', summaryError: '保存未完成' };
    vi.mocked(api.get).mockImplementation(async path => path.includes('/jobs/') ? { jobId: 'failed-summary', status: 'failed', activity: { code: 'failed', updatedAt: null, lastResponseAt: '2026-10-07T00:00:00Z', progress: null, canResume: true, resumeReason: null, uncertain: false } } as never : state as never);
    vi.mocked(api.post).mockResolvedValue({ jobId: 'resumed-summary' } as never);
    render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><SourceProcessingCard projectId="p" sourceId="s" versionId="v" aiEnabled active={false}/></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: '从停止处继续' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/jobs/failed-summary/retry', undefined, expect.objectContaining({idempotencyKey:expect.any(String)})));
    expect(screen.queryByRole('button', {name:'单独重试文件总结'})).toBeNull();
    expect(vi.mocked(api.post).mock.calls.some(([path]) => path.endsWith('/processing/summary'))).toBe(false);
  });

});
