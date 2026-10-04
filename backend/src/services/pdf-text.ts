import { getResolvedPDFJS, extractText } from 'unpdf';
import cmaps from '../pdf/cmaps.json';
import { AppError } from '../core/errors';

// Adobe CMaps from the repository's pinned pdfjs-dist 6.2.108 distribution.
// Bundled locally: PDF parsing never fetches a CDN, the source URL, or a model.
// See src/pdf/CMAPS-LICENSE.txt for the redistribution notice.
const cmapRegistry: Readonly<Record<string, string>> = cmaps;
const decodedCmaps = new Map<string, Uint8Array>();

export function readBundledCmap(filename: string): Uint8Array {
  const encoded = Object.hasOwn(cmapRegistry, filename) ? cmapRegistry[filename] : undefined;
  if (!encoded) throw new Error('PDF character map unavailable');
  let bytes = decodedCmaps.get(filename);
  if (!bytes) {
    bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    decodedCmaps.set(filename, bytes);
  }
  // PDF.js can transfer ownership; keep the shared cache immutable.
  return bytes.slice();
}

export const hasExtractableText = (text: string): boolean => /[^\s\u0000-\u001f\u007f\ufffd]/u.test(text);

export async function extractPdfText(bytes: Uint8Array): Promise<{ totalPages: number; text: string[] }> {
  let missingCharacterMap = false;
  class BundledBinaryDataFactory {
    async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
      if (kind !== 'cMapUrl') throw new Error('PDF resource unavailable');
      try { return readBundledCmap(filename); } catch {
        missingCharacterMap = true;
        throw new Error('PDF character map unavailable');
      }
    }
  }
  const { getDocument } = await getResolvedPDFJS();
  const task = getDocument({
    data: bytes.slice(), useSystemFonts: true, disableFontFace: true,
    useWorkerFetch: false, cMapPacked: true, BinaryDataFactory: BundledBinaryDataFactory,
  });
  try {
    const pdf = await task.promise;
    const result = await extractText(pdf, { mergePages: false });
    // Font lookup failures can silently drop Chinese while leaving ASCII behind.
    // Do not report such pages as scans or proceed with an incomplete summary.
    if (missingCharacterMap) throw new AppError('SOURCE_PARSE_FAILED', 'PDF 字体字符映射无法解析；原文件已保留，请重试或使用包含完整字体映射的 PDF', 422, false);
    const text = Array.isArray(result.text) ? result.text : [result.text];
    if (text.length !== pdf.numPages) throw new AppError('SOURCE_PARSE_FAILED', 'PDF 页码与提取文本不一致；原文件已保留', 422, false);
    return { totalPages: pdf.numPages, text };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('SOURCE_PARSE_FAILED', 'PDF 解析失败（可能为加密、损坏或不支持的字体）；原文件已保留', 422, false);
  } finally {
    await task.destroy();
  }
}
