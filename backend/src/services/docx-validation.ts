import { inflateRawSync } from 'node:zlib';
import { unsupportedMediaType } from '../core/errors';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
type Reader = (offset: number, length: number) => Promise<Uint8Array>;

/** Read ZIP directory and only package metadata, never inflate the document/media. */
export async function validateDocx(size: number, source: Reader): Promise<string> {
  let cache:Uint8Array = new Uint8Array(), cacheStart = -1;
  const read:Reader=async(offset,length)=>{
    if(offset<0||length<0||offset+length>size)throw unsupportedMediaType('DOCX 包偏移无效');
    if(offset>=cacheStart&&offset+length<=cacheStart+cache.length)return cache.slice(offset-cacheStart,offset-cacheStart+length);
    cacheStart=offset;cache=await source(offset,Math.min(size-offset,Math.max(length,65536)));
    return cache.slice(0,length);
  };
  const fail = () => { throw unsupportedMediaType('DOCX 包结构无效、加密或不支持的 ZIP 格式；原文件不能作为可用资料'); };
  const tailStart = Math.max(0, size - 65557), tail = await read(tailStart, size - tailStart);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === tail.length) { eocd = i; break; }
  if (eocd < 0) return fail();
  if (view.getUint16(eocd + 4, true) || view.getUint16(eocd + 6, true)) return fail();
  const entries = view.getUint16(eocd + 10, true), directorySize = view.getUint32(eocd + 12, true);
  let pos = view.getUint32(eocd + 16, true);
  if (entries === 65535 || pos === 0xffffffff || pos + directorySize > tailStart + eocd) return fail();
  let document = false, types: { offset: number; compressed: number; method: number; expanded: number } | undefined;
  for (let i = 0; i < entries; i++) {
    const b = await read(pos, 46); if (b.length !== 46) return fail();
    const h = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (h.getUint32(0, true) !== 0x02014b50 || (h.getUint16(8, true) & 1)) return fail();
    const nameLength = h.getUint16(28, true), extra = h.getUint16(30, true), comment = h.getUint16(32, true);
    if (!nameLength || nameLength > 4096) return fail();
    const name = new TextDecoder().decode(await read(pos + 46, nameLength));
    if (name === 'word/document.xml') document = true;
    if (name === '[Content_Types].xml') types = { offset: h.getUint32(42, true), compressed: h.getUint32(20, true), expanded: h.getUint32(24, true), method: h.getUint16(10, true) };
    pos += 46 + nameLength + extra + comment;
    if (pos > size) return fail();
  }
  if (!document || !types || types.compressed > 262144 || types.expanded > 262144) return fail();
  const b = await read(types.offset, 30), h = new DataView(b.buffer,b.byteOffset,b.byteLength);
  if (b.length !== 30 || h.getUint32(0,true) !== 0x04034b50) return fail();
  const data = await read(types.offset + 30 + h.getUint16(26,true) + h.getUint16(28,true),types.compressed);
  let decoded: Uint8Array;
  try { decoded = types.method === 0 ? data : types.method === 8 ? inflateRawSync(data,{maxOutputLength:262144}) : fail(); } catch { return fail(); }
  const xml = new TextDecoder().decode(decoded);
  if (!/PartName\s*=\s*["']\/word\/document\.xml["']/.test(xml) || !xml.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) return fail();
  return DOCX_MIME;
}
