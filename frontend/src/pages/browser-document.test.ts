import { describe, expect, it, vi } from 'vitest';
import { runDocumentParser } from './browser-document';
import type { ParserResponse } from './document-parser-types';

function fakeWorker() {
  const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null as ((event: MessageEvent<ParserResponse>) => Promise<void>) | null, onerror: null, onmessageerror: null };
  return { worker, handle: worker as unknown as Worker, emit: (data: ParserResponse) => worker.onmessage!(new MessageEvent('message', { data })) };
}
const file = new File(['file'], 'test.pdf');
const batch = { batchId: 0, blocks: [{ pageNumber: 1, seq: 0, text: 'text' }] };
const result = { status: 'complete' as const, format: 'pdf' as const, pages: 1, blocks: 1, warnings: [] };
describe('document worker protocol', () => {
  it('acknowledges a batch only after the consumer finishes', async () => {
    const fake = fakeWorker();
    let finish!: () => void;
    const consumer = new Promise<void>(resolve => { finish = resolve; });
    const parse = runDocumentParser(fake.handle, file, { onBatch: () => consumer });
    const delivery = fake.emit({ type: 'batch', batch });
    expect(fake.worker.postMessage).toHaveBeenCalledTimes(1);
    finish();
    await delivery;
    expect(fake.worker.postMessage).toHaveBeenLastCalledWith({ type: 'ack', batchId: 0 });
    await fake.emit({ type: 'done', result });
    await expect(parse).resolves.toEqual(result);
    expect(fake.worker.terminate).toHaveBeenCalledOnce();
  });
  it('rejects out-of-order batches and terminates the worker', async () => {
    const fake = fakeWorker();
    const onBatch = vi.fn();
    const parse = runDocumentParser(fake.handle, file, { onBatch });
    const rejection = expect(parse).rejects.toThrow('批次协议');
    await fake.emit({ type: 'batch', batch: { ...batch, batchId: 2 } });
    await rejection;
    expect(onBatch).not.toHaveBeenCalled();
    expect(fake.worker.terminate).toHaveBeenCalledOnce();
  });
  it('cancels while awaiting an upload without sending a late ACK', async () => {
    const fake = fakeWorker();
    const controller = new AbortController();
    let finish!: () => void;
    const parse = runDocumentParser(fake.handle, file, { signal: controller.signal, onBatch: () => new Promise<void>(resolve => { finish = resolve; }) });
    const rejection = expect(parse).rejects.toMatchObject({ name: 'AbortError' });
    const delivery = fake.emit({ type: 'batch', batch });
    controller.abort();
    finish();
    await delivery;
    await rejection;
    expect(fake.worker.postMessage).toHaveBeenLastCalledWith({ type: 'cancel' });
    expect(fake.worker.terminate).toHaveBeenCalledOnce();
  });
  it('propagates consumer failure and never acknowledges failed persistence', async () => {
    const fake = fakeWorker();
    const parse = runDocumentParser(fake.handle, file, { onBatch: async () => { throw new Error('upload failed'); } });
    const rejection = expect(parse).rejects.toThrow('upload failed');
    await fake.emit({ type: 'batch', batch });
    await rejection;
    expect(fake.worker.postMessage).toHaveBeenCalledTimes(1);
  });
});
