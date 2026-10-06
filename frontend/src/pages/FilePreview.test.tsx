import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getDocument } from 'pdfjs-dist';
import { parseBrowserDocument } from './browser-document';
import { FilePreview } from './FilePreview';

vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: vi.fn() }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.mjs' }));
vi.mock('./browser-document', () => ({ parseBrowserDocument: vi.fn() }));
const props = { projectId: 'p', fileId: 'file-1', name: '扫描报告.pdf' };
const pdfLoader = vi.mocked(getDocument), parser = vi.mocked(parseBrowserDocument);
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); pdfLoader.mockReset(); parser.mockReset(); });

function pdfFixture(pages = 2, rendering?: Promise<void>) {
  const page = { getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render: vi.fn(() => ({ promise: rendering ?? Promise.resolve(), cancel: vi.fn() })), cleanup: vi.fn() };
  const pdf = { numPages: pages, getPage: vi.fn().mockResolvedValue(page) };
  const task = { promise: Promise.resolve(pdf), destroy: vi.fn().mockResolvedValue(undefined) };
  pdfLoader.mockReturnValue(task as unknown as ReturnType<typeof getDocument>);
  return { pdf, page, task };
}

it('renders PDF pages including scans without requesting extracted text, with bounded pagination', async () => {
  const { pdf, page, task } = pdfFixture();
  const view = render(<FilePreview {...props} />);
  await waitFor(() => expect(screen.getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible());
  expect(pdfLoader).toHaveBeenCalledWith({ url: '/api/v1/projects/p/files/file-1/content', withCredentials: true });
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  expect(page.render).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(screen.getByRole('img', { name: 'PDF 第 2 页' })).toBeVisible());
  expect(pdf.getPage.mock.calls.map(call => call[0])).toEqual([1, 2]);
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
  const canvas = screen.getByRole('img') as HTMLCanvasElement;
  expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(2000);
  view.unmount();
  expect(task.destroy).toHaveBeenCalledOnce();
});

it('keeps the original download and retries a PDF load error', async () => {
  pdfLoader.mockReturnValueOnce({ promise: Promise.reject(new Error('原文件内容缺失')), destroy: vi.fn().mockResolvedValue(undefined) } as unknown as ReturnType<typeof getDocument>);
  render(<FilePreview {...props} />);
  expect(await screen.findByText('原文件内容缺失')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '下载原文件' })).toHaveAttribute('download', props.name);
  pdfFixture(1);
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(screen.getByRole('img', { name: 'PDF 第 1 页' })).toBeVisible());
  expect(pdfLoader).toHaveBeenCalledTimes(2);
});

it('cancels an in-flight PDF page render and clears its canvas on file switching', async () => {
  let resolve!: () => void;
  const { page, task } = pdfFixture(2, new Promise<void>(done => { resolve = done; }));
  const view = render(<FilePreview {...props} />);
  await waitFor(() => expect(page.render).toHaveBeenCalledOnce());
  view.rerender(<FilePreview {...props} fileId="file-2" name="备注.txt" />);
  expect(task.destroy).toHaveBeenCalledOnce();
  expect(page.render.mock.results[0].value.cancel).toHaveBeenCalledOnce();
  expect(screen.queryByRole('img')).toBeNull();
  await act(async () => resolve());
  expect(screen.queryByText('原文件内容缺失')).toBeNull();
});

it('previews DOCX text safely and exposes partial reading warnings without writing import records', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('docx bytes'));
  vi.stubGlobal('fetch', fetcher);
  parser.mockImplementation(async (_file, options) => {
    await options.onBatch({ batchId: 0, blocks: [{ seq: 0, pageNumber: null, text: '<script>正文</script>\n表格内容' }] });
    return { status: 'partial', format: 'docx', pages: null, blocks: 1, warnings: [{ code: 'images-not-read', message: '图片已跳过，请核对原文。' }] };
  });
  render(<FilePreview {...props} name="成果.docx" />);
  expect(await screen.findByText(/<script>正文<\/script>/)).toBeInTheDocument();
  expect(document.querySelector('.file-preview-text script')).toBeNull();
  expect(screen.getByLabelText('文档读取提示')).toHaveTextContent('图片已跳过');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'include' });
  expect(fetcher.mock.calls[0][1].method).toBeUndefined();
  expect(parser.mock.calls[0][0].name).toBe('成果.docx');
});

it('aborts DOCX parsing on switching and rejects stale returned blocks', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('docx bytes')));
  let finish!: () => void;
  parser.mockImplementation(async (_file, options) => {
    await new Promise<void>(resolve => { finish = resolve; });
    await options.onBatch({ batchId: 0, blocks: [{ seq: 0, pageNumber: null, text: '过期文件正文' }] });
    return { status: 'complete', format: 'docx', pages: null, blocks: 1, warnings: [] };
  });
  const view = render(<FilePreview {...props} name="旧成果.docx" />);
  await waitFor(() => expect(parser).toHaveBeenCalledOnce());
  const signal = parser.mock.calls[0][1].signal!;
  view.rerender(<FilePreview {...props} fileId="file-2" name="新成果.txt" />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish());
  expect(screen.queryByText('过期文件正文')).toBeNull();
});

it('reports a DOCX download failure and recovers after retrying', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: '文件已回收', code: 'NOT_FOUND' } }), { status: 404, headers: { 'content-type': 'application/json' } })).mockResolvedValueOnce(new Response('docx bytes'));
  vi.stubGlobal('fetch', fetcher);
  parser.mockResolvedValue({ status: 'complete', format: 'docx', pages: null, blocks: 0, warnings: [] });
  render(<FilePreview {...props} name="成果.docx" />);
  expect(await screen.findByText('文件已回收')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('未读取到正文，请下载原文件核对。')).toBeInTheDocument();
});

it('does not fetch unsupported or unavailable files and gives explicit viewing guidance', () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const view = render(<FilePreview {...props} name="成果.mp4" />);
  expect(screen.getByText(/此格式请下载原文件查看/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '下载原文件' })).toBeInTheDocument();
  view.rerender(<FilePreview {...props} availability="unavailable" />);
  expect(screen.getByText(/原文件不可用/)).toBeInTheDocument();
  expect(screen.queryByRole('link')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(pdfLoader).not.toHaveBeenCalled();
});
