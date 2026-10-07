import {describe,it,expect} from 'vitest';
import {env,BASE} from './helpers/env';
import {SELF} from 'cloudflare:test';
import {seedProject,seedUser,authCookie} from './helpers/seed';
import {ensureFileProcessing,readFileProcessing,syncFileProcessingText} from '../src/services/file-processing';
import {newId,nowIso} from '../src/core/db';
async function fixture(){
 const owner=await seedUser(),projectId=await seedProject(owner.userId),fileId=newId(),now=nowIso();
 await env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,original_name,created_at) VALUES(?1,?2,?3,?4,'.txt','available','研究成果.txt',?5)").bind(fileId,projectId,owner.userId,'test/'+fileId,now).run();
 await env.FILES.put('test/'+fileId,'真实调研正文。');
 return {owner,projectId,fileId,now};
}
async function ready(f:Awaited<ReturnType<typeof fixture>>,purpose='output'){
 const sourceId=newId(),versionId=newId();
 await env.DB.batch([
 env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,current_version_id,purpose,created_by,created_at,updated_at) VALUES(?1,?2,'file','成果',?3,?4,?5,?6,?6)").bind(sourceId,f.projectId,versionId,purpose,f.owner.userId,f.now),
 env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,status,created_at) VALUES(?1,?2,?3,1,'file',?4,'ready',?5)").bind(versionId,sourceId,f.projectId,f.fileId,f.now),
 env.DB.prepare("INSERT INTO file_processing(file_id,lifecycle_version,project_id,source_id,source_version_id,updated_at) VALUES(?1,1,?2,?3,?4,?5)").bind(f.fileId,f.projectId,sourceId,versionId,f.now),
 env.DB.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,seq,kind,content,created_at) VALUES(?1,?2,?3,1,'text','真实調研正文。',?4)").bind(newId(),versionId,f.projectId,f.now),
 env.DB.prepare("INSERT INTO source_processing(source_version_id,project_id,text_status,updated_at) VALUES(?1,?2,'ready',?3)").bind(versionId,f.projectId,f.now),
 ]);return {sourceId,versionId};
}
describe('durable uploaded file processing',()=>{
 it('does not start automatic work when project AI is disabled and rejects stale lifecycle',async()=>{
  const f=await fixture();const result=await ensureFileProcessing(env,f.projectId,f.fileId,f.owner.userId,{automatic:true});
  expect(result).toMatchObject({sourceId:null,jobId:null,textStatus:'pending'});
  await expect(ensureFileProcessing(env,f.projectId,f.fileId,f.owner.userId,{expectedLifecycleVersion:2})).rejects.toThrow('生命周期');
 });
 it('publishes original source output text as an immutable scoring material exactly once',async()=>{
  const f=await fixture(),s=await ready(f);await syncFileProcessingText(env,s.versionId);await syncFileProcessingText(env,s.versionId);
  const result=await readFileProcessing(env,f.projectId,f.fileId,f.owner.userId);expect(result.materialIds).toHaveLength(1);expect(result.textAvailable).toBe(true);
  const versions=await env.DB.prepare('SELECT markdown,doc_json FROM material_versions WHERE material_id=?1').bind(result.materialIds[0]).all<{markdown:string;doc_json:string}>();
  expect(versions.results).toHaveLength(1);expect(versions.results[0]?.markdown).toBe('真实調研正文。');expect(versions.results[0]?.doc_json).toContain('真实調研正文。');
  await env.DB.prepare("UPDATE sources SET purpose='reference' WHERE id=?1").bind(s.sourceId).run();await syncFileProcessingText(env,s.versionId);
  expect(await env.DB.prepare("SELECT 1 FROM materials WHERE id=?1 AND purpose='reference'").bind(result.materialIds[0]).first()).toBeTruthy();
 });
 it('keeps hand-written content and publishes attachment text independently',async()=>{
  const f=await fixture(),s=await ready(f),materialId=newId(),original=newId(),attachments=JSON.stringify([{fileId:f.fileId}]);
  await env.DB.batch([
   env.DB.prepare("INSERT INTO materials(id,project_id,title,kind,purpose,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'手写成果','document','output',?3,?4,?5,?5)").bind(materialId,f.projectId,original,f.owner.userId,f.now),
   env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at,attachments_json) VALUES(?1,?2,?3,1,'{}','用户手写正文','manual',?4,?5,?6)").bind(original,materialId,f.projectId,f.owner.userId,f.now,attachments),
  ]);await syncFileProcessingText(env,s.versionId);
  expect((await env.DB.prepare('SELECT current_version_id FROM materials WHERE id=?1').bind(materialId).first<{current_version_id:string}>())?.current_version_id).toBe(original);
  expect((await readFileProcessing(env,f.projectId,f.fileId,f.owner.userId)).materialIds).toHaveLength(1);
 });
 it('restores empty attachment bodies with matching doc and markdown without changing historical snapshots',async()=>{
  const f=await fixture(),s=await ready(f),materialId=newId(),original=newId();
  await env.DB.batch([
   env.DB.prepare("INSERT INTO materials(id,project_id,title,kind,purpose,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'旧附件','task-file','output',?3,?4,?5,?5)").bind(materialId,f.projectId,original,f.owner.userId,f.now),
   env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at,attachments_json) VALUES(?1,?2,?3,1,'{}','','manual',?4,?5,?6)").bind(original,materialId,f.projectId,f.owner.userId,f.now,JSON.stringify([{fileId:f.fileId}])),
  ]);await syncFileProcessingText(env,s.versionId);await syncFileProcessingText(env,s.versionId);
  const all=await env.DB.prepare('SELECT markdown,doc_json FROM material_versions WHERE material_id=?1 ORDER BY revision').bind(materialId).all<{markdown:string;doc_json:string}>();expect(all.results).toHaveLength(2);expect(all.results[0]?.markdown).toBe('');expect(all.results[1]?.doc_json).toContain('真实調研正文。');
  await env.DB.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,seq,kind,content,created_at) VALUES(?1,?2,?3,2,'ocr','扫描补充正文',?4)").bind(newId(),s.versionId,f.projectId,f.now).run();await syncFileProcessingText(env,s.versionId);
  expect((await env.DB.prepare('SELECT markdown FROM material_versions WHERE id=(SELECT current_version_id FROM materials WHERE id=?1)').bind(materialId).first<{markdown:string}>())?.markdown).toContain('扫描补充正文');
  await env.DB.prepare("UPDATE material_versions SET markdown='人工接管正文' WHERE id=(SELECT current_version_id FROM materials WHERE id=?1)").bind(materialId).run();
  await syncFileProcessingText(env,s.versionId);
  expect((await env.DB.prepare('SELECT markdown FROM material_versions WHERE id=(SELECT current_version_id FROM materials WHERE id=?1)').bind(materialId).first<{markdown:string}>())?.markdown).toBe('人工接管正文');
 });
 it('rejects derived page images before processing, even before source_pages links them',async()=>{
  const f=await fixture(),parent=await fixture();await env.DB.prepare('INSERT INTO file_derivations(file_id,parent_file_id) VALUES(?1,?2)').bind(f.fileId,parent.fileId).run();
  await expect(ensureFileProcessing(env,f.projectId,f.fileId,f.owner.userId)).rejects.toThrow('文件不可用');
 });
 it('deduplicates concurrent manual requests and preserves one source and one parse job',async()=>{
  const f=await fixture();await Promise.all([ensureFileProcessing(env,f.projectId,f.fileId,f.owner.userId),ensureFileProcessing(env,f.projectId,f.fileId,f.owner.userId)]);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM source_versions WHERE file_id=?1').bind(f.fileId).first<{n:number}>())?.n).toBe(1);
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE project_id=?1 AND kind='parse_source'").bind(f.projectId).first<{n:number}>())?.n).toBe(1);
 });
 it('reuses file source for its owner and rejects unrelated members changing source purpose',async()=>{
  const f=await fixture(),s=await ready(f),other=await seedUser();await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(),f.projectId,other.userId,f.now).run();
  const url=BASE+'/api/v1/projects/'+f.projectId+'/sources';
  const request=(token:string)=>SELF.fetch(url,{method:'POST',headers:{cookie:authCookie(token),'content-type':'application/json'},body:JSON.stringify({kind:'file',fileId:f.fileId,title:'导入成果',purpose:'reference'})});
  expect((await request(other.token)).status).toBe(403);const owner=await request(f.owner.token);expect(owner.status).toBe(201);expect((await owner.json() as {data:{sourceId:string}}).data.sourceId).toBe(s.sourceId);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM source_versions WHERE file_id=?1').bind(f.fileId).first<{n:number}>())?.n).toBe(1);
 });
 it('does not expose summarized audio as extractable scoring evidence',async()=>{
  const f=await fixture(),s=await ready(f);await env.DB.prepare("UPDATE files SET ext='.mp3' WHERE id=?1").bind(f.fileId).run();await syncFileProcessingText(env,s.versionId);
  expect(await readFileProcessing(env,f.projectId,f.fileId,f.owner.userId)).toMatchObject({textAvailable:false,materialIds:[]});
 });
});
