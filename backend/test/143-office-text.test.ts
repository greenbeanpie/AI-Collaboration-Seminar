import { describe,it,expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { extractOfficeText } from '../src/services/office-text';
import { OFFICE_PACKAGES } from '../src/services/docx-validation';
function zip(entries:Record<string,string>, compress=false) {
 const chunks:Uint8Array[]=[],central:Uint8Array[]=[];let offset=0;
 for(const [name,text] of Object.entries(entries)){
  const n=new TextEncoder().encode(name),b=new TextEncoder().encode(text);let crc=0xffffffff;
  for(const byte of b){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
  const data=compress?deflateRawSync(b):b;
  const local=new Uint8Array(30+n.length+data.length),l=new DataView(local.buffer);
  l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint16(8,compress?8:0,true);l.setUint32(14,crc,true);l.setUint32(18,data.length,true);l.setUint32(22,b.length,true);l.setUint16(26,n.length,true);local.set(n,30);local.set(data,30+n.length);
  const dir=new Uint8Array(46+n.length),d=new DataView(dir.buffer);d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint16(10,compress?8:0,true);d.setUint32(16,crc,true);d.setUint32(20,data.length,true);d.setUint32(24,b.length,true);d.setUint16(28,n.length,true);d.setUint32(42,offset,true);dir.set(n,46);
  chunks.push(local);central.push(dir);offset+=local.length;
 }
 const directoryLength=central.reduce((a,b)=>a+b.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,central.length,true);e.setUint16(10,central.length,true);e.setUint32(12,directoryLength,true);e.setUint32(16,offset,true);
 const bytes=new Uint8Array(offset+directoryLength+22);let pos=0;for(const b of [...chunks,...central,end]){bytes.set(b,pos);pos+=b.length;}return bytes;
}
function office(ext: keyof typeof OFFICE_PACKAGES, parts: Record<string,string>) {
 const spec=OFFICE_PACKAGES[ext]; return zip({'[Content_Types].xml':`<Types><Override PartName="/${spec.part}" ContentType="${spec.contentType}"/></Types>`,...parts});
}
describe('server Office body extraction',()=>{
 it('inflates deflated parts with bounded output in Workers',async()=>{
  const spec=OFFICE_PACKAGES['.docx']; const bytes=zip({'[Content_Types].xml':`<Types><Override PartName="/${spec.part}" ContentType="${spec.contentType}"/></Types>`,[spec.part]:'<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>压缩正文</w:t></w:r></w:p></w:body></w:document>'},true);
  expect((await extractOfficeText(bytes,'.docx')).blocks[0]?.text).toBe('压缩正文');
 });
 it('rejects corrupt stored text using ZIP CRC',async()=>{
  const bytes=office('.docx',{'word/document.xml':'<w:document xmlns:w="w"><w:body/></w:document>'});const view=new DataView(bytes.buffer);let offset=0;while(view.getUint32(offset,true)!==0x02014b50)offset++;view.setUint32(offset+16,0,true);await expect(extractOfficeText(bytes,'.docx')).rejects.toThrow('校验');
 });
 it('reads DOCX paragraphs, headings, tables and XML escapes without inventing pages',async()=>{
  const result=await extractOfficeText(office('.docx',{'word/document.xml':'<w:document xmlns:w="w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p><w:p><w:r><w:t>正文 &amp; 内容</w:t><w:tab/><w:t>文本</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'}),'.docx');
  expect(result.blocks.map(b=>b.text)).toEqual(['标题','正文 & 内容\t文本','表格']);
  expect(result.blocks[2]?.headingPath).toEqual(['标题','表格']); expect(result.blocks[0]).not.toHaveProperty('pageNumber');
 });
 it('reads XLSX shared and inline strings in workbook sheet order, preserves formula cache',async()=>{
  const result=await extractOfficeText(office('.xlsx',{
   'xl/workbook.xml':'<workbook xmlns:r="r"><sheets><sheet name="调查" r:id="s"/></sheets></workbook>',
   'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="s" Type="x/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
   'xl/sharedStrings.xml':'<sst><si><r><t>真实</t></r><r><t>文本</t></r></si></sst>',
   'xl/worksheets/sheet2.xml':'<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>体验</t></is></c><c r="C1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>',
  }),'.xlsx');
  expect(result.blocks.map(b=>b.text)).toEqual(['真实文本','体验','2']); expect(result.blocks[0]?.headingPath).toEqual(['调查','A1']); expect(result.warnings.join('')).toContain('不重新计算');
 });
 it('follows PPTX presentation relationships instead of lexical filename order',async()=>{
  const result=await extractOfficeText(office('.pptx',{
   'ppt/presentation.xml':'<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="b"/><p:sldId r:id="a"/></p:sldIdLst></p:presentation>',
   'ppt/_rels/presentation.xml.rels':'<Relationships><Relationship Id="a" Type="x/slide" Target="slides/slide1.xml"/><Relationship Id="b" Type="x/slide" Target="slides/slide2.xml"/></Relationships>',
   'ppt/slides/slide1.xml':'<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>第二张</a:t></a:r></a:p></p:sld>',
   'ppt/slides/slide2.xml':'<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>第一张</a:t></a:r></a:p></p:sld>',
  }),'.pptx'); expect(result.blocks.map(b=>b.text)).toEqual(['第一张','第二张']); expect(result.blocks[1]?.headingPath).toEqual(['幻灯片 2']);
 });
 it('reports documents without text',async()=>{const result=await extractOfficeText(office('.docx',{'word/document.xml':'<w:document xmlns:w="w"><w:body/></w:document>'}),'.docx');expect(result.blocks).toEqual([]);expect(result.warnings.join('')).toContain('没有可读取正文');});
 it.each(['<!DOCTYPE a [<!ENTITY x "unsafe">]><a>&x;</a>','<a>broken</b>'])('rejects unsafe or invalid XML',async text=>{await expect(extractOfficeText(office('.docx',{'word/document.xml':text}),'.docx')).rejects.toThrow('XML');});
 it('rejects encrypted, path traversal, and expanded size abuse before decoding',async()=>{
  await expect(extractOfficeText(office('.docx',{'word/document.xml':'<a/>','../outside':'x'}),'.docx')).rejects.toThrow('路径');
  for(const [field,amount] of [[8,1],[24,17*1024*1024]] as const){const bytes=office('.docx',{'word/document.xml':'<a/>'});const v=new DataView(bytes.buffer);let pos=0;while(v.getUint32(pos,true)!==0x02014b50)pos++;if(field===8)v.setUint16(pos+field,amount,true);else v.setUint32(pos+field,amount,true);await expect(extractOfficeText(bytes,'.docx')).rejects.toThrow();}
 });
 it('rejects malformed packages and external required relationships',async()=>{
  await expect(extractOfficeText(new Uint8Array([1,2,3]),'.docx')).rejects.toThrow('ZIP');
  await expect(extractOfficeText(office('.xlsx',{'xl/workbook.xml':'<workbook xmlns:r="r"><sheet name="s" r:id="s"/></workbook>','xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="s" Type="x/worksheet" TargetMode="External" Target="https://example.com"/></Relationships>'}),'.xlsx')).rejects.toThrow('外部');
 });
});
