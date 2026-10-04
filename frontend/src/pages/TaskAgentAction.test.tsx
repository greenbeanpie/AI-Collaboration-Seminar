import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { CollaborationTask } from '../api/collaboration';
import { TaskAgentAction } from './TaskAgentAction';
afterEach(cleanup);
it('opens assistance for any task without dispatching or showing card guidance', () => {
  const handoff = vi.fn();
  render(<TaskAgentAction projectId="p1" task={{ taskId: 't1', revision: 3, title: '现场采访' } as CollaborationTask} onHandoff={handoff} />);
  fireEvent.click(screen.getByRole('button', { name: 'AI 辅助' }));
  expect(handoff).toHaveBeenCalledOnce();
  expect(screen.queryByText(/检查 AI|连接 DSH|请先检查/)).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(1);
});
