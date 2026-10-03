import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import type { Task } from '../api/types';
import { PendingTaskPreview } from './PendingTaskPreview';
afterEach(cleanup);
it('links each visible task to the exact project/task target', () => {
  const tasks: Task[] = [{ taskId: 'task-a', lifecycleState: null, criteria: '', effortHours: 0, currentSubmissionId: null, citations: [], dependsOnTaskIds: [], unfinishedDependencyIds: [], title: '整理资料', detail: '', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', assigneeId: 'me', status: 'doing', dueDate: null, duePrecision: 'unknown', requirementId: null, revision: 1 }];
  render(<MemoryRouter><PendingTaskPreview tasks={tasks} userId="me" projectId="project-a" /></MemoryRouter>);
  expect(screen.getByRole('link', { name: /整理资料/ })).toHaveAttribute('href', '/app/projects/project-a/tasks?task=task-a');
  expect(screen.getByText(/由你负责/)).toBeInTheDocument();
});
