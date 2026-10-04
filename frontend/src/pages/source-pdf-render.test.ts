import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDocument } from 'pdfjs-dist';
import { iteratePdfPages, renderPdfPages } from './source-pdf-render';

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'mock-worker.mjs' }));

const mockedGetDocument = vi.mocked(getDocument);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('renderPdfPages cleanup and bounds', () => {
  it('does not render the next page until requested and destroys the document on early iterator return', async () => {
    const page = { getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }), render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })), cleanup: vi.fn() };
    const getPage = vi.fn().mockResolvedValue(page);
    const destroy = vi.fn().mockResolvedValue(undefined);
    mockedGetDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 40, getPage }), destroy } as unknown as ReturnType<typeof getDocument>);
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({}), toBlob: (callback: BlobCallback) => callback(new Blob(['jpeg'])) }) });
    const iterator = iteratePdfPages(new Uint8Array([1]), [1, 2], { maxPdfPages: null, pageImageMaxEdge: 2000, pageImageMaxBytes: 2 * 1024 * 1024 });
    const first = await iterator.next();
    expect(first.value).toMatchObject({ pageNumber: 1 });
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(page.cleanup).toHaveBeenCalledOnce();
    await iterator.return(undefined);
    expect(destroy).toHaveBeenCalledOnce();
    expect(getPage).toHaveBeenCalledTimes(1);
  });
  it('honors pre-aborted cancellation without allocating a loading task', async () => {
    const controller = new AbortController();
    controller.abort();
    const iterator = iteratePdfPages(new Uint8Array([1]), [1], { maxPdfPages: null, pageImageMaxEdge: 2000, pageImageMaxBytes: 2 * 1024 * 1024 }, { signal: controller.signal });
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockedGetDocument).not.toHaveBeenCalled();
  });
  it('destroys the loading task when loading rejects', async () => {
    const failure = new Error('password required');
    const task = {
      promise: Promise.reject(failure),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    mockedGetDocument.mockReturnValue(task as unknown as ReturnType<typeof getDocument>);

    await expect(renderPdfPages(new Uint8Array([1]), [1], {
      maxPdfPages: 10,
      pageImageMaxEdge: 1000,
      pageImageMaxBytes: 1024,
    })).rejects.toBe(failure);

    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it('keeps the ceil-rounded canvas within the configured long edge and cleans up the page', async () => {
    const renderedCanvasSizes: Array<[number, number]> = [];
    const page = {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 1000.00000000001 * scale,
        height: 600 * scale,
      })),
      render: vi.fn(({ canvas }: { canvas: HTMLCanvasElement }) => {
        renderedCanvasSizes.push([canvas.width, canvas.height]);
        return { promise: Promise.resolve() };
      }),
      cleanup: vi.fn(),
    };
    const pdf = {
      numPages: 1,
      getPage: vi.fn().mockResolvedValue(page),
    };
    const task = {
      promise: Promise.resolve(pdf),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
    mockedGetDocument.mockReturnValue(task as unknown as ReturnType<typeof getDocument>);

    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({}),
        toBlob: (callback: BlobCallback) => callback(new Blob(['jpeg'])),
      }),
    } as unknown as Document);

    const rendered = await renderPdfPages(new Uint8Array([1]), [1], {
      maxPdfPages: 10,
      pageImageMaxEdge: 1000,
      pageImageMaxBytes: 1024,
    });

    expect(rendered).toHaveLength(1);
    expect(renderedCanvasSizes).toEqual([[1000, 600]]);
    expect(Math.max(...renderedCanvasSizes[0]!)).toBeLessThanOrEqual(1000);
    expect(page.cleanup).toHaveBeenCalledOnce();
    expect(task.destroy).toHaveBeenCalledOnce();
  });
});
