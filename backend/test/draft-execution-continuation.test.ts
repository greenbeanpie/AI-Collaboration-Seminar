import {afterEach,describe,expect,it,vi} from 'vitest';
import {env} from './helpers/env';
import {seedUser} from './helpers/seed';
import {configureGoFixture} from './helpers/provider-config';
import {newId,nowIso} from '../src/core/db';
import type {Env} from '../src/env';
import {enqueueDraftPreview,enqueueDraftPreviewSegment,controlDraftExecution} from '../src/services/draft-preview-jobs';
import {previewDraft,DraftPreviewYield,getDraft,draftView} from '../src/services/creation-drafts';
import {loadDraftCheckpoint} from '../src/services/draft-preview-checkpoints';
import {saveExecutionPolicy,readExecution,loadExecutionPolicy} from '../src/services/ai-execution-control';
const plan={tasks:[{key:'a',title:'调查',detail:'已读取范围',criteria:'原文可核查',effortHours:1,dependsOn:[],citations:[]}]};
const response=(calls:unknown[]=[])=>Response.json({choices:[{finish_reason:calls.length?'tool_calls':'stop',message:{role:'assistant',content:calls.length?null:JSON.stringify(plan),...(calls.length?{tool_calls:calls}:{})}}],usage:{prompt_tokens:10,completion_tokens:10}});
const call=(id:string,fileId:string)=>({id,type:'function',function:{name:'read_draft_document',arguments:JSON.stringify({fileId,offset:0})}});
async function fixture(limit=100){const policy=await loadExecutionPolicy(env);await saveExecutionPolicy(env,policy.version,limit,null);await configureGoFixture();const owner=await seedUser(),id=newId(),now=nowIso();await env.DB.prepare('INSERT INTO project_creation_drafts(id,owner_id,payload_json,project_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)').bind(id,owner.userId,JSON.stringify({name:'接续',aiCollaborationEnabled:true}),newId(),now).run();const fileId=newId();await env.DB.prepare("INSERT INTO creation_draft_files(id,draft_id,name,ext,r2_key,sha256,size_bytes,mime,pages_json,created_at) VALUES(?1,?2,'test.txt','.txt',?1,'',1,'text/plain','[]',?3)").bind(fileId,id,now).run();await env.DB.prepare('INSERT INTO draft_document_blocks(id,draft_id,file_id,seq,page_number,content,heading_json) VALUES(?1,?2,?3,0,NULL,?,?)').bind(newId(),id,fileId,'证据','[]').run();const create=vi.fn(async()=>({id:'test'})),local={...env,AGENT_WORKFLOW:{create}} as unknown as Env;const queued=await enqueueDraftPreview(local,id,owner.userId,1,[],false);return {id,fileId,userId:owner.userId,attempt:queued.previewAttemptId!,local,create};}
afterEach(()=>vi.unstubAllGlobals());
describe('durable draft execution windows',()=>{
 it('continues beyond eight rounds with one model request per segment',async()=>{
  const f=await fixture();let rounds=0;const fetch=vi.fn(async()=>response(++rounds<=9?[call(String(rounds),f.fileId)]:[]));vi.stubGlobal('fetch',fetch);
  for(let segment=0;segment<9;segment++){
   await expect(previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,1,segment)).rejects.toBeInstanceOf(DraftPreviewYield);
   expect(fetch).toHaveBeenCalledTimes(segment+1);
   await enqueueDraftPreviewSegment(f.local,{draftId:f.id,userId:f.userId,revision:1,attempt:f.attempt,generation:1,tasks:[]});
  }
  const ready=await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,1,9);expect(ready.previewState).toBe('ready');expect(ready.execution?.totalCalls).toBe(10);
 });
 it('does not issue a 101st automatic request and preserves checkpoint progress',async()=>{
  const f=await fixture(100),fetch=vi.fn(async()=>response([call('again',f.fileId)]));vi.stubGlobal('fetch',fetch);
  for(let segment=0;segment<100;segment++)await expect(previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,1,segment)).rejects.toBeInstanceOf(DraftPreviewYield);
  const paused=await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,1,100);expect(fetch).toHaveBeenCalledTimes(100);expect(paused.execution).toMatchObject({state:'paused',windowCalls:100,totalCalls:100,pauseReason:'round_limit'});expect((await loadDraftCheckpoint(env,f.attempt))?.checkpoint.step).toBe(100);
 });
 it('persists confirmed provider retry state and counts its next segment request',async()=>{
  const f=await fixture(),fetch=vi.fn(async()=>fetch.mock.calls.length===1?Response.json({error:{message:'busy'}},{status:429}):response());vi.stubGlobal('fetch',fetch);
  await expect(previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt)).rejects.toBeInstanceOf(DraftPreviewYield);
  const state=(await loadDraftCheckpoint(env,f.attempt))!.checkpoint;expect(state.pendingDispatch).toBe(false);expect(state.providerRetry?.attempt).toBe(1);expect(fetch).toHaveBeenCalledOnce();
  const ready=await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,1,1);expect(ready.previewState).toBe('ready');expect(ready.execution?.totalCalls).toBe(2);
 });
 it('persists four tool results per segment without replaying its paid response',async()=>{
  const f=await fixture();const fetch=vi.fn(async()=>response(fetch.mock.calls.length===1?Array.from({length:6},(_,i)=>call(String(i),f.fileId)):[]));vi.stubGlobal('fetch',fetch);
  await expect(previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt)).rejects.toBeInstanceOf(DraftPreviewYield);
  const checkpoint=await loadDraftCheckpoint(env,f.attempt);expect(checkpoint?.checkpoint.pendingResults).toHaveLength(4);expect(fetch).toHaveBeenCalledOnce();
  const ready=await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,1,1);expect(ready.previewState).toBe('ready');expect(fetch).toHaveBeenCalledTimes(2);
  expect((await loadDraftCheckpoint(env,f.attempt))?.checkpoint.exchanges[0]?.results).toHaveLength(6);
 });
 it('pauses at the limit, then resumes the same progress with a fresh window',async()=>{
  const f=await fixture(1);const fetch=vi.fn(async()=>response(fetch.mock.calls.length===1?[call('read',f.fileId)]:[]));vi.stubGlobal('fetch',fetch);
  await expect(previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt)).rejects.toBeInstanceOf(DraftPreviewYield);
  const paused=await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt);expect(paused.previewState).toBe('paused_round_limit');expect(fetch).toHaveBeenCalledOnce();
  const resumed=await controlDraftExecution(f.local,f.id,f.userId,1,'continue');expect(resumed.execution).toMatchObject({generation:2,windowCalls:0,totalCalls:1});
  // A delayed old Workflow must never call the model for the new window.
  await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,1,1);expect(fetch).toHaveBeenCalledOnce();
  const ready=await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,2,1);expect(ready.previewState).toBe('ready');expect(ready.execution?.totalCalls).toBe(2);
 });
 it('feeds invalid final content back to the model rather than revalidating it',async()=>{
  const f=await fixture();const fetch=vi.fn(async()=>Response.json({choices:[{message:{content:fetch.mock.calls.length===1?'not json':JSON.stringify(plan)}}]}));vi.stubGlobal('fetch',fetch);
  await expect(previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt)).rejects.toBeInstanceOf(DraftPreviewYield);
  const snapshot=await loadDraftCheckpoint(env,f.attempt);expect(snapshot?.checkpoint.content).toBeUndefined();expect(snapshot?.checkpoint.feedback).toContain('未通过校验');
  expect((await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt)).previewState).toBe('ready');expect(fetch).toHaveBeenCalledTimes(2);
 });
 it('permits one explicit final call after pause, and cancelled generations discard late work',async()=>{
  const f=await fixture(1);const fetch=vi.fn(async()=>response(fetch.mock.calls.length===1?[call('read',f.fileId)]:[]));vi.stubGlobal('fetch',fetch);
  await expect(previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt)).rejects.toBeInstanceOf(DraftPreviewYield);
  await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt);
  await controlDraftExecution(f.local,f.id,f.userId,1,'output');
  const ready=await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,2,1);expect(ready.previewState).toBe('ready');expect(ready.execution?.totalCalls).toBe(2);
  const g=await fixture();await controlDraftExecution(g.local,g.id,g.userId,1,'cancel');
  expect((await draftView(g.local,await getDraft(g.local,g.id,g.userId))).previewState).toBe('none');
  await expect(previewDraft(g.local,g.id,g.userId,1,'ai',[],false,undefined,g.attempt,1,0)).rejects.toThrow('取消');expect((await readExecution(env,{kind:'draft_preview',id:g.attempt}))?.state).toBe('cancelled');expect(fetch).toHaveBeenCalledTimes(2);
 });
});
