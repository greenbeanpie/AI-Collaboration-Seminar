import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SubmissionBody } from './SubmissionBody';
afterEach(cleanup);
it('starts collapsed and expands the complete submission text without clipping', async () => {
  const body = '完整正文\n' + '长内容'.repeat(1000) + '\n最后一句';
  const { container } = render(<SubmissionBody body={body}/>);
  expect(container.querySelector('details')).not.toHaveAttribute('open');
  expect(container.querySelector('p')).not.toBeVisible();
  fireEvent.click(screen.getByText('展开提交内容'));
  await waitFor(() => expect(screen.getByText('收起提交内容')).toBeInTheDocument());
  expect(container.querySelector('p')).toBeVisible(); expect(container.querySelector('p')?.textContent).toBe(body);
  fireEvent.click(screen.getByText('收起提交内容'));
  await waitFor(() => expect(container.querySelector('p')).not.toBeVisible());
});
