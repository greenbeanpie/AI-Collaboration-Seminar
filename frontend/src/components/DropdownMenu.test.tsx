import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DropdownMenu } from './DropdownMenu';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('keeps a menu inside the viewport and recalculates its position after resizing', () => {
  let left = -60;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    return this.classList.contains('dropdown-content') ? { left, right: left + 180, top: 0, bottom: 100, width: 180, height: 100, x: left, y: 0, toJSON: () => ({}) } : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
  });
  render(<DropdownMenu label="导出"><button>Markdown</button></DropdownMenu>);
  fireEvent.click(screen.getByRole('button', { name: /导出/ }));
  const menu = screen.getByLabelText('导出');
  expect(menu.style.getPropertyValue('--dropdown-offset')).toBe('68px');
  left = window.innerWidth - 80;
  fireEvent.resize(window);
  expect(menu.style.getPropertyValue('--dropdown-offset')).toBe('-108px');
});
it('also respects an editor card that clips its children', () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function(this: HTMLElement) { return this.classList.contains('clipping-card') ? 240 : 0; });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const left = this.classList.contains('clipping-card') ? 32 : -40;
    const width = this.classList.contains('clipping-card') ? 240 : 180;
    return { left, right: left + width, top: 0, bottom: 100, width, height: 100, x: left, y: 0, toJSON: () => ({}) };
  });
  render(<div className="clipping-card" style={{ overflowX: 'hidden' }}><DropdownMenu label="文件"><button>Markdown</button></DropdownMenu></div>);
  fireEvent.click(screen.getByRole('button', { name: /文件/ }));
  const menu = screen.getByLabelText('文件');
  expect(menu.style.getPropertyValue('--dropdown-offset')).toBe('80px');
  expect(menu.style.maxWidth).toBe('224px');
});
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
