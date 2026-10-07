import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AssessmentHistoryPages } from './AssessmentHistoryPages';

afterEach(cleanup);
const entries = (count: number) => Array.from({ length: count }, (_, i) => `记录${i + 1}`);
const row = (item: string) => <button key={item}>{item}</button>;
it('shows six rows per page with bounded previous/next controls', async () => {
  render(<AssessmentHistoryPages items={entries(13)} renderItem={row} hasMore={false} loading={false} loadMore={vi.fn()} />);
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '记录6' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '记录7' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(await screen.findByRole('button', { name: '记录7' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(await screen.findByRole('button', { name: '记录13' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '上一页' }));
  expect(screen.getByRole('button', { name: '记录7' })).toBeInTheDocument();
});
it('fills a page across the 50-row server boundary and keeps the previous page on failure', async () => {
  const loadMore = vi.fn().mockResolvedValue(false);
  const props = { items: entries(50), renderItem: row, hasMore: true, loading: false, loadMore };
  const view = render(<AssessmentHistoryPages {...props} />);
  for (let page = 2; page <= 8; page++) {
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText(`第 ${page} 页 · 每页 6 条`);
  }
  expect(loadMore).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(loadMore).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: '记录43' })).toBeInTheDocument();
  let resolve!: (success: boolean) => void;
  loadMore.mockImplementation(() => new Promise<boolean>(done => { resolve = done; }));
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(screen.getByRole('button', { name: '正在读取' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  view.rerender(<AssessmentHistoryPages {...props} items={entries(56)} hasMore={false} />);
  resolve(true);
  expect(await screen.findByRole('button', { name: '记录54' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '记录49' })).toBeInTheDocument();
  expect(loadMore).toHaveBeenCalledTimes(2);
  view.rerender(<AssessmentHistoryPages {...props} items={entries(2)} hasMore={false} />);
  expect(screen.getByText('第 1 页 / 共 1 页 · 每页 6 条')).toBeInTheDocument();
});
