import type { BrowserDocumentResult, DocumentBatch, DocumentProgress, ParserRequest, ParserResponse } from './document-parser-types';
export type BrowserDocumentOptions = {
  signal?: AbortSignal;
  onBatch: (batch: DocumentBatch) => Promise<void> | void;
  onProgress?: (progress: DocumentProgress) => void;
};

/** Each callback must finish (including uploads) before the next batch is produced. */
export function parseBrowserDocument(file: File, options: BrowserDocumentOptions): Promise<BrowserDocumentResult> {
  return runDocumentParser(new Worker(new URL('./document-parser.worker.ts', import.meta.url), { type: 'module' }), file, options);
}

// Exported separately so protocol/cancellation tests do not need a real browser Worker.
export function runDocumentParser(worker: Worker, file: File, options: BrowserDocumentOptions): Promise<BrowserDocumentResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let awaitingBatch = false;
    let nextBatchId = 0;
    const cleanup = () => {
      options.signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const send = (message: ParserRequest) => worker.postMessage(message);
    const abort = () => {
      send({ type: 'cancel' });
      fail(new DOMException('文档读取已取消。', 'AbortError'));
    };
    worker.onerror = (event) => fail(new Error(event.message || '浏览器解析进程失败，可能是设备内存不足。'));
    worker.onmessageerror = () => fail(new Error('浏览器解析进程返回了无法读取的数据。'));
    worker.onmessage = async (event: MessageEvent<ParserResponse>) => {
      if (settled) return;
      const message = event.data;
      try {
        if (message.type === 'batch') {
          if (awaitingBatch || message.batch.batchId !== nextBatchId) throw new Error('文档解析批次协议错误。');
          awaitingBatch = true;
          await options.onBatch(message.batch);
          if (settled) return;
          awaitingBatch = false;
          nextBatchId += 1;
          send({ type: 'ack', batchId: message.batch.batchId });
        } else if (message.type === 'progress') {
          options.onProgress?.(message.progress);
        } else if (message.type === 'error') {
          const error = new Error(message.message);
          error.name = message.name || 'Error';
          fail(error);
        } else if (message.type === 'done') {
          if (awaitingBatch) throw new Error('文档解析在批次确认前结束。');
          settled = true;
          cleanup();
          resolve(message.result);
        } else {
          throw new Error('未知文档解析消息。');
        }
      } catch (error) {
        fail(error);
      }
    };
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener('abort', abort, { once: true });
    try { send({ type: 'parse', file }); } catch (error) { fail(error); }
  });
}
