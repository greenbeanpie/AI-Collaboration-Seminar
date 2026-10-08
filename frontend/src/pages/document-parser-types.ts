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
  format: 'pdf' | 'docx' | 'xlsx' | 'pptx';
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

