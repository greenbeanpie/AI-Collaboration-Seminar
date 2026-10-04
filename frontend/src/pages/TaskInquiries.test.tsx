import { afterEach,it,expect,vi } from 'vitest';
import { cleanup,render,screen,fireEvent,waitFor } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { TaskInquiries } from './TaskInquiries';
import { projectRequest } from '../api/simplification';
vi.mock('../api/simplification',()=>({projectRequest:vi.fn()}));
vi.mock('./aiWorkflowSupport',()=>({idempotencyKeyForIntent:async()=> 'intent-key',completeIntent:vi.fn()}));
const request=vi.mocked(projectRequest);
afterEach(()=>{cleanup();vi.clearAllMocks();});
function show(){render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}><TaskInquiries projectId="p" taskId="down" meId="me"/></QueryClientProvider>);}
it('labels substitute responders and sends upstream inquiry',async()=>{
 request.mockResolvedValue({items:[],candidates:[{taskId:'up',title:'接口规范',recipientName:'同学甲',recipientSource:'substitute'}]});show();
 expect(await screen.findByRole('option',{name:'接口规范 · 同学甲（当前执行人代答）'})).toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('询问哪项前置任务'),{target:{value:'up'}});fireEvent.change(screen.getByLabelText('对当前任务的影响与问题'),{target:{value:'字段格式是什么？'}});fireEvent.click(screen.getByRole('button',{name:'发起质询'}));
 await waitFor(()=>expect(request).toHaveBeenCalledWith('p','/tasks/down/inquiries',{method:'POST',body:{upstreamTaskId:'up',body:'字段格式是什么？'},idempotencyKey:'intent-key'}));
});
it('renders participant history and preserves failed reply draft',async()=>{
 request.mockResolvedValue({candidates:[],items:[{inquiryId:'thread',taskId:'down',upstreamTaskId:'up',taskTitle:'实现',upstreamTitle:'规范',requesterId:'me',requesterName:'乙',recipientId:'a',recipientName:'甲',recipientSource:'submission',messages:[{messageId:'msg',authorName:'甲',body:'使用 JSON',createdAt:'2026-10-03T00:00:00Z'}]}]});show();
 expect(await screen.findByText('使用 JSON')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'发起质询'})).toBeNull();
 request.mockRejectedValueOnce(new Error('网络失败'));fireEvent.change(screen.getByLabelText('回复或追问'),{target:{value:'请提供示例'}});fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
 expect(await screen.findByText('网络失败')).toBeInTheDocument();expect(screen.getByLabelText('回复或追问')).toHaveValue('请提供示例');
});
it('marks only messages from the displayed snapshot read',async()=>{
 request.mockImplementation(async(_project,path)=>path.endsWith('/read')?{readCount:1}:{candidates:[],items:[{inquiryId:'thread',taskId:'down',upstreamTaskId:'up',taskTitle:'实现',upstreamTitle:'规范',requesterName:'乙',recipientName:'甲',recipientSource:'submission',messages:[{messageId:'displayed-message',authorName:'甲',body:'已显示消息',createdAt:'2026-10-03T00:00:00Z'}]}]});
 show();await screen.findByText('已显示消息');
 await waitFor(()=>expect(request).toHaveBeenCalledWith('p','/tasks/down/inquiries/read',{method:'POST',body:{messageIds:['displayed-message']}}));
 expect(request.mock.calls.some(([,path,options])=>path.endsWith('/read')&&JSON.stringify(options?.body).includes('unseen-message'))).toBe(false);
});
