import { renderPdfPages } from '../src/pages/source-pdf-render.ts';

const fileInput = document.querySelector<HTMLInputElement>('#pdf-file')!;
const pageInput = document.querySelector<HTMLInputElement>('#page-number')!;
const maxPagesInput = document.querySelector<HTMLInputElement>('#max-pdf-pages')!;
const maxEdgeInput = document.querySelector<HTMLInputElement>('#page-image-max-edge')!;
const maxBytesInput = document.querySelector<HTMLInputElement>('#page-image-max-bytes')!;
const renderButton = document.querySelector<HTMLButtonElement>('#render-page')!;
const status = document.querySelector<HTMLParagraphElement>('#render-status')!;
const error = document.querySelector<HTMLParagraphElement>('#render-error')!;
const summary = document.querySelector<HTMLDivElement>('#render-summary')!;
const image = document.querySelector<HTMLImageElement>('#rendered-image')!;

let imageUrl: string | null = null;

function readPositiveInteger(input: HTMLInputElement, label: string): number {
  const value = Number(input.value);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(label + '必须是大于 0 的整数。');
  }
  return value;
}

function clearPreview(): void {
  image.removeAttribute('src');
  image.style.display = 'none';
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = null;
}

renderButton.addEventListener('click', async () => {
  error.hidden = true;
  error.textContent = '';
  summary.textContent = '尚无渲染结果。';
  clearPreview();

  const file = fileInput.files?.[0];
  if (!file) {
    error.textContent = '请先选择 PDF 文件。';
    error.hidden = false;
    return;
  }

  renderButton.disabled = true;
  status.textContent = '正在加载 PDF 并渲染页面……';
  try {
    const pageNumber = readPositiveInteger(pageInput, '页码');
    const maxPdfPages = readPositiveInteger(maxPagesInput, 'PDF 页数上限');
    const pageImageMaxEdge = readPositiveInteger(maxEdgeInput, '图片长边上限');
    const pageImageMaxBytes = readPositiveInteger(maxBytesInput, '图片体积上限');
    const rendered = await renderPdfPages(
      new Uint8Array(await file.arrayBuffer()),
      [pageNumber],
      { maxPdfPages, pageImageMaxEdge, pageImageMaxBytes },
    );
    const result = rendered[0];
    if (!result) throw new Error('PDF.js 未返回所选页面。');

    imageUrl = URL.createObjectURL(result.file);
    image.src = imageUrl;
    image.style.display = 'block';
    await image.decode();
    summary.textContent = '第 ' + result.pageNumber + ' 页 · ' + image.naturalWidth + ' × ' + image.naturalHeight + ' 像素 · ' + result.file.size + ' 字节 · ' + result.file.name;
    status.textContent = '页面渲染完成。';
  } catch (cause) {
    clearPreview();
    const message = cause instanceof Error ? cause.message : String(cause);
    error.textContent = message;
    error.hidden = false;
    status.textContent = '页面渲染失败。';
  } finally {
    renderButton.disabled = false;
  }
});

fileInput.addEventListener('change', () => {
  error.hidden = true;
  error.textContent = '';
  summary.textContent = '尚无渲染结果。';
  clearPreview();
  status.textContent = fileInput.files?.[0] ? '已选择 ' + fileInput.files[0].name + '，可开始渲染。' : '请选择 PDF 文件。';
});

window.addEventListener('pagehide', clearPreview);
