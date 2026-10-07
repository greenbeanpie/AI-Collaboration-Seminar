import { projectRequest } from '../api/simplification';
import { api, projectPath } from '../api/client';
import { createIntentKey, downloadSourcePdf, uploadProjectFile } from './source-workflows';
import type { DataOf } from '../api/types';

export type FileProcessingState = {
  fileId: string; lifecycleVersion: number; sourceId: string | null; sourceVersionId: string | null;
  jobId: string | null; textStatus: string; summaryStatus: string; requirementsStatus: string;
  error: string | null; materialIds: string[]; textAvailable: boolean; canProcess: boolean; needsImages: number;
};
export const fileProcessingKey = (projectId: string, fileId: string) => ['fileProcessing', projectId, fileId];
export function getFileProcessing(projectId: string, fileId: string) {
  return projectRequest<FileProcessingState>(projectId, `/files/${encodeURIComponent(fileId)}/processing`, { networkOnly: true });
}
export function startFileProcessing(projectId: string, fileId: string, expectedLifecycleVersion: number, retry = false) {
  if (navigator.onLine === false) throw new Error('请联网后提取正文。');
  return projectRequest<FileProcessingState>(projectId, `/files/${encodeURIComponent(fileId)}/processing`, { method: 'POST', body: { expectedLifecycleVersion, retry }, networkOnly: true });
}
export async function prepareFileScanPages(projectId: string, state: FileProcessingState, limits: DataOf<'CapabilitiesResponse'>['limits'], onProgress: (message: string) => void) {
  if (!state.sourceId || !state.sourceVersionId) throw new Error('请先提取正文，确认扫描页码后再准备页面图片。');
  const sourcePath = `/sources/${encodeURIComponent(state.sourceId)}`;
  const pending = await api.get<'RenderRequestsResponse'>(projectPath(projectId, `${sourcePath}/render-requests`), { sourceVersionId: state.sourceVersionId });
  if (!pending.items.length) return;
  onProgress('正在读取扫描 PDF，请保持页面打开…');
  const pageNumbers = pending.items.slice(0, 30).map(page => page.pageNumber);
  const remaining = pending.items.length - pageNumbers.length;
  const bytes = await downloadSourcePdf(projectId, state.fileId);
  const { iteratePdfPages } = await import('./source-pdf-render');
  const images: { pageNumber: number; fileId: string }[] = [];
  const flush = async () => {
    if (!images.length) return;
    await api.post<'PageImagesResponse'>(projectPath(projectId, `${sourcePath}/page-images`), { sourceVersionId: state.sourceVersionId, images: images.splice(0) }, { idempotencyKey: createIntentKey(), networkOnly: true });
  };
  for await (const image of iteratePdfPages(bytes, pageNumbers, { pageImageMaxEdge: limits.pageImageMaxEdge, pageImageMaxBytes: limits.pageImageMaxBytes, maxPdfPages: null })) {
    onProgress(`正在准备第 ${image.pageNumber} 页，请保持页面打开…`);
    const fileId = await uploadProjectFile(projectId, image.file, undefined, undefined, { derivedFromFileId: state.fileId });
    images.push({ pageNumber: image.pageNumber, fileId });
    if (images.length === 3) await flush();
  }
  await flush();
  onProgress(remaining > 0 ? `本批页面图片已提交，还有 ${remaining} 页待补充，请再次点击准备扫描页。` : '页面图片已提交，后续识别继续在后台处理。');
}
