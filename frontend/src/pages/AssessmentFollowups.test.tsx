import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AssessmentFollowups, type AssessmentFollowup } from './AssessmentFollowups';
import type { Assessment, AssessmentReport } from '../api/simplification';
vi.mock('../auth', () => ({ useSession: () => ({ data: { id: 'member' } }) }));
vi.mock('./JobAiActivity', () => ({ JobAiActivity: ({ jobId, canResume, onResumed }: {jobId:string;canResume:boolean;onResumed:(id:string)=>void}) => <div data-testid="followup-job">{jobId}<button disabled={!canResume} onClick={() => onResumed('resumed-job')}>从停止处继续</button></div> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });
const report:AssessmentReport = {kind:'assistive',status:'scored',weightedTotal:80,scores:[{key:'proof',label:'论证',score:80,confidence:'high',comment:'原评分原因',evidence:[]}],summary:'原评分',limitations:[],requirementChecks:[]};
const assessment:Assessment={assessmentId:'a',kind:'material_review',status:'succeeded',revision:3,origin:'ai',goal:null,goalRevision:1,standardsVersionId:'s',standardsVersion:1,materialVersionIds:['v'],rehearsalId:null,report,historical:false,createdAt:'2026-10-07'};
const turn=(id:string,extra:Partial<AssessmentFollowup>={}):AssessmentFollowup=>({followupId:id,assessmentId:'a',userId:'member',message:id+' 追问',baseRevision:3,status:'succeeded',jobId:'job-'+id,baseReport:report,proposedReport:report,publishedReport:report,publishedRevision:4,error:null,createdAt:id==='older'?'2026-10-06':'2026-10-07',updatedAt:'2026-10-07',...extra});
function show({items=[],canCorrect=true,aiEnabled=true,current=assessment}: {items?:AssessmentFollowup[];canCorrect?:boolean;aiEnabled?:boolean;current?:Assessment}={}) {
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity},mutations:{retry:false}}});
  client.setQueryData(['assessment-followups','member','p','a'],{pages:[{items,nextCursor:null}],pageParams:[null]});
  const changed=vi.fn();
  render(<QueryClientProvider client={client}><MemoryRouter><AssessmentFollowups projectId="p" assessment={current} canCorrect={canCorrect} aiEnabled={aiEnabled} onChanged={changed}/></MemoryRouter></QueryClientProvider>);
  return {client,changed};
}
it('lets ordinary members read chronological history without a write or resume control',()=>{
  show({items:[turn('latest'),turn('older')],canCorrect:false});
  expect([...screen.getByRole('list',{name:'评分追问记录'}).querySelectorAll('.assessment-followup-message')].map(item=>item.textContent)).toEqual(['older 追问','latest 追问']);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('button',{name:'从停止处继续'})).toBeDisabled();
});
it('keeps a paused followup available for continuation without accepting another concurrent turn',()=>{
 show({items:[turn('paused',{status:'waiting_input',publishedReport:null,proposedReport:null})]});
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'另一条追问'}});
 expect(screen.getByRole('button',{name:'正在处理上一条追问'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'从停止处继续'})).toBeEnabled();
});
it('submits expected revision and an idempotency key, while leaving the current score untouched',async()=>{
  let body:unknown;let key:string|null=null;
  const fetch=vi.fn(async (_url:unknown,init?:RequestInit)=>{
    if(init?.method==='POST'){body=JSON.parse(String(init.body));key=new Headers(init.headers).get('Idempotency-Key');return Response.json({data:{followupId:'new',jobId:'new-job'}});}
    return Response.json({data:{items:[turn('new',{status:'running',proposedReport:null,publishedReport:null})],nextCursor:null}});
  });
  vi.stubGlobal('fetch',fetch);
  const {changed}=show();
  fireEvent.change(screen.getByRole('textbox'),{target:{value:' 请重新核对固定正文 '}});
  fireEvent.click(screen.getByRole('button',{name:'发送追问并复核'}));
  await waitFor(()=>expect(body).toEqual({message:'请重新核对固定正文',expectedRevision:3}));
  expect(key).toBeTruthy();
  await screen.findByText('new-job');
  expect(changed).toHaveBeenCalled();
  expect(assessment.report).toEqual(report);
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(screen.getByRole('button',{name:'正在处理上一条追问'})).toBeDisabled();
});
it('retains the draft and the same intent key across a network failure retry',async()=>{
  const keys:string[]=[];
  const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{
    if(init?.method==='POST'){
      keys.push(new Headers(init.headers).get('Idempotency-Key')!);
      if(keys.length===1)throw new TypeError('network failed');
      return Response.json({data:{followupId:'new',jobId:'new-job'}});
    }
    return Response.json({data:{items:[],nextCursor:null}});
  });
  vi.stubGlobal('fetch',fetch);show();
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'请核对第二节'}});
  fireEvent.click(screen.getByRole('button',{name:'发送追问并复核'}));
  await screen.findByRole('button',{name:'刷新当前评分与记录'});
  expect(screen.getByRole('textbox')).toHaveValue('请核对第二节');
  fireEvent.click(screen.getByRole('button',{name:'发送追问并复核'}));
  await waitFor(()=>expect(keys).toHaveLength(2));
  expect(keys[0]).toBe(keys[1]);
});
it('loads older cursor pages and deduplicates overlapping turns',async()=>{
  const {client}=show({items:[turn('latest')]});
  client.setQueryData(['assessment-followups','member','p','a'],{pages:[{items:[turn('latest')],nextCursor:'older-page'}],pageParams:[null]});
  const fetch=vi.fn(async(url:unknown)=>{
    expect(String(url)).toContain('cursor=older-page');
    return Response.json({data:{items:[turn('latest'),turn('older')],nextCursor:null}});
  });vi.stubGlobal('fetch',fetch);
  fireEvent.click(await screen.findByRole('button',{name:'加载更早的追问'}));
  await screen.findByText('older 追问');
  expect(screen.getAllByText('latest 追问')).toHaveLength(1);
  expect([...screen.getByRole('list',{name:'评分追问记录'}).querySelectorAll('.assessment-followup-message')].map(item=>item.textContent)).toEqual(['older 追问','latest 追问']);
});
it('shows conflict suggestions without reporting them as published scores',()=>{
  const proposed={...report,weightedTotal:95,summary:'建议补充计入第二节',scores:[{...report.scores[0]!,score:95,comment:'固定第二节包含证据'}]};
  show({items:[turn('conflict',{status:'conflict',proposedReport:proposed,publishedReport:null,publishedRevision:null})]});
  expect(screen.getByText('尚未写入当前评分的建议')).toBeInTheDocument();
  expect(screen.getByText(/本次建议未覆盖新版本/)).toBeInTheDocument();
  expect(screen.getByText('论证：80 → 95')).toBeInTheDocument();
  expect(screen.queryByText('本次复核结果')).toBeNull();
});
it('shows AI suggestions separately when existing human scores were preserved',()=>{
  const suggested={...report,scores:[{...report.scores[0]!,score:95,comment:'AI 复核建议'}]};
  show({items:[turn('human',{proposedReport:suggested})]});
  expect(screen.getByText('论证：80 → 80')).toBeInTheDocument();
  expect(screen.getByText('查看 AI 建议与保留的人工评分')).toBeInTheDocument();
  expect(screen.getByText('论证：95 · AI 复核建议')).toBeInTheDocument();
});
it('keeps failed progress resumable for authorized members and blocks unavailable AI submissions',()=>{
  show({items:[turn('failed',{status:'failed',error:'后台模型余额不足，请等待或联系管理员处理',proposedReport:null,publishedReport:null})]});
  expect(screen.getByText('后台模型余额不足，请等待或联系管理员处理')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'从停止处继续'})).not.toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'从停止处继续'}));
  expect(screen.getByTestId('followup-job')).toHaveTextContent('resumed-job');
});
it('allows suggestions for protected manual scores and blocks AI-disabled projects',()=>{
  show({current:{...assessment,origin:'manual'}});
  expect(screen.getByRole('textbox')).toBeInTheDocument();
  cleanup();
  show({aiEnabled:false});
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'请核对'}});
  expect(screen.getByRole('button',{name:'发送追问并复核'})).toBeDisabled();
  expect(screen.getByText(/追问中的新事实不能直接作为评分证据/)).toBeInTheDocument();
});

it('preserves an account-bound draft on revision conflict without overwriting the current report',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({requestId:'conflict',error:{code:'VERSION_CONFLICT',message:'评分版本已变化，请刷新后确认',retryable:false}},{status:409})));
  show();
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'核对原始成果第二节'}});
  fireEvent.click(screen.getByRole('button',{name:'发送追问并复核'}));
  await screen.findByText('评分版本已变化，请刷新后确认');
  expect(screen.getByRole('textbox')).toHaveValue('核对原始成果第二节');
  expect(sessionStorage.getItem('ai-office:assessment-followup-draft:member:p:a')).toBe('核对原始成果第二节');
  expect(assessment.report).toEqual(report);
  cleanup();
  show();
  expect(screen.getByRole('textbox')).toHaveValue('核对原始成果第二节');
});
