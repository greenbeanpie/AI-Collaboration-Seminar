import { MAX_TICKET_IMAGE_BYTES, ticketImageTypes } from '../../../shared/support-tickets';
import { fileTooLarge, unsupportedMediaType, validationFailed } from '../core/errors';

// Do not trust Content-Length: cap the actual streamed bytes before buffering in memory.
export async function readTicketImage(request: Request): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: typeof ticketImageTypes[number] }> {
  const contentType = request.headers.get('content-type')?.toLowerCase();
  if (!ticketImageTypes.includes(contentType as typeof ticketImageTypes[number])) throw unsupportedMediaType('仅支持 PNG、JPEG 和 WebP 图片');
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_TICKET_IMAGE_BYTES)) throw fileTooLarge(MAX_TICKET_IMAGE_BYTES);
  if (!request.body) throw validationFailed('图片不能为空');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_TICKET_IMAGE_BYTES) { await reader.cancel(); throw fileTooLarge(MAX_TICKET_IMAGE_BYTES); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw validationFailed('图片不能为空');
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  validateTicketImage(bytes, contentType!);
  return { bytes, contentType: contentType as typeof ticketImageTypes[number] };
}

// Validate the raster container and dimensions, never filenames or client MIME alone.
// Only these types are ever served, with nosniff and a restrictive document CSP.
export function validateTicketImage(bytes: Uint8Array, type: string): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  let width = 0, height = 0;
  if (type === 'image/png' && bytes.length >= 45 && [137,80,78,71,13,10,26,10].every((n, i) => bytes[i] === n)) {
    let offset = 8, data = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset); const kind = ascii(offset + 4, 4);
      if (length > bytes.length - offset - 12) break;
      if (offset === 8) {
        if (kind !== 'IHDR' || length !== 13) break;
        width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      }
      if (kind === 'IDAT' && length > 0) data = true;
      offset += length + 12;
      if (kind === 'IEND') { ended = length === 0 && offset === bytes.length; break; }
    }
    if (!data || !ended) width = 0;
  } else if (type === 'image/jpeg' && bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    let offset = 2, hasScan = false;
    while (offset + 4 <= bytes.length && bytes[offset] === 255) {
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2].includes(marker) && length >= 8) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
      }
      if (marker === 0xda) { hasScan = length >= 6 && offset + length < bytes.length - 2; break; }
      offset += length;
    }
    if (!hasScan) width = 0;
  } else if (type === 'image/webp' && bytes.length >= 26 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' && view.getUint32(4, true) + 8 === bytes.length) {
    const chunkSize = view.getUint32(16, true);
    if (chunkSize <= bytes.length - 20) {
      if (ascii(12, 4) === 'VP8 ' && chunkSize >= 10 && bytes.length >= 30 && ascii(23, 3) === '\x9d\x01\x2a') {
        width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
      } else if (ascii(12, 4) === 'VP8L' && chunkSize >= 5 && bytes[20] === 0x2f) {
        const dimensions = view.getUint32(21, true); width = (dimensions & 0x3fff) + 1; height = ((dimensions >>> 14) & 0x3fff) + 1;
      } else if (ascii(12, 4) === 'VP8X' && bytes.length >= 30 && chunkSize === 10 && !(bytes[20]! & 2)) {
        // Extended containers must also contain actual image data, not just a header.
        width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
        height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
        let offset = 30, hasImage = false;
        while (offset + 8 <= bytes.length) {
          const kind = ascii(offset, 4), size = view.getUint32(offset + 4, true);
          if (size > bytes.length - offset - 8 || kind === 'ANIM' || kind === 'ANMF') break;
          if ((kind === 'VP8 ' && size >= 10 && ascii(offset + 11, 3) === '\x9d\x01\x2a') || (kind === 'VP8L' && size >= 5 && bytes[offset + 8] === 0x2f)) hasImage = true;
          offset += 8 + size + (size % 2);
        }
        if (!hasImage || offset !== bytes.length) width = 0;
      }
    }
  }
  if (!width || !height || width > 12000 || height > 12000 || width * height > 40_000_000) throw unsupportedMediaType('图片内容无效、格式不匹配或尺寸过大；请使用静态 PNG、JPEG 或 WebP 图片');
}
