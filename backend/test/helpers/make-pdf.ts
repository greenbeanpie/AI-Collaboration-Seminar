/**
 * 生成结构合法的多页 PDF（Helvetica 标准字体 + ASCII 文本），
 * 用于 unpdf 文本层提取的 CPU/耗时 spike。仅使用 ASCII，保证字节偏移 == 字符数。
 */
export function makePdf(pageCount: number): Uint8Array {
  const objects: string[] = [];
  const put = (n: number, body: string) => {
    objects[n] = `${n} 0 obj\n${body}\nendobj\n`;
  };

  put(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = Array.from({ length: pageCount }, (_, i) => `${4 + i * 2} 0 R`).join(' ');
  put(2, `<< /Type /Pages /Kids [ ${kids} ] /Count ${pageCount} >>`);
  put(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  for (let i = 0; i < pageCount; i++) {
    const text = `Page ${i + 1}: submit the signed form before the deadline 2026-10-08. Team size is five members.`;
    const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    put(
      4 + i * 2,
      `<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 612 792 ] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    put(5 + i * 2, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = out.length;
    out += objects[n] ?? '';
  }
  const xrefStart = out.length;
  const size = objects.length;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) {
    out += `${String(offsets[n] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
