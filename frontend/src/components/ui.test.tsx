import { cancelPageDialog } from '../dialogs/dialog-service';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { ConfirmButton, Modal } from './ui';

afterEach(async () => { await act(async () => { cancelPageDialog(); }); cleanup(); vi.restoreAllMocks(); });

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

it('labels an icon-only confirmation button and requires an in-page decision once', async () => {
  const onClick = vi.fn();
  render(<ConfirmButton aria-label="移除成员 验收成员" onClick={onClick}><span aria-hidden="true">×</span></ConfirmButton>);
  const button = screen.getByRole('button', { name: '移除成员 验收成员' });
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
  let dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(button); fireEvent.click(button);
  dialog = await screen.findByRole('dialog');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  fireEvent.click(within(dialog).getByRole('button', { name: '确定' }));
  await waitFor(() => expect(onClick).toHaveBeenCalledOnce());
});
