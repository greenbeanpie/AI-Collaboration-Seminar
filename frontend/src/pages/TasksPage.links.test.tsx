import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { Task } from '../api/types';
import { TasksPage } from './TasksPage';
const context = vi.hoisted(() => ({ projectId: 'p' }));
vi.mock('../components/ProjectShell', () => ({ useProject: () => context }));
vi.mock('./TasksMaterialsShared', () => ({ CommentsPanel: () => <div>评论区域</div> }));
function task(id: string, lifecycleState?: string): Task & { lifecycleState?: string } {
  return { taskId: id, title: `Task ${id}`, detail: '', assigneeId: null, dueDate: null, duePrecision: 'unknown', status: 'todo', requirementId: null, revision: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', lifecycleState };
}
function Harness() {
  const location = useLocation(); const navigate = useNavigate();
  return <><output aria-label="当前查询">{location.search}</output><button onClick={() => navigate('/app/projects/p/tasks?task=b')}>打开 B</button><button onClick={() => navigate(-1)}>后退</button><TasksPage /></>;
}
function setup(id: string, tasks = [task('a'), task('b')]) {
  context.projectId = 'p';
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  for (const project of ['p', 'other']) {
    client.setQueryData(['tasks', project, 'all'], project === 'p' ? tasks : []);
    client.setQueryData(['members', project], []); client.setQueryData(['requirementSets', project], []);
  }
  const view = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/app/projects/p/tasks?task=${id}`]}><Harness /></MemoryRouter></QueryClientProvider>);
  return { ...view, client };
}
afterEach(cleanup);
it('opens an authorized task deep link; close removes the parameter and does not immediately reopen', async () => {
  setup('a');
  await screen.findByRole('dialog', { name: '编辑任务与讨论' });
  expect(screen.getByDisplayValue('Task a')).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('关闭'));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByLabelText('当前查询')).toHaveTextContent('');
});
it('follows task URL changes and Back without retaining the wrong task', async () => {
  setup('a'); await screen.findByDisplayValue('Task a');
  fireEvent.click(screen.getByRole('button', { name: '打开 B' })); await screen.findByDisplayValue('Task b');
  fireEvent.click(screen.getByRole('button', { name: '后退' })); await screen.findByDisplayValue('Task a');
});
it('does not open unknown or inaccessible task IDs, or lifecycle tasks in the legacy editor', () => {
  const view = setup('foreign', [task('a'), task('managed', 'claimed')]);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); view.unmount();
  setup('managed', [task('managed', 'claimed')]);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('preserves dirty edits on same-task refetch and closes if the authorized list loses the task', async () => {
  const { client } = setup('a'); await screen.findByDisplayValue('Task a');
  fireEvent.change(screen.getByDisplayValue('Task a'), { target: { value: 'unsaved local edit' } });
  client.setQueryData(['tasks', 'p', 'all'], [{ ...task('a'), revision: 2 }]);
  await waitFor(() => expect(screen.getByDisplayValue('unsaved local edit')).toBeInTheDocument());
  client.setQueryData(['tasks', 'p', 'all'], []);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('does not retain a selected task when the project scope changes', async () => {
  setup('a'); await screen.findByDisplayValue('Task a');
  context.projectId = 'other';
  fireEvent.click(screen.getByRole('button', { name: '打开 B' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
