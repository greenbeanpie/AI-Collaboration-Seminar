import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PageRenderLimits } from './source-workflows';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('浏览器无法生成页面图片。')), 'image/jpeg', quality);
  });
}

export async function renderPdfPages(
  bytes: Uint8Array,
  pageNumbers: number[],
  limits: PageRenderLimits,
  onPage?: (pageNumber: number) => void,
): Promise<Array<{ pageNumber: number; file: File }>> {
  const loadingTask = getDocument({ data: bytes });
  try {
    const document = await loadingTask.promise;
    if (document.numPages > limits.maxPdfPages) {
      throw new Error(`此 PDF 共 ${document.numPages} 页，超过服务端限制 ${limits.maxPdfPages} 页。`);
    }
    if (document.numPages === 0 || pageNumbers.some((number) => number < 1 || number > document.numPages)) {
      throw new Error('待识别页码与来源 PDF 页数不一致，请重新读取来源并重试。');
    }
    if (!Number.isFinite(limits.pageImageMaxEdge) || limits.pageImageMaxEdge < 1) {
      throw new Error('扫描页长边限制必须至少为 1 像素。');
    }
    const maxCanvasEdge = Math.floor(limits.pageImageMaxEdge);
    const rendered: Array<{ pageNumber: number; file: File }> = [];
    for (const pageNumber of pageNumbers) {
      const page = await document.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        // Leave half a pixel of headroom so ceil() cannot push a fractional viewport past the edge limit.
        let scale = (maxCanvasEdge - 0.5) / Math.max(base.width, base.height);
        let blob: Blob | null = null;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const viewport = page.getViewport({ scale });
          const canvas = globalThis.document.createElement('canvas');
          try {
            canvas.width = Math.max(1, Math.ceil(viewport.width));
            canvas.height = Math.max(1, Math.ceil(viewport.height));
            const context = canvas.getContext('2d');
            if (!context) throw new Error('浏览器无法创建 PDF 页面画布。');
            await page.render({ canvas, canvasContext: context, viewport }).promise;
            for (const quality of [0.86, 0.72, 0.58, 0.45]) {
              blob = await canvasBlob(canvas, quality);
              if (blob.size <= limits.pageImageMaxBytes) break;
            }
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
          if (blob && blob.size <= limits.pageImageMaxBytes) break;
          scale *= 0.82;
        }
        if (!blob || blob.size > limits.pageImageMaxBytes) {
          throw new Error(`第 ${pageNumber} 页无法在当前图片体积限制内生成。`);
        }
        rendered.push({ pageNumber, file: new File([blob], `page-${pageNumber}.jpg`, { type: 'image/jpeg' }) });
        onPage?.(pageNumber);
      } finally {
        page.cleanup();
      }
    }
    return rendered;
  } finally {
    await loadingTask.destroy();
  }
}
