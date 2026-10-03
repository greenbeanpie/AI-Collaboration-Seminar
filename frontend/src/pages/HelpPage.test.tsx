import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { HelpMarkdown, HelpPage } from './HelpPage';

function setup(path = '/app/help') {
  const router = createMemoryRouter([{ path: '/app/help', element: <HelpPage /> }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('describes the technical implementation without assigning an identity to its reader', () => {
  setup('/app/help?doc=technical');
  const article = screen.getByRole('article', { name: '技术实现' });
  expect(article).toHaveTextContent('系统技术说明');
  expect(article.textContent).not.toMatch(/程序员|接手者|读者身份|工程接手/);
  expect(article).toHaveTextContent('projectToolConversation');
});

it('preserves code indentation and escapes HTML while rendering handover examples', () => {
  render(<HelpMarkdown value={'说明\n```sql\nSELECT id, status\n  FROM jobs;\n<script>alert(1)</script>\n```\n\n3. 第三步\n4. 第四步'} />);
  const example = screen.getByLabelText('sql 示例');
  expect(example.textContent).toBe('SELECT id, status\n  FROM jobs;\n<script>alert(1)</script>');
  expect(example.querySelector('script')).toBeNull();
  expect(screen.getByRole('list')).toHaveAttribute('start', '3');
});
it('opens the database appendix and gives each table chapter a reachable anchor', () => {
  setup('/app/help?doc=database');
  expect(screen.getByRole('article', { name: '数据库字典' })).toBeInTheDocument();
  const links = within(screen.getByRole('navigation', { name: '章节目录' })).getAllByRole('link');
  expect(links.length).toBeGreaterThan(70);
  for (const link of links) expect(document.getElementById(link.getAttribute('href')!.slice(1))).toBeInTheDocument();
});

it('defaults to user instructions and provides a matching anchor for every chapter', () => {
  setup();
  expect(screen.getByRole('article', { name: '使用说明' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '使用说明' })).toHaveAttribute('aria-current', 'page');
  const links = within(screen.getByRole('navigation', { name: '章节目录' })).getAllByRole('link');
  expect(links.length).toBeGreaterThan(8);
  for (const link of links) expect(document.getElementById(link.getAttribute('href')!.slice(1))).toBeInTheDocument();
});
it('opens the technical deep link and switches documents without carrying a previous search', async () => {
  const router = setup('/app/help?doc=technical&q=D1');
  expect(screen.getByRole('article', { name: '技术实现' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent(/找到 [1-9]/);
  fireEvent.click(screen.getByRole('link', { name: '使用说明' }));
  await screen.findByRole('article', { name: '使用说明' });
  expect(router.state.location.search).toBe('?doc=user');
  expect(screen.getByRole('searchbox', { name: '搜索当前文档' })).toHaveValue('');
});
it('filters chapters, preserves search in the URL and recovers from no results', () => {
  const router = setup();
  fireEvent.change(screen.getByRole('searchbox', { name: '搜索当前文档' }), { target: { value: '不会存在的关键词-12345' } });
  expect(router.state.location.search).toContain('q=');
  expect(screen.getByRole('status')).toHaveTextContent('找到 0 个相关章节');
  expect(screen.getByRole('heading', { name: '未找到相关章节' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '清除搜索' }));
  expect(within(screen.getByRole('navigation', { name: '章节目录' })).getAllByRole('link').length).toBeGreaterThan(8);
});
it('downloads the complete selected document even while search filters its display', () => {
  vi.useFakeTimers();
  const create = vi.fn(() => 'blob:help-test'); const revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) {
    expect(this.download).toBe('TECHNICAL-IMPLEMENTATION.md');
    expect(this.href).toBe('blob:help-test');
  });
  setup('/app/help?doc=technical&q=D1');
  fireEvent.click(screen.getByRole('button', { name: '下载文档' }));
  expect(create).toHaveBeenCalledWith(expect.any(Blob));
  expect((create.mock.calls[0] as unknown as [Blob])[0].size).toBeGreaterThan(5000);
  expect(click).toHaveBeenCalledOnce();
  vi.runAllTimers();
  expect(revoke).toHaveBeenCalledWith('blob:help-test');
  vi.useRealTimers();
});
