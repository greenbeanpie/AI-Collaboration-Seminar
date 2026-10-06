import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { projectPath, responseError } from '../api/client';
import { ErrorNotice, Spinner } from '../components/ui';
import type { DocumentBlock, DocumentWarning } from './document-parser-types';
import './FilePreview.css';

type FilePreviewProps = { projectId: string; fileId: string; name: string; availability?: 'unavailable' };

/** Preview the original attachment without importing it or changing its material version. */
export function FilePreview({ projectId, fileId, name, availability }: FilePreviewProps) {
  const [attempt, setAttempt] = useState(0);
  const href = projectPath(projectId, `/files/${encodeURIComponent(fileId)}/content`);
  const format = /\.pdf$/i.test(name) ? 'pdf' : /\.docx$/i.test(name) ? 'docx' : null;
  return <section className="file-preview stack tm-hide-print" aria-label={`文件预览：${name}`}>
    <div className="file-preview-heading"><h3>文件预览 · {name}</h3>{availability !== 'unavailable' && <a href={href} download={name}>下载原文件</a>}</div>
    {availability === 'unavailable' ? <p role="status">原文件不可用；历史关联仍保留，请检查附件与回收站。</p> : !format ? <p className="form-note">目前支持 PDF 页面预览和 DOCX 正文预览。此格式请下载原文件查看。</p> : format === 'pdf' ? <PdfPreview key={`${href}:${attempt}`} href={href} onRetry={() => setAttempt(value => value + 1)} /> : <DocxPreview key={`${href}:${name}:${attempt}`} href={href} name={name} onRetry={() => setAttempt(value => value + 1)} />}
  </section>;
}

function PdfPreview({ href, onRetry }: { href: string; onRetry: () => void }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<unknown>();
  const [pageNumber, setPageNumber] = useState(1);
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    void (async () => {
      try {
        const [{ getDocument, GlobalWorkerOptions }, { default: workerSrc }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
        if (cancelled) return;
        GlobalWorkerOptions.workerSrc = workerSrc;
        task = getDocument({ url: href, withCredentials: true });
        const document = await task.promise;
        if (!cancelled) setPdf(document);
      } catch (failure) { if (!cancelled) setError(failure); }
    })();
    return () => { cancelled = true; void task?.destroy().catch(() => undefined); };
  }, [href]);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    const canvas = canvasRef.current;
    void (async () => {
      let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | undefined;
      try {
        page = await pdf.getPage(pageNumber);
        if (cancelled || !canvas) return;
        const base = page.getViewport({ scale: 1 });
        // Render one page at a time and bound canvas memory on phones.
        const viewport = page.getViewport({ scale: Math.min(2, 1999.5 / Math.max(base.width, base.height)) });
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('浏览器无法创建 PDF 预览画布，请下载原文件查看。');
        renderTask = page.render({ canvas, canvasContext: context, viewport });
        await renderTask.promise;
        if (!cancelled) setRenderedPage(pageNumber);
      } catch (failure) { if (!cancelled) setError(failure); }
      finally { page?.cleanup(); }
    })();
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [pdf, pageNumber]);

  return <>
    {error != null ? <ErrorNotice error={error} onRetry={onRetry} /> : <>
      {!pdf ? <Spinner label="读取 PDF 文件" /> : <>
        <nav className="file-preview-pagination" aria-label="PDF 预览翻页">
          <button type="button" className="button button-quiet button-small" disabled={pageNumber === 1} onClick={() => setPageNumber(value => value - 1)}>上一页</button>
          <span aria-live="polite">第 {pageNumber} / {pdf.numPages} 页</span>
          <button type="button" className="button button-quiet button-small" disabled={pageNumber === pdf.numPages} onClick={() => setPageNumber(value => value + 1)}>下一页</button>
        </nav>
        {renderedPage !== pageNumber && <Spinner label={`绘制第 ${pageNumber} 页`} />}
        <canvas key={pageNumber} ref={canvasRef} className="file-preview-canvas" role="img" aria-label={`PDF 第 ${pageNumber} 页`} style={{ visibility: renderedPage === pageNumber ? 'visible' : 'hidden' }} />
      </>}
    </>}
  </>;
}

function DocxPreview({ href, name, onRetry }: { href: string; name: string; onRetry: () => void }) {
  const [blocks, setBlocks] = useState<DocumentBlock[]>([]);
  const [warnings, setWarnings] = useState<DocumentWarning[]>([]);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(href, { credentials: 'include', signal: controller.signal });
        if (!response.ok) throw await responseError(response, '原文件读取失败，请下载或重试。');
        const blob = await response.blob();
        const { parseBrowserDocument } = await import('./browser-document');
        if (controller.signal.aborted) return;
        const result = await parseBrowserDocument(new File([blob], name, { type: blob.type }), {
          signal: controller.signal,
          onBatch: batch => { if (!controller.signal.aborted) setBlocks(previous => [...previous, ...batch.blocks]); },
        });
        if (!controller.signal.aborted) { setWarnings(result.warnings); setComplete(true); }
      } catch (failure) { if (!controller.signal.aborted) setError(failure); }
    })();
    return () => controller.abort();
  }, [href, name]);
  return <>
    <p className="form-note">DOCX 正文预览保留可读取文字，版式、图片和嵌入对象请核对原文件。</p>
    {!complete && error == null && <Spinner label="读取 DOCX 正文" />}
    {blocks.length > 0 && <div className="file-preview-text">{blocks.map((block, index) => <p key={`${block.seq}:${index}`}>{block.text}</p>)}</div>}
    {complete && blocks.length === 0 && <p role="status">未读取到正文，请下载原文件核对。</p>}
    {warnings.length > 0 && <ul className="file-preview-warnings" aria-label="文档读取提示">{warnings.map((warning, index) => <li key={`${warning.code}:${index}`}>{warning.message}</li>)}</ul>}
    {error != null && <ErrorNotice error={error} onRetry={onRetry} />}
  </>;
}
