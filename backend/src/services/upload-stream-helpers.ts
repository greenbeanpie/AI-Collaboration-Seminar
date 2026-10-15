import { sha256Hex } from '../core/db';

export interface MultipartPartRecord {
  partNumber: number;
  etag: string;
  sizeBytes: number;
}

/** Compute expected byte length of a 1-indexed multipart upload part. */
export function expectedPartBytes(totalBytes: number, partBytes: number, partNumber: number): number {
  return Math.min(partBytes, totalBytes - (partNumber - 1) * partBytes);
}

/** Verify that all expected multipart segments are present in order and match expected sizes. */
export function hasCompleteMultipartParts(
  parts: MultipartPartRecord[],
  totalBytes: number,
  partBytes: number,
): boolean {
  const expectedCount = Math.ceil(totalBytes / partBytes);
  if (parts.length !== expectedCount) return false;
  return !parts.some((p, i) => p.partNumber !== i + 1 || p.sizeBytes !== expectedPartBytes(totalBytes, partBytes, i + 1));
}

/** Pipe a stream through a FixedLengthStream into an R2 multipart upload part while counting transferred bytes. */
export async function pipeFixedLengthPart(
  body: ReadableStream<Uint8Array>,
  expectedLength: number,
  uploadPart: (readable: ReadableStream<Uint8Array>) => Promise<R2UploadedPart>,
  options: { abortOnFailure?: boolean } = {},
): Promise<{ part: R2UploadedPart; actualBytes: number }> {
  let actualBytes = 0;
  const fixed = new FixedLengthStream(expectedLength);
  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        actualBytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  const controller = new AbortController();
  const transfer = counted.pipeTo(fixed.writable, options.abortOnFailure ? { signal: controller.signal } : undefined);
  const upload = uploadPart(fixed.readable);
  try {
    const [part] = await Promise.all([upload, transfer]);
    return { part, actualBytes };
  } catch (error) {
    if (options.abortOnFailure) {
      controller.abort(error);
      await Promise.allSettled([upload, transfer]);
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { actualBytes });
  }
}

/** Validate that a readable stream contains valid fatal UTF-8 text without buffering the entire body in memory. */
export async function validateUtf8Stream(
  body: ReadableStream<Uint8Array>,
  onInvalidUtf8: () => Error,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      decoder.decode(value, { stream: true });
    }
    decoder.decode();
  } catch {
    throw onInvalidUtf8();
  } finally {
    reader.releaseLock();
  }
}

/** Split text into non-blank Unicode code-point chunks of at most `chunkSize` code points. */
export function splitCodePointChunks(text: string, chunkSize = 600): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let offset = 0; offset < chars.length; offset += chunkSize) {
    const slice = chars.slice(offset, offset + chunkSize).join('');
    if (slice.trim()) chunks.push(slice);
  }
  return chunks;
}

/** Compute SHA-256 hex digest of a document import block batch. */
export async function computeImportBatchDigest(blocks: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(blocks));
}
