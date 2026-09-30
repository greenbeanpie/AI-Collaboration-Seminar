import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDocument } from 'pdfjs-dist';
import { renderPdfPages } from './source-pdf-render';

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
