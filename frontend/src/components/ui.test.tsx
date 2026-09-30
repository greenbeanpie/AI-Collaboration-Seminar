import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmButton } from './ui';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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
