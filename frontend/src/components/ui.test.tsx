import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmButton, Modal } from './ui';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('closes a modal with Escape and restores focus and page scrolling', () => {
  const trigger = document.createElement('button');
  document.body.append(trigger); trigger.focus();
  document.body.style.overflow = 'auto';
  const onClose = vi.fn();
  const { unmount } = render(<Modal title="审查弹窗" onClose={onClose}><button>保存</button></Modal>);
  expect(document.body.style.overflow).toBe('hidden');
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
  unmount();
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe('auto');
  trigger.remove(); document.body.style.overflow = '';
});

it('labels an icon-only confirmation button and requires confirmation', () => {
  const onClick = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<ConfirmButton aria-label="移除成员 验收成员" onClick={onClick}><span aria-hidden="true">×</span></ConfirmButton>);
  const button = screen.getByRole('button', { name: '移除成员 验收成员' });
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
});
