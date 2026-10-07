import { describe,it,expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env,BASE } from './helpers/env';
import { seedUser,seedProject,authCookie } from './helpers/seed';
import { validateOfficePackage,OFFICE_PACKAGES } from '../src/services/docx-validation';
import { runParseJob } from '../src/services/parse';
import { previewDraft,commitDraft } from '../src/services/creation-drafts';
import { beginDraftUpload,uploadDraftPart,completeDraftUpload,importDraftBlocks,finishDraftImport } from '../src/services/draft-documents';

// Minimal real stored ZIP, with valid CRCs and central directory, rather than magic strings.
function zip(entries:Record<string,string>) {
 const chunks:Uint8Array[]=[],central:Uint8Array[]=[];let offset=0;
 for(const [name,text] of Object.entries(entries)){
  const n=new TextEncoder().encode(name),b=new TextEncoder().encode(text);let crc=0xffffffff;
  for(const byte of b){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
  const local=new Uint8Array(30+n.length+b.length),l=new DataView(local.buffer);
  l.setUint32(0,0x04034b50,true);l.setUint16(4,20,true);l.setUint32(14,crc,true);l.setUint32(18,b.length,true);l.setUint32(22,b.length,true);l.setUint16(26,n.length,true);local.set(n,30);local.set(b,30+n.length);
  const dir=new Uint8Array(46+n.length),d=new DataView(dir.buffer);d.setUint32(0,0x02014b50,true);d.setUint16(4,20,true);d.setUint16(6,20,true);d.setUint32(16,crc,true);d.setUint32(20,b.length,true);d.setUint32(24,b.length,true);d.setUint16(28,n.length,true);d.setUint32(42,offset,true);dir.set(n,46);
  chunks.push(local);central.push(dir);offset+=local.length;
 }
 const directoryLength=central.reduce((a,b)=>a+b.length,0),end=new Uint8Array(22),e=new DataView(end.buffer);e.setUint32(0,0x06054b50,true);e.setUint16(8,central.length,true);e.setUint16(10,central.length,true);e.setUint32(12,directoryLength,true);e.setUint32(16,offset,true);
 const bytes=new Uint8Array(offset+directoryLength+22);let pos=0;for(const b of [...chunks,...central,end]){bytes.set(b,pos);pos+=b.length;}return bytes;
}
function office(ext:'.xlsx'|'.pptx',parts:Record<string,string>={}) {const s=OFFICE_PACKAGES[ext];return zip({'[Content_Types].xml':`<Types><Override PartName="/${s.part}" ContentType="${s.contentType}"/></Types>`,[s.part]:'<document/>','_rels/.rels':'<Relationships/>',...parts});}
async function fixture(ext:'.xlsx'|'.pptx'){
 const user=await seedUser(),project=await seedProject(user.userId),headers={cookie:authCookie(user.token),'content-type':'application/json'};
 const response=await SELF.fetch(`${BASE}/api/v1/projects/${project}/files`,{method:'POST',headers,body:JSON.stringify({fileName:'资料'+ext})});expect(response.status).toBe(201);
 const f=(await response.json() as {data:{fileId:string;upload:{url:string}}}).data;return {user,project,headers,file:f.fileId,url:BASE+f.upload.url,bytes:office(ext)};
}
describe('Office upload and browser text imports',()=>{
 it.each(['.xlsx','.pptx'] as const)('completes %s server text processing without browser or AI calls',async ext=>{
  const f=await fixture(ext);
  const parts:Record<string,string>=ext==='.xlsx'?{
   'xl/workbook.xml':'<workbook xmlns:r="r"><sheets><sheet name="访谈记录" r:id="s"/></sheets></workbook>',
   'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="s" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
   'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>可核对的采访原文</t></is></c></row></sheetData></worksheet>',
  }:{
   'ppt/presentation.xml':'<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="s"/></p:sldIdLst></p:presentation>',
   'ppt/_rels/presentation.xml.rels':'<Relationships><Relationship Id="s" Type="x/slide" Target="slides/slide1.xml"/></Relationships>',
   'ppt/slides/slide1.xml':'<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>可核对的采访原文</a:t></a:r></a:p></p:sld>',
  };
  const bytes=office(ext,parts);
  expect((await SELF.fetch(f.url,{method:'PUT',headers:{cookie:f.headers.cookie},body:bytes})).status).toBe(201);
  const response=await SELF.fetch(`${BASE}/api/v1/projects/${f.project}/sources`,{method:'POST',headers:f.headers,body:JSON.stringify({kind:'file',fileId:f.file,purpose:'output'})});
  const {sourceVersionId,sourceId}=(await response.json() as {data:{sourceVersionId:string;sourceId:string}}).data;
  const job=crypto.randomUUID(),now=new Date().toISOString();
  await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'parse_source','queued',?3,?4,?5,?5)").bind(job,f.project,JSON.stringify({operation:'source.text',sourceId,sourceVersionId,phase:'extract',sourceLifecycleVersion:1}),f.user.userId,now).run();
  expect((await runParseJob(env,job)).status).toBe('succeeded');
  expect(await env.DB.prepare('SELECT status FROM source_versions WHERE id=?1').bind(sourceVersionId).first()).toEqual({status:'ready'});
  expect(await env.DB.prepare('SELECT page_count,extraction_method FROM source_versions WHERE id=?1').bind(sourceVersionId).first()).toEqual({page_count:null,extraction_method:'server-'+ext.slice(1)});
  const fragments=await env.DB.prepare('SELECT content,page_number FROM source_fragments WHERE source_version_id=?1').bind(sourceVersionId).all();
  expect(fragments.results.map(row=>row.content).join('')).toContain('可核对的采访原文');expect(fragments.results.every(row=>row.page_number===null)).toBe(true);
 });
 it.each(['.xlsx','.pptx'] as const)('rejects spoofed, mismatched and encrypted %s packages',async ext=>{
  const good=office(ext);expect(await validateOfficePackage(ext,good.length,async(o,n)=>good.slice(o,o+n))).toBe(OFFICE_PACKAGES[ext].mime);
  for(const bad of [zip({'ordinary.txt':'hello'}),office(ext==='.xlsx'?'.pptx':'.xlsx'),zip({'[Content_Types].xml':`<Types><Override PartName="/${OFFICE_PACKAGES[ext].part}" ContentType="wrong"/><Override PartName="/unrelated" ContentType="${OFFICE_PACKAGES[ext].contentType}"/></Types>`,[OFFICE_PACKAGES[ext].part]:'<document/>'})])await expect(validateOfficePackage(ext,bad.length,async(o,n)=>bad.slice(o,o+n))).rejects.toThrow();
  const encrypted=good.slice(),view=new DataView(encrypted.buffer);for(let i=0;i<encrypted.length-4;i++)if(view.getUint32(i,true)===0x02014b50){view.setUint16(i+8,1,true);break;}
  await expect(validateOfficePackage(ext,encrypted.length,async(o,n)=>encrypted.slice(o,o+n))).rejects.toThrow();
 });
 it.each(['.xlsx','.pptx'] as const)('preserves malformed %s original and allows browser recovery without invented pages',async ext=>{
  const f=await fixture(ext);expect((await SELF.fetch(f.url,{method:'PUT',headers:{cookie:f.headers.cookie},body:f.bytes})).status).toBe(201);
  const download=await SELF.fetch(f.url,{headers:{cookie:f.headers.cookie}});expect(download.headers.get('content-type')).toBe(OFFICE_PACKAGES[ext].mime);expect(new Uint8Array(await download.arrayBuffer())).toEqual(f.bytes);
  const source=await SELF.fetch(`${BASE}/api/v1/projects/${f.project}/sources`,{method:'POST',headers:f.headers,body:JSON.stringify({kind:'file',fileId:f.file})});expect(source.status).toBe(201);const {sourceVersionId,sourceId}=(await source.json() as {data:{sourceVersionId:string;sourceId:string}}).data;
  // The upload fixture deliberately contains no actual workbook/slide relationships.
  // Server extraction now attempts it and fails; the original and manual fallback remain usable.
  const job=crypto.randomUUID(),now=new Date().toISOString();await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'parse_source','queued',?3,?4,?5,?5)").bind(job,f.project,JSON.stringify({sourceId,sourceVersionId,phase:'extract',sourceLifecycleVersion:1}),f.user.userId,now).run();expect((await runParseJob(env,job)).status).toBe('failed');
  expect((await SELF.fetch(f.url,{headers:{cookie:f.headers.cookie}})).status).toBe(200);
  const path=`${BASE}/api/v1/projects/${f.project}/document-imports`,method='browser-'+ext.slice(1);
  const init=await SELF.fetch(path,{method:'POST',headers:f.headers,body:JSON.stringify({sourceVersionId,method})});expect(init.status).toBe(200);const {sessionId}=(await init.json() as {data:{sessionId:string}}).data;
  const batch={batchNumber:0,blocks:[{seq:0,pageNumber:null,text:'中文原文 A1 金额 100',headingPath:ext==='.xlsx'?['预算','A1:B1']:['幻灯片 1','备注']}]};
  expect((await SELF.fetch(`${path}/${sessionId}/batches`,{method:'POST',headers:f.headers,body:JSON.stringify({...batch,blocks:[{...batch.blocks[0],pageNumber:1}]})})).status).toBe(409);
  const outsider=await seedUser();expect((await SELF.fetch(`${path}/${sessionId}`,{headers:{cookie:authCookie(outsider.token)}})).status).toBe(403);
  for(let i=0;i<2;i++)expect((await SELF.fetch(`${path}/${sessionId}/batches`,{method:'POST',headers:f.headers,body:JSON.stringify(batch)})).status).toBe(200);
  expect((await SELF.fetch(`${path}/${sessionId}/complete`,{method:'POST',headers:f.headers,body:JSON.stringify({totalPages:1})})).status).toBe(409);
  expect((await SELF.fetch(`${path}/${sessionId}/complete`,{method:'POST',headers:f.headers,body:JSON.stringify({totalPages:null,warnings:['图片未读取'],partial:true})})).status).toBe(200);
  const v=await env.DB.prepare('SELECT page_count,extraction_method,extraction_coverage FROM source_versions WHERE id=?1').bind(sourceVersionId).first();expect(v).toEqual({page_count:null,extraction_method:method,extraction_coverage:'partial'});
  const fragments=await env.DB.prepare('SELECT page_number,heading_path FROM source_fragments WHERE source_version_id=?1').bind(sourceVersionId).all();expect(fragments.results).toHaveLength(1);expect(fragments.results[0]!.page_number).toBeNull();expect(fragments.results[0]!.heading_path).toBe(JSON.stringify(batch.blocks[0]!.headingPath));
 });
 it('keeps empty Office extraction waiting for text and permits retry',async()=>{
  const f=await fixture('.xlsx');await SELF.fetch(f.url,{method:'PUT',headers:{cookie:f.headers.cookie},body:f.bytes});
  const response=await SELF.fetch(`${BASE}/api/v1/projects/${f.project}/sources`,{method:'POST',headers:f.headers,body:JSON.stringify({kind:'file',fileId:f.file})});const {sourceVersionId}=(await response.json() as {data:{sourceVersionId:string}}).data;
  const path=`${BASE}/api/v1/projects/${f.project}/document-imports`,init=await SELF.fetch(path,{method:'POST',headers:f.headers,body:JSON.stringify({sourceVersionId,method:'browser-xlsx'})});const {sessionId}=(await init.json() as {data:{sessionId:string}}).data;
  const done=await SELF.fetch(`${path}/${sessionId}/complete`,{method:'POST',headers:f.headers,body:JSON.stringify({totalPages:null})});expect(done.status).toBe(200);expect((await done.json() as {data:{textReady:boolean;status:string}}).data).toMatchObject({textReady:false,status:'partial'});
  const stage=await env.DB.prepare('SELECT text_status FROM source_processing WHERE source_version_id=?1').bind(sourceVersionId).first();expect(stage?.text_status).toBe('waiting_input');
  const retry=await SELF.fetch(path,{method:'POST',headers:f.headers,body:JSON.stringify({sourceVersionId,method:'browser-xlsx'})});expect(retry.status).toBe(200);
 });
 it.each(['.xlsx','.pptx'] as const)('accepts multipart %s',async ext=>{
  const f=await fixture(ext),path=`${BASE}/api/v1/projects/${f.project}/files/${f.file}/uploads`;
  const start=await SELF.fetch(path,{method:'POST',headers:f.headers,body:JSON.stringify({sizeBytes:f.bytes.length})});expect(start.status).toBe(201);const {sessionId}=(await start.json() as {data:{sessionId:string}}).data;
  expect((await SELF.fetch(`${path}/${sessionId}/parts/1`,{method:'PUT',headers:{cookie:f.headers.cookie,'x-part-size':String(f.bytes.length)},body:f.bytes})).status).toBe(201);
  expect((await SELF.fetch(`${path}/${sessionId}/complete`,{method:'POST',headers:f.headers})).status).toBe(200);
 });
 it.each([{ext:'.xlsx' as const,text:'原文'},{ext:'.pptx' as const,text:'原文'},{ext:'.xlsx' as const,text:'  '}])('keeps draft method and prevents empty text becoming ready: $ext $text',async ({ext,text})=>{
  const user=await seedUser(),draft={id:crypto.randomUUID()},file=crypto.randomUUID(),bytes=office(ext),now=new Date().toISOString();
  await env.DB.prepare('INSERT INTO project_creation_drafts(id,owner_id,payload_json,project_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)').bind(draft.id,user.userId,JSON.stringify({name:'Office项目',description:'',brief:'',teamSize:1,inviteLabels:[],inviteUsernames:[],aiCollaborationEnabled:false}),crypto.randomUUID(),now).run();
  await beginDraftUpload(env,draft.id,user.userId,file,'资料'+ext,bytes.length,1);await uploadDraftPart(env,draft.id,user.userId,file,1,new Response(bytes).body,bytes.length);await completeDraftUpload(env,draft.id,user.userId,file);
  await expect(importDraftBlocks(env,draft.id,user.userId,file,2,[{seq:0,pageNumber:1,text:'原文'}])).rejects.toThrow('真实页码');
  await importDraftBlocks(env,draft.id,user.userId,file,2,[{seq:0,pageNumber:null,text,headingPath:['位置']}]);await finishDraftImport(env,draft.id,user.userId,file,2,1,'complete',[]);
  const ready=await previewDraft(env,draft.id,user.userId,3,'manual',[{title:'阅读',detail:'读取正文',criteria:'人工核查',effortHours:1,dependsOn:[],citations:[]}],true);const project=await commitDraft(env,draft.id,user.userId,ready.revision);
  const v=await env.DB.prepare('SELECT extraction_method,page_count,status FROM source_versions WHERE project_id=?1').bind(project.projectId).first();expect(v).toEqual({extraction_method:'browser-'+ext.slice(1),page_count:null,status:text.trim()?'ready':'pending'});
 });
});
