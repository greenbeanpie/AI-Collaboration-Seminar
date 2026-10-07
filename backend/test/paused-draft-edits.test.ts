import { describe, expect, it } from 'vitest';
import { env, BASE } from './helpers/env';
import { authCookie, seedUser } from './helpers/seed';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { newId, nowIso } from '../src/core/db';
import { creationPayload, updateDraft, uploadDraftFile, previewDraft, commitDraft, getDraft, prepareDraftEdit } from '../src/services/creation-drafts';
import { importDraftBlocks, finishDraftImport, beginDraftUpload, draftUploadStatus } from '../src/services/draft-documents';
import { ensureExecution, pauseExecution, readExecution, acquireExecutionCall, finishExecutionCall, markInterruptedExecution, cancelExecution } from '../src/services/ai-execution-control';
const task={key:'old',title:'原任务',detail:'已保存的正文',criteria:'人工核查',effortHours:1,dependsOn:[],citations:[]};
async function fixture(state:'paused'|'running'|'finalizing'|'cancelled'='paused'){
 const owner=await seedUser(),id=newId(),fileId=newId(),time=nowIso(),payload=creationPayload.parse({name:'保留草稿',brief:'原拆分要求',aiCollaborationEnabled:false});
 await env.DB.prepare('INSERT INTO project_creation_drafts(id,owner_id,payload_json,project_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)').bind(id,owner.userId,JSON.stringify(payload),newId(),time).run();
 await uploadDraftFile(env,id,owner.userId,1,fileId,'原文.txt',new TextEncoder().encode('保留原文件正文'));
 await previewDraft(env,id,owner.userId,2,'manual',[task],false);
 const attempt=newId(),target={kind:'draft_preview' as const,id:attempt};await ensureExecution(env,target,{draftId:id,userId:owner.userId});
 await env.DB.prepare("UPDATE project_creation_drafts SET preview_state='running',preview_attempt_id=?2 WHERE id=?1").bind(id,attempt).run();
 if(state==='paused')await pauseExecution(env,target,'round_limit');
 if(state==='cancelled')await cancelExecution(env,target,1);
 if(state==='finalizing')await env.DB.prepare("UPDATE ai_executions SET state='finalizing' WHERE target_kind='draft_preview' AND target_id=?1").bind(attempt).run();
 return {id,fileId,owner,payload,attempt,target};
}
describe('editing paused draft requirements and files',()=>{
 it('PATCH cancels only the paused attempt, preserves original evidence and invalidates its saved preview',async()=>{
  const f=await fixture(),response=await createApp().request(BASE+`/api/v1/creation-drafts/${f.id}`,{method:'PATCH',headers:{cookie:authCookie(f.owner.token),'content-type':'application/json'},body:JSON.stringify({expectedRevision:2,payload:{...f.payload,brief:'仅生成三个任务'}})},env);
  expect(response.status).toBe(200);const row=await getDraft(env,f.id,f.owner.userId);expect(row).toMatchObject({revision:3,preview_state:'none',preview_revision:null});expect(JSON.parse(row.payload_json).brief).toBe('仅生成三个任务');expect(JSON.parse(row.preview_json!).tasks[0].title).toBe('原任务');
  expect(await readExecution(env,f.target)).toMatchObject({state:'cancelled',generation:1});expect(await env.FILES.get(`creation-drafts/${f.id}/${f.fileId}.txt`)).not.toBeNull();
  await expect(commitDraft(env,f.id,f.owner.userId,3)).rejects.toMatchObject({code:'INVALID_STATE'});
  await expect(previewDraft(env,f.id,f.owner.userId,2,'ai',[],false,undefined,f.attempt,1,0)).rejects.toMatchObject({code:'INVALID_STATE'});
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM tasks').first()).toMatchObject({n:0});
 });
 it('saving a manual preview replaces a paused attempt but committing the paused preview never cancels it',async()=>{
  const f=await fixture();await expect(commitDraft(env,f.id,f.owner.userId,2)).rejects.toMatchObject({code:'INVALID_STATE'});expect(await readExecution(env,f.target)).toMatchObject({state:'paused'});
  const ready=await previewDraft(env,f.id,f.owner.userId,2,'manual',[{...task,title:'人工新任务'}],false);expect(ready.previewState).toBe('ready');expect(ready.preview!.tasks[0]!.title).toBe('人工新任务');expect(await readExecution(env,f.target)).toMatchObject({state:'cancelled'});
 });
 it('uploads a new file and begins a multipart upload after a paused or cancelled attempt',async()=>{
  for(const state of ['paused','cancelled'] as const){const f=await fixture(state),fileId=newId();const view=await uploadDraftFile(env,f.id,f.owner.userId,2,fileId,'新增.txt',new TextEncoder().encode('新增资料'));expect(view.revision).toBe(3);expect(view.files).toHaveLength(2);expect(view.previewState).toBe('none');expect(await readExecution(env,f.target)).toMatchObject({state:'cancelled'});}
  const f=await fixture(),fileId=newId();await beginDraftUpload(env,f.id,f.owner.userId,fileId,'分片.txt',10,2);expect((await draftUploadStatus(env,f.id,f.owner.userId,fileId)).status).toBe('uploading');expect(await readExecution(env,f.target)).toMatchObject({state:'cancelled'});
 });
 it('preserves document bytes while importing blocks and finishing text after pause',async()=>{
  const f=await fixture();await importDraftBlocks(env,f.id,f.owner.userId,f.fileId,2,[{seq:0,pageNumber:null,text:'保留原文件正文'}]);const done=await finishDraftImport(env,f.id,f.owner.userId,f.fileId,2,1,'complete',[]);expect(done.revision).toBe(3);expect(done.previewState).toBe('none');expect(await readExecution(env,f.target)).toMatchObject({state:'cancelled'});expect(await env.DB.prepare('SELECT content FROM draft_document_blocks WHERE file_id=?1').bind(f.fileId).first()).toMatchObject({content:'保留原文件正文'});
 });
 it.each(['running','finalizing'] as const)('keeps a live %s executor locked and never silently replaces its attempt',async state=>{
  const f=await fixture(state);await expect(updateDraft(env,f.id,f.owner.userId,2,{...f.payload,brief:'不应保存'})).rejects.toMatchObject({code:'INVALID_STATE'});await expect(previewDraft(env,f.id,f.owner.userId,2,'manual',[task],true)).rejects.toMatchObject({code:'INVALID_STATE'});await expect(importDraftBlocks(env,f.id,f.owner.userId,f.fileId,2,[{seq:0,pageNumber:null,text:'不应保存'}])).rejects.toMatchObject({code:'INVALID_STATE'});expect(await readExecution(env,f.target)).toMatchObject({state});expect((await getDraft(env,f.id,f.owner.userId)).preview_attempt_id).toBe(f.attempt);
 });
 it('rejects an outdated revision, another owner and unanswered clarification without cancelling the attempt',async()=>{
  const f=await fixture(),other=await seedUser();await expect(prepareDraftEdit(env,f.id,f.owner.userId,1)).rejects.toMatchObject({code:'VERSION_CONFLICT'});await expect(prepareDraftEdit(env,f.id,other.userId,2)).rejects.toMatchObject({code:'NOT_FOUND'});await env.DB.prepare('UPDATE project_creation_drafts SET preview_waiting_id=?2 WHERE id=?1').bind(f.id,newId()).run();await expect(prepareDraftEdit(env,f.id,f.owner.userId,2)).rejects.toMatchObject({code:'INVALID_STATE'});expect(await readExecution(env,f.target)).toMatchObject({state:'paused'});
 });
 it('rejects a resumed-generation race without cancelling the new window or saving payload edits',async()=>{
  const f=await fixture();let raced=false;
  const local={...env,DB:{prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{
   if(!raced){raced=true;await env.DB.prepare("UPDATE ai_executions SET generation=2,state='running' WHERE target_id=?1").bind(f.attempt).run();}
   return env.DB.batch(statements);
  }}} as unknown as Env;
  await expect(updateDraft(local,f.id,f.owner.userId,2,{...f.payload,brief:'竞态旧要求'})).rejects.toMatchObject({code:'VERSION_CONFLICT'});expect(await readExecution(env,f.target)).toMatchObject({state:'running',generation:2});expect(await getDraft(env,f.id,f.owner.userId)).toMatchObject({revision:2,preview_state:'running',preview_attempt_id:f.attempt});
 });
 it('rejects a newer attempt published between detach and payload mutation without changing its result',async()=>{
  const f=await fixture(),next=newId();let raced=false;
  const local={...env,DB:{batch:env.DB.batch.bind(env.DB),prepare:(sql:string)=>{
   const statement=env.DB.prepare(sql);if(!sql.startsWith('UPDATE project_creation_drafts SET payload_json='))return statement;
   return {bind:(...args:unknown[])=>({run:async()=>{
    if(!raced){raced=true;await env.DB.prepare("UPDATE project_creation_drafts SET preview_attempt_id=?2,preview_state='ready',preview_revision=2 WHERE id=?1").bind(f.id,next).run();}
    return statement.bind(...args).run();
   }})};
  }}} as unknown as Env;
  await expect(updateDraft(local,f.id,f.owner.userId,2,{...f.payload,brief:'旧编辑'})).rejects.toMatchObject({code:'VERSION_CONFLICT'});const row=await getDraft(env,f.id,f.owner.userId);expect(row).toMatchObject({revision:2,preview_state:'ready',preview_attempt_id:next});expect(JSON.parse(row.payload_json).brief).toBe('原拆分要求');
 });
 it('discarding a terminated old executor is fenced even if its provider response arrives after the edit',async()=>{
  const f=await fixture('running'),token=await acquireExecutionCall(env,f.target,1);await markInterruptedExecution(env,f.target,1);await updateDraft(env,f.id,f.owner.userId,2,{...f.payload,brief:'新要求'});expect(await finishExecutionCall(env,f.target,token)).toBe(false);expect(await getDraft(env,f.id,f.owner.userId)).toMatchObject({revision:3,preview_state:'none'});expect(await readExecution(env,f.target)).toMatchObject({state:'cancelled'});
 });
});
