import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTaskAgentEligibility } from '../src/pages/useTaskAgentEligibility';
import type { CollaborationTask } from '../src/api/collaboration';

const projectId = '11111111-1111-4111-8111-111111111111';
const tasks = Array.from({ length: 20 }, (_, index) => ({
  taskId: `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`,
  title: `Task ${index + 1}`, revision: 1,
} as CollaborationTask));
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Reader({ task, dialog = false }: { task: CollaborationTask; dialog?: boolean }) {
  const value = useTaskAgentEligibility(projectId, task);
  return <div data-task={task.taskId} data-dialog={dialog} data-status={value.result?.status ?? 'loading'}>
    <span>{task.title}: {value.result?.status ?? 'loading'}</span>
    <button onClick={value.reload}>Refresh {task.title}</button>
    <button disabled={!value.eligible}>Delegate {task.title}</button>
  </div>;
}

function Fixture() {
  const [dialog, setDialog] = useState(false);
  return <main>
    <button onClick={() => setDialog(current => !current)}>Toggle Dialog</button>
    <button onClick={() => client.clear()}>Clear Session</button>
    {tasks.map(task => <Reader key={task.taskId} task={task} />)}
    {dialog && <aside role="dialog"><Reader task={tasks[0]} dialog /></aside>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><Fixture /></QueryClientProvider>);
