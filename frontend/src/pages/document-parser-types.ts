export type DocumentWarning = { code: string; message: string; pageNumber?: number | null };
export type DocumentBlock = {
  pageNumber: number | null;
  seq: number;
  text: string;
  headingPath?: string[];
  warnings?: DocumentWarning[];
};
export type DocumentBatch = { batchId: number; blocks: DocumentBlock[] };
export type DocumentProgress = { phase: 'reading' | 'parsing'; completed: number; total: number | null };
export type BrowserDocumentResult = {
  status: 'complete' | 'partial';
  format: 'pdf' | 'docx';
  pages: number | null;
  blocks: number;
  warnings: DocumentWarning[];
};
export type ParserRequest =
  | { type: 'parse'; file: File }
  | { type: 'ack'; batchId: number }
  | { type: 'cancel' };
export type ParserResponse =
  | { type: 'batch'; batch: DocumentBatch }
  | { type: 'progress'; progress: DocumentProgress }
  | { type: 'done'; result: BrowserDocumentResult }
  | { type: 'error'; message: string; name?: string };

// Cloud conversion recommendations, never enforced by browser extraction.
export const CLOUD_PDF_RECOMMENDATION = { maxBytes: 10 * 1024 * 1024, maxPages: 30 } as const;
export function cloudPdfRecommendation(size: number, pages: number): string | null {
  return size > CLOUD_PDF_RECOMMENDATION.maxBytes || pages > CLOUD_PDF_RECOMMENDATION.maxPages
    ? '建议将云端 PDF 分为不超过 10 MiB、30 页的批次；浏览器读取不受此建议限制。' : null;
}
