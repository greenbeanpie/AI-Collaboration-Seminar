import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage } from './DashboardPage';
import type { Task } from '../api/types';
vi.mock('../api/client', async importOriginal => ({ ...await importOriginal<typeof import('../api/client')>(), listAllItems: vi.fn(() => new Promise(() => {})) }));
afterEach(cleanup);
const task = (taskId: string, status: Task['status'] = 'doing', changes: Partial<Task> = {}) => ({taskId,title:taskId,status,dueDate:null,duePrecision:'unknown',lifecycleState:status === 'done' ? 'accepted' : 'in_progress',assigneeId:'member',dependsOnTaskIds:[],unfinishedDependencyIds:[],revision:1,...changes}) as Task;
function setup(options: { loading?: boolean; archive?: boolean; membersLoading?: boolean; memberError?: boolean; pendingTasks?: Task[]; taskError?: boolean; empty?: boolean } = {}) {
  const client = new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
  client.setQueryData(['projects', 'pages', { status: 'all', limit: 100 }, ''], { pages: [{ items: options.empty ? [] : [
    {id:'pending',name:'待确认项目',status:'active',description:'',deadlineDate:null,deadlinePrecision:'unknown',myRole:'owner'},
    {id:'doing',name:'进行中的项目甲',status:'active',description:'',deadlineDate:null,deadlinePrecision:'unknown',myRole:'member'},
    {id:'done',name:'已完成项目甲',status:'active',description:'',deadlineDate:null,deadlinePrecision:'unknown',myRole:'owner'},
    {id:'archive',name:'已归档项目甲',status:'archived',description:'',deadlineDate:null,deadlinePrecision:'unknown',myRole:'owner'},
  ], nextCursor: null }], pageParams: [null] });
  if(!options.loading) client.setQueryData(['tasks','pending'], options.pendingTasks ?? [task('待确认任务','todo')]);
  if (options.taskError) client.getQueryCache().find({ queryKey: ['tasks', 'pending'] })!.setState({ status: 'error', error: new Error('任务读取失败') });
  for (const id of ['pending', 'doing', 'done']) if (!(options.membersLoading && id === 'pending')) client.setQueryData(['members', id], [{ userId: 'member' }]);
  if (options.memberError) client.getQueryCache().find({ queryKey: ['members', 'pending'] })!.setState({ status: 'error', error: new Error('成员读取失败') });
  client.setQueryData(['tasks','doing'],[task('正在做的任务','doing')]);
  client.setQueryData(['tasks','done'],[task('完成任务','done')]);
  client.setQueryData(['tasks','archive'],[task('归档任务甲','todo')]);
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[options.archive?'/app?archive=1':'/app']}><DashboardPage /></MemoryRouter></QueryClientProvider>);
}
describe('dashboard interactions',()=>{
 it('shows completion progress using all non-archived tasks, not only actionable tasks',()=>{
  const { container } = setup({pendingTasks:[task('完成的前置','done'),...Array.from({length:22},(_,i)=>task(`待分配${i}`,'todo',{assigneeId:null}))]});
  expect(screen.getByRole('progressbar',{name:'任务完成率'})).toHaveAttribute('aria-valuenow','8');
  expect(screen.getByText('2 / 25 项任务已完成')).toBeInTheDocument();
  expect(container.querySelector('.task-completion-card')).toHaveAttribute('data-completion-tone','red');
 });
 it.each([{loading:true},{taskError:true}])('does not color or fill an unavailable completion metric: %j',options=>{
  const { container } = setup(options);
  expect(screen.queryByRole('progressbar',{name:'任务完成率'})).not.toBeInTheDocument();
  expect(container.querySelector('.task-completion-card')).not.toHaveAttribute('data-completion-tone');
 });
 it('does not claim completion when there are no projects or tasks',()=>{
  setup({empty:true});
  expect(screen.getByRole('progressbar',{name:'任务完成率'})).toHaveAttribute('aria-valuenow','0');
  expect(screen.getByText('0 / 0 项任务已完成')).toBeInTheDocument();
 });
 it('keeps one invitation entry in the upper metrics and removes the lower inbox disclosure',()=>{
  const { container } = setup();
  const invitationLink = screen.getByRole('link',{name:/项目邀请.*输入邀请码，或处理收到的邀请/});
  expect(invitationLink).toHaveAttribute('href','/app/join');
  expect(invitationLink.closest('.dashboard-metrics')).not.toBeNull();
  expect(container.querySelectorAll('a[href="/app/join"]')).toHaveLength(1);
  expect(container.querySelector('.dashboard-invitations')).toBeNull();
  expect(screen.queryByText('收到的项目邀请')).not.toBeInTheDocument();
 });
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
 it('groups by incomplete projects, shows actionable task counts and preserves project and task links',()=>{
  setup({pendingTasks:[task('可完成任务'),task('可完成任务'),task('待分配任务','todo',{assigneeId:null}),task('已提交任务','doing',{lifecycleState:'submitted'}),task('受阻任务','blocked'),task('已完成任务','done')]});
  const attention = screen.getByRole('complementary',{name:'待响应事项'});
  expect(within(attention).getByText('2 项可完成')).toBeInTheDocument();
  expect(within(attention).getAllByRole('region')).toHaveLength(2);
  const group = within(attention).getByRole('region',{name:'待确认项目'});
  expect(within(group).getByRole('link',{name:/待确认项目.*1 项可完成/})).toHaveAttribute('href','/app/projects/pending');
  expect(within(group).getByRole('link',{name:/可完成任务.*截止待确认/})).toHaveAttribute('href','/app/projects/pending/tasks?task=%E5%8F%AF%E5%AE%8C%E6%88%90%E4%BB%BB%E5%8A%A1');
  expect(within(group).getAllByRole('listitem')).toHaveLength(1);
  for (const text of ['待分配任务','已提交任务','受阻任务','已完成任务','已完成项目甲','已归档项目甲']) expect(within(attention).queryByText(text)).not.toBeInTheDocument();
  expect(document.querySelector('.dashboard-deadline .dashboard-metric-value')).toHaveTextContent('2项');
 });
 it('hides projects with zero actionable tasks from the attention panel',()=>{
  setup({pendingTasks:[task('等待前置','doing',{dependsOnTaskIds:['未完成前置'],unfinishedDependencyIds:['未完成前置']}),task('未完成前置','todo',{assigneeId:null})]});
  const attention = within(screen.getByRole('complementary',{name:'待响应事项'}));
  expect(attention.queryByRole('region',{name:'待确认项目'})).not.toBeInTheDocument();
  expect(attention.queryByText('暂无可完成任务')).not.toBeInTheDocument();
  expect(screen.getByRole('link',{name:/待确认项目.*进入项目/})).toBeInTheDocument();
 });
 it('does not truncate currently actionable tasks to the old five-item list',()=>{
  setup({pendingTasks:Array.from({length:7},(_,i)=>task(`可执行${i+1}`))});
  const attention = screen.getByRole('complementary',{name:'待响应事项'});
  expect(within(attention).getAllByRole('listitem')).toHaveLength(8);
  expect(within(attention).getByText('8 项可完成')).toBeInTheDocument();
 });
 it('waits for current membership before showing actionable totals',()=>{
  setup({membersLoading:true});
  expect(screen.getByText('今日截止 — 项')).toBeInTheDocument();
  expect(screen.getByText('正在读取待响应事项…')).toBeInTheDocument();
 });
 it('does not expose a cached actionable list when current membership fails to load',()=>{
  setup({memberError:true});
  expect(screen.getByText('今日截止 — 项')).toBeInTheDocument();
  expect(screen.getByText('任务暂不可用，请重试。')).toBeInTheDocument();
  expect(within(screen.getByRole('complementary',{name:'待响应事项'})).queryByRole('link')).not.toBeInTheDocument();
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
