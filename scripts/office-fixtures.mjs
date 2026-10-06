import * as XLSX from '../frontend/node_modules/xlsx/xlsx.mjs';
import { ZipWriter, Uint8ArrayWriter, TextReader } from '../frontend/node_modules/@zip.js/zip.js/index.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function buildOfficeFixtures() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['项目', '数量'], ['中文 & data', 42], [null, 84]]);
  sheet.B3.f = 'B2*2';
  sheet.C4 = { t: 'n', f: 'B2+1' };
  XLSX.utils.book_append_sheet(workbook, sheet, '预算');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['隐藏的证据']]), '内部');
  workbook.Workbook = { Sheets: [{ name: '预算', Hidden: 0 }, { name: '内部', Hidden: 1 }] };
  const xlsx = { name: 'office-evidence.xlsx', bytes: new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })), expectedText: '中文 & data' };
  const relNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const officeNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const pNS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const aNS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const paragraph = value => `<a:p><a:r><a:t>${value}</a:t></a:r></a:p>`;
  const shape = (value, placeholder = '') => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraph(value)}</p:txBody></p:sp>`;
  const slide = value => `<p:sld xmlns:p="${pNS}" xmlns:a="${aNS}" xmlns:r="${officeNS}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shape(value)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  const parts = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${relNS}"><Relationship Id="rId1" Type="${officeNS}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="${pNS}" xmlns:r="${officeNS}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${relNS}"><Relationship Id="rId1" Type="${officeNS}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${officeNS}/slide" Target="slides/slide2.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': slide('第二页中文'),
    'ppt/slides/slide2.xml': slide('第一页 &amp; evidence'),
    'ppt/slides/_rels/slide2.xml.rels': `<Relationships xmlns="${relNS}"><Relationship Id="notes" Type="${officeNS}/notesSlide" Target="../notesSlides/notesSlide2.xml"/></Relationships>`,
    'ppt/notesSlides/notesSlide2.xml': `<p:notes xmlns:p="${pNS}" xmlns:a="${aNS}"><p:cSld><p:spTree>${shape('演讲备注证据', '<p:ph type="body"/>')}${shape('99', '<p:ph type="sldNum"/>')}</p:spTree></p:cSld></p:notes>`,
  };
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, value] of Object.entries(parts)) await writer.add(name, new TextReader(value), { level: 0 });
  const pptx = { name: 'office-evidence.pptx', bytes: await writer.close(), expectedText: '演讲备注证据' };
  return { xlsx, pptx, pptxParts: parts };
}
export async function officeFixtures() {
  const { xlsx, pptx } = await buildOfficeFixtures();
  return [xlsx, pptx];
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2] || '.tmp/office-fixtures';
  await mkdir(directory, { recursive: true });
  const { xlsx, pptx } = await buildOfficeFixtures();
  for (const fixture of [xlsx, pptx]) await writeFile(`${directory}/${fixture.name}`, fixture.bytes);
  console.log(`Created ${xlsx.name} and ${pptx.name} in ${directory}`);
}
