import {describe,it,expect} from 'vitest';
import {env,BASE} from './helpers/env';
import {SELF} from 'cloudflare:test';
import {seedProject,seedUser,authCookie} from './helpers/seed';
import {backfillFileProcessing,ensureFileProcessing,readFileProcessing,syncFileProcessingText} from '../src/services/file-processing';
import {configureGoFixture} from './helpers/provider-config';
import {newId,nowIso} from '../src/core/db';
import type {Env} from '../src/env';
// These tests inspect durable orchestration writes; model execution is covered by parse/summary suites.
const orchestrationEnv={...env,PARSE_WORKFLOW:{create:async()=>undefined},AGENT_WORKFLOW:{create:async()=>undefined}} as unknown as Env;
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
 it('ignores obsolete scan waiting_input after a newer OCR job completes',async()=>{
  const f=await fixture(),s=await ready(f),old=newId(),next=newId();
  for(const [id,status,date] of [[old,'waiting_input','2026-01-01T00:00:00.000Z'],[next,'succeeded','2026-01-01T00:01:00.000Z']])await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'ocr_pages',?3,?4,?5,?5)").bind(id!,f.projectId,status!,JSON.stringify({sourceVersionId:s.versionId}),date!).run();
  await env.DB.prepare('UPDATE file_processing SET job_id=?2 WHERE source_version_id=?1').bind(s.versionId,old).run();
  expect(await readFileProcessing(env,f.projectId,f.fileId,f.owner.userId)).toMatchObject({jobStatus:'succeeded',needsImages:0});
 });
 it('reports old concurrency errors separately from the current empty capacity and true job status',async()=>{
  const f=await fixture(),s=await ready(f),jobId=newId();
  await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'requirement_extract','failed',?3,?4,?4)").bind(jobId,f.projectId,JSON.stringify({operation:'source.summary',sourceVersionId:s.versionId}),f.now).run();
  await env.DB.prepare("UPDATE source_processing SET summary_status='running',summary_error='该项目的 AI 任务并发已达上限',summary_job_id=?2 WHERE source_version_id=?1").bind(s.versionId,jobId).run();
  const view=await readFileProcessing(env,f.projectId,f.fileId,f.owner.userId);
  expect(view).toMatchObject({jobStatus:'failed',errorIsHistorical:true,concurrency:{active:0,limit:2},waitingForConcurrency:false,textAvailable:true});
 });
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
  const derived=(await readFileProcessing(env,f.projectId,f.fileId,f.owner.userId)).materialIds[0]!;
  await env.DB.prepare("UPDATE material_versions SET attachments_json='[]' WHERE id=?1").bind(original).run();await syncFileProcessingText(env,s.versionId);
  expect(await env.DB.prepare("SELECT 1 FROM materials WHERE id=?1 AND purpose='reference' AND archived_at IS NOT NULL").bind(derived).first()).toBeTruthy();
  await env.DB.prepare('UPDATE material_versions SET attachments_json=?2 WHERE id=?1').bind(original,attachments).run();await syncFileProcessingText(env,s.versionId);
  expect(await env.DB.prepare("SELECT 1 FROM materials WHERE id=?1 AND purpose='output' AND archived_at IS NULL").bind(derived).first()).toBeTruthy();
  await env.DB.prepare('UPDATE materials SET archived_at=?2 WHERE id=?1').bind(materialId,f.now).run();await syncFileProcessingText(env,s.versionId);
  expect(await env.DB.prepare('SELECT 1 FROM materials WHERE id=?1 AND archived_at IS NOT NULL').bind(derived).first()).toBeTruthy();
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
  const f=await fixture();await Promise.all([ensureFileProcessing(orchestrationEnv,f.projectId,f.fileId,f.owner.userId),ensureFileProcessing(orchestrationEnv,f.projectId,f.fileId,f.owner.userId)]);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM source_versions WHERE file_id=?1').bind(f.fileId).first<{n:number}>())?.n).toBe(1);
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE project_id=?1 AND kind='parse_source'").bind(f.projectId).first<{n:number}>())?.n).toBe(1);
 });
 it.each(['output','background'])('freezes upload purpose %s before attachment registration',async purpose=>{
  const f=await fixture();await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=0 WHERE id=?1').bind(f.projectId).run();await env.DB.prepare('UPDATE files SET processing_purpose=?2 WHERE id=?1').bind(f.fileId,purpose).run();
  const result=await ensureFileProcessing(orchestrationEnv,f.projectId,f.fileId,f.owner.userId);
  expect((await env.DB.prepare('SELECT purpose FROM sources WHERE id=?1').bind(result.sourceId).first<{purpose:string}>())?.purpose).toBe(purpose);expect(result.requirementsStatus).toBe('skipped');
 });
 it('automatically fills a pending summary on an already parsed source without re-extracting text',async()=>{
  await configureGoFixture();const f=await fixture(),s=await ready(f);
  await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(f.projectId).run();
  await env.DB.prepare("UPDATE source_processing SET requirements_status='ready' WHERE source_version_id=?1").bind(s.versionId).run();
  await ensureFileProcessing(orchestrationEnv,f.projectId,f.fileId,f.owner.userId,{automatic:true});await ensureFileProcessing(orchestrationEnv,f.projectId,f.fileId,f.owner.userId,{automatic:true});
  const jobs=await env.DB.prepare('SELECT kind,input_json FROM jobs WHERE project_id=?1').bind(f.projectId).all<{kind:string;input_json:string}>();
  expect(jobs.results).toHaveLength(1);expect(JSON.parse(jobs.results[0]!.input_json).operation).toBe('source.summary');
 });
 it('backfills old files with a current authorized actor after uploader membership is revoked',async()=>{
  await configureGoFixture();const f=await fixture(),removed=await seedUser();
  await env.DB.prepare('UPDATE files SET uploader_user_id=?2 WHERE id=?1').bind(f.fileId,removed.userId).run();await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(f.projectId).run();
  await backfillFileProcessing(orchestrationEnv,f.projectId,1);
  expect((await env.DB.prepare('SELECT created_by FROM jobs WHERE project_id=?1').bind(f.projectId).first<{created_by:string}>())?.created_by).toBe(f.owner.userId);
 });
 it('recognizes legacy ready text with no processing row and preserves its extracted fragments',async()=>{
  const f=await fixture(),s=await ready(f);await env.DB.prepare('DELETE FROM source_processing WHERE source_version_id=?1').bind(s.versionId).run();
  await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=0 WHERE id=?1').bind(f.projectId).run();
  const result=await ensureFileProcessing(env,f.projectId,f.fileId,f.owner.userId);
  expect(result.textStatus).toBe('ready');expect((await env.DB.prepare('SELECT COUNT(*) n FROM jobs WHERE project_id=?1').bind(f.projectId).first<{n:number}>())?.n).toBe(0);
 });
 it('does not block file garbage collection with new pipeline and derivation relationships',async()=>{
  const f=await fixture(),parent=await fixture();
  await env.DB.batch([
   env.DB.prepare('INSERT INTO file_derivations(file_id,parent_file_id) VALUES(?1,?2)').bind(f.fileId,parent.fileId),
   env.DB.prepare('INSERT INTO file_processing(file_id,lifecycle_version,project_id,source_id,source_version_id,updated_at) VALUES(?1,1,?2,?3,?4,?5)').bind(f.fileId,f.projectId,newId(),newId(),f.now),
  ]);await env.DB.prepare('DELETE FROM files WHERE id=?1').bind(f.fileId).run();
  expect(await env.DB.prepare('SELECT 1 FROM file_processing WHERE file_id=?1').bind(f.fileId).first()).toBeNull();
  expect(await env.DB.prepare('SELECT 1 FROM file_derivations WHERE file_id=?1').bind(f.fileId).first()).toBeNull();
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
