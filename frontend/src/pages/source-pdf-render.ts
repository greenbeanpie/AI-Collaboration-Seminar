import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PageRenderLimits } from './source-workflows';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('浏览器无法生成页面图片。')), 'image/jpeg', quality);
  });
}

export type PdfRenderLimits = Omit<PageRenderLimits, 'maxPdfPages'> & { maxPdfPages: number | null };
export type RenderedPdfPage = { pageNumber: number; file: File };
export async function* iteratePdfPages(
  bytes: Uint8Array,
  pageNumbers: number[],
  limits: PdfRenderLimits,
  options: { onPage?: (pageNumber: number) => void; signal?: AbortSignal } = {},
): AsyncGenerator<RenderedPdfPage> {
  const check = () => { if (options.signal?.aborted) throw new DOMException('页面渲染已取消。', 'AbortError'); };
  check();
  const loadingTask = getDocument({ data: bytes });
  const cancel = () => { void loadingTask.destroy(); };
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const document = await loadingTask.promise;
    check();
    if (limits.maxPdfPages !== null && document.numPages > limits.maxPdfPages) {
      throw new Error(`此 PDF 共 ${document.numPages} 页，超过服务端限制 ${limits.maxPdfPages} 页。`);
    }
    if (document.numPages === 0 || pageNumbers.some((number) => !Number.isInteger(number) || number < 1 || number > document.numPages)) {
      throw new Error('待识别页码与来源 PDF 页数不一致，请重新读取来源并重试。');
    }
    if (!Number.isFinite(limits.pageImageMaxEdge) || limits.pageImageMaxEdge < 1) {
      throw new Error('扫描页长边限制必须至少为 1 像素。');
    }
    if (!Number.isFinite(limits.pageImageMaxBytes) || limits.pageImageMaxBytes < 1) throw new Error('扫描页图片体积限制必须至少为 1 字节。');
    const maxCanvasEdge = Math.min(2000, Math.floor(limits.pageImageMaxEdge));
    const maxBytes = Math.min(2 * 1024 * 1024, limits.pageImageMaxBytes);
    for (const pageNumber of pageNumbers) {
      check();
      const page = await document.getPage(pageNumber);
      let rendered: RenderedPdfPage;
      try {
        const base = page.getViewport({ scale: 1 });
        // Leave half a pixel of headroom so ceil() cannot push a fractional viewport past the edge limit.
        let scale = (maxCanvasEdge - 0.5) / Math.max(base.width, base.height);
        let blob: Blob | null = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          check();
          const viewport = page.getViewport({ scale });
          const canvas = globalThis.document.createElement('canvas');
          try {
            canvas.width = Math.max(1, Math.ceil(viewport.width));
            canvas.height = Math.max(1, Math.ceil(viewport.height));
            const context = canvas.getContext('2d');
            if (!context) throw new Error('浏览器无法创建 PDF 页面画布。');
            const renderTask = page.render({ canvas, canvasContext: context, viewport });
            const cancelRender = () => renderTask.cancel();
            options.signal?.addEventListener('abort', cancelRender, { once: true });
            try { await renderTask.promise; } finally { options.signal?.removeEventListener('abort', cancelRender); }
            for (const quality of [0.86, 0.72, 0.58, 0.45]) {
              blob = await canvasBlob(canvas, quality);
              check();
              if (blob.size <= maxBytes) break;
            }
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
          if (blob && blob.size <= maxBytes) break;
          scale *= 0.82;
        }
        if (!blob || blob.size > maxBytes) {
          throw new Error(`第 ${pageNumber} 页无法在当前图片体积限制内生成。`);
        }
        rendered = { pageNumber, file: new File([blob], `page-${pageNumber}.jpg`, { type: 'image/jpeg' }) };
      } finally {
        page.cleanup();
      }
      check();
      options.onPage?.(pageNumber);
      yield rendered;
    }
  } catch (error) {
    check();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    await loadingTask.destroy();
  }
}

export async function renderPdfPages(
  bytes: Uint8Array,
  pageNumbers: number[],
  limits: PdfRenderLimits,
  onPage?: (pageNumber: number) => void,
): Promise<RenderedPdfPage[]> {
  const rendered: RenderedPdfPage[] = [];
  for await (const page of iteratePdfPages(bytes, pageNumbers, limits, { onPage })) rendered.push(page);
  return rendered;
}
