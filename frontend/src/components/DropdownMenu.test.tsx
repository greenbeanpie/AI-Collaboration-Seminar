import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DropdownMenu } from './DropdownMenu';

afterEach(cleanup);
it('opens explicitly, focuses actions, and restores the trigger on Escape', () => {
  render(<DropdownMenu label="更多"><button>查看历史版本</button></DropdownMenu>);
  expect(screen.queryByRole('button', { name: '查看历史版本' })).toBeNull();
  const trigger = screen.getByRole('button', { name: /更多/ });
  fireEvent.click(trigger);
  const action = screen.getByRole('button', { name: '查看历史版本' });
  expect(action).toHaveFocus();
  fireEvent.keyDown(action, { key: 'Escape' });
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});
it('closes after an action, when clicking outside, and when focus leaves', () => {
  const run = vi.fn();
  render(<><DropdownMenu label="导出文件"><button onClick={run}>Markdown</button></DropdownMenu><button>外部</button></>);
  const trigger = screen.getByRole('button', { name: /导出文件/ });
  fireEvent.click(trigger); fireEvent.click(screen.getByRole('button', { name: 'Markdown' }));
  expect(run).toHaveBeenCalledOnce(); expect(trigger).toHaveFocus();
  fireEvent.click(trigger); fireEvent.pointerDown(screen.getByRole('button', { name: '外部' }));
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(trigger); act(() => screen.getByRole('button', { name: '外部' }).focus());
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});
