import { cleanup,render,screen } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach,expect,it,vi } from 'vitest';
import { ProjectSettingsPage } from './ProjectSettingsPage';
const state=vi.hoisted(()=>({teamSizeLimit:null as number|null,role:'member'}));
vi.mock('../auth',()=>({useCapabilities:()=>({data:{environment:'production',apiVersion:'v1',features:{aiEnabled:false,webFetch:false,emailMode:'disabled'},limits:{maxFileBytes:10485760,maxPdfPages:20,pageImageMaxEdge:2000,pageImageMaxBytes:1048576,concurrentAiTasksPerProject:1},competitionTemplate:{get teamSizeLimit(){return state.teamSizeLimit;}}}})}));
vi.mock('../components/ProjectShell',()=>({useProject:()=>({projectId:'test-project',project:{name:'测试项目',description:'',deadlineDate:null,deadlinePrecision:'unknown',status:'active',myRole:state.role,revision:1,updatedAt:'2026-10-02T00:00:00Z'}})}));
vi.mock('./CollaborationSettings',()=>({CollaborationSettings:()=>null}));
vi.mock('./AiSettings',()=>({AiSettings:()=> <h2>AI 模型接入与测试</h2>}));
afterEach(()=>cleanup());
it.each([{limit:null,display:'不设上限'},{limit:5,display:'5 人'}])('renders project team capacity without an empty unit for $display',({limit,display})=>{
  state.teamSizeLimit=limit;
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><ProjectSettingsPage /></MemoryRouter></QueryClientProvider>);
  const row=screen.getByText('项目人数').parentElement!;
  expect(row.querySelector('strong')?.textContent).toBe(display);
});

it.each(['owner', 'member'])('does not embed system AI configuration for %s', (role) => {
  state.role = role;
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><ProjectSettingsPage /></MemoryRouter></QueryClientProvider>);
  expect(screen.getByRole('heading', { name: '项目基本信息' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'AI 模型接入与测试' })).toBeNull();
  if (role === 'member') expect(screen.getByLabelText('项目名称')).toBeDisabled();
  else expect(screen.getByLabelText('项目名称')).toBeEnabled();
});
