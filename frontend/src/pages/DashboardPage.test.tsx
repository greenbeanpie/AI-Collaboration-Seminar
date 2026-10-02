import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from './DashboardPage';
vi.mock('./UsernameInvitations', () => ({ ReceivedInvitations: () => <div>邀请入口</div> }));
vi.mock('../api/client', () => ({ listAllItems: vi.fn(() => new Promise(() => {})) }));
afterEach(cleanup);
function setup(options: { loading?: boolean; archive?: boolean } = {}) {
  const client = new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
  client.setQueryData(['projects'], [
    {id:'pending',name:'待确认项目',status:'active',description:'',deadlineDate:null,deadlinePrecision:'unknown',myRole:'owner'},
    {id:'doing',name:'进行中的项目甲',status:'active',description:'',deadlineDate:null,deadlinePrecision:'unknown',myRole:'member'},
    {id:'done',name:'已完成项目甲',status:'active',description:'',deadlineDate:null,deadlinePrecision:'unknown',myRole:'owner'},
    {id:'archive',name:'已归档项目甲',status:'archived',description:'',deadlineDate:null,deadlinePrecision:'unknown',myRole:'owner'},
  ]);
  const task = (taskId: string, status: string) => ({taskId,title:taskId,status,dueDate:null,duePrecision:'unknown',lifecycleState:null});
  if(!options.loading) client.setQueryData(['tasks','pending'],[task('待确认任务','todo')]);
  client.setQueryData(['tasks','doing'],[task('正在做的任务','doing')]);
  client.setQueryData(['tasks','done'],[task('完成任务','done')]);
  client.setQueryData(['tasks','archive'],[task('归档任务甲','todo')]);
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[options.archive?'/app?archive=1':'/app']}><DashboardPage /></MemoryRouter></QueryClientProvider>);
}
describe('dashboard interactions',()=>{
 it('includes pending in active, excludes archive from main list and filters completed',()=>{
  setup();
  const projects = screen.getByRole('region',{name:'项目区'});
  expect(within(projects).queryByText('已归档项目甲')).not.toBeInTheDocument();
  fireEvent.click(within(projects).getByRole('button',{name:'进行中'}));
  expect(within(projects).getByText('待确认项目')).toBeInTheDocument();
  expect(within(projects).queryByText('已完成项目甲')).not.toBeInTheDocument();
  fireEvent.click(within(projects).getByRole('button',{name:'已完成'}));
  expect(within(projects).getByText('已完成项目甲')).toBeInTheDocument();
  expect(within(projects).queryByText('待确认项目')).not.toBeInTheDocument();
 });
 it('switches project view and keeps task deep links',()=>{
  setup();
  fireEvent.click(screen.getByRole('button',{name:'列表'}));
  expect(screen.getByRole('button',{name:'列表'})).toHaveAttribute('aria-pressed','true');
  expect(screen.getByRole('link',{name:/待确认任务/})).toHaveAttribute('href','/app/projects/pending/tasks?task=%E5%BE%85%E7%A1%AE%E8%AE%A4%E4%BB%BB%E5%8A%A1');
 });
 it('does not display incomplete totals or a fake zero while tasks are loading',()=>{
  setup({loading:true});
  expect(screen.getByText('今日截止 — 项')).toBeInTheDocument();
  expect(screen.queryByText('今日截止 0 项')).not.toBeInTheDocument();
  expect(screen.getByText('正在读取待响应事项…')).toBeInTheDocument();
 });
 it('opens archived tasks in a separate accessible dialog and closes via Escape',()=>{
  setup({archive:true});
  const dialog = screen.getByRole('dialog',{name:'归档任务'});
  expect(within(dialog).getByText('已归档项目甲')).toBeInTheDocument();
  expect(within(dialog).getByText('归档任务甲')).toBeInTheDocument();
  fireEvent.keyDown(document,{key:'Escape'});
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 });
});
