import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { MaterialAiAssistance } from './MaterialAiAssistance';

vi.mock('./AiWorkspacePage', () => ({ AiWorkspacePage: ({ embedded }: { embedded: boolean }) => {
  const [instruction, setInstruction] = useState('');
  return <div><span>{embedded ? 'Inline workspace' : 'Standalone workspace'}</span><input aria-label="AI instruction" value={instruction} onChange={event => setInstruction(event.target.value)} /></div>;
} }));
afterEach(cleanup);
it('opens AI only on request, and repeated collapse/reopen retains the instruction draft', async () => {
  render(<MaterialAiAssistance />);
  expect(screen.queryByText('Inline workspace')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '打开 AI 协助' }));
  const input = await screen.findByLabelText('AI instruction');
  fireEvent.change(input, { target: { value: 'Keep my revision request' } });
  fireEvent.click(screen.getByRole('button', { name: '收起 AI 协助' }));
  expect(input).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '打开 AI 协助' }));
  expect(input).toBeVisible(); expect(input).toHaveValue('Keep my revision request');
  expect(screen.getAllByLabelText('AI instruction')).toHaveLength(1);
});
it('old AI deep links can open the inline workspace immediately, with a fresh scope on project change', async () => {
  const view = render(<MaterialAiAssistance initiallyOpen key="project-a" />);
  fireEvent.change(await screen.findByLabelText('AI instruction'), { target: { value: 'Project A' } });
  view.rerender(<MaterialAiAssistance initiallyOpen key="project-b" />);
  expect(await screen.findByLabelText('AI instruction')).toHaveValue('');
  expect(screen.getByRole('button', { name: '收起 AI 协助' })).toHaveAttribute('aria-expanded', 'true');
});
