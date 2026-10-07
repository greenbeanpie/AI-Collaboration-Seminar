import {afterEach,describe,expect,it,vi} from 'vitest';
import {env} from './helpers/env';
import {seedUser} from './helpers/seed';
import {configureGoFixture} from './helpers/provider-config';
import {loadAiConfig} from '../src/ai/config';
import {newId,nowIso} from '../src/core/db';
import type {Env} from '../src/env';
import {enqueueDraftPreview,enqueueDraftPreviewSegment,controlDraftExecution,recoverDraftPreviews} from '../src/services/draft-preview-jobs';
import {previewDraft,DraftPreviewYield,getDraft,draftView} from '../src/services/creation-drafts';
import {loadDraftCheckpoint,saveDraftCheckpoint,compactDraftHistory,draftTextPrefix} from '../src/services/draft-preview-checkpoints';
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
 it('bounds migrated persistent history and input when continuing a 500-round checkpoint',async()=>{
  const f=await fixture(),config=(await loadAiConfig(env.DB))!;config.config.textEconomy.maxInputChars=12000;await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2 WHERE id=?1').bind(config.id,JSON.stringify(config.config)).run();
  const snapshot=(await loadDraftCheckpoint(env,f.attempt))!,state=snapshot.checkpoint;
  const exchange=(i:number)=>({assistant:{role:'assistant',content:null,tool_calls:[call(String(i),f.fileId)]},results:[{call:{id:String(i),name:'read_draft_document',args:{fileId:f.fileId,offset:i}},output:{blocks:[{locator:`block:${i}`,pageNumber:null,text:'😀原文'.repeat(400)}],nextOffset:i+1,nextCharOffset:0}}]});
  state.exchanges=Array.from({length:500},(_,i)=>exchange(i));
  state.contextPhase=undefined;
  const small=structuredClone(state);compactDraftHistory(small,4000,2400);const size500=JSON.stringify(small).length;
  small.exchanges.push(...Array.from({length:500},(_,i)=>exchange(i+500)));compactDraftHistory(small,4000,2400);expect(JSON.stringify(small).length).toBeLessThan(size500+1000);expect(small.readProgress?.[0]?.nextOffset).toBeGreaterThan(900);expect(draftTextPrefix('😀😀',3)).toBe('😀');
  await saveDraftCheckpoint(env,state,snapshot.etag);await env.DB.prepare("UPDATE ai_executions SET state='paused',pause_reason='round_limit',window_calls=100,total_calls=500 WHERE target_kind='draft_preview' AND target_id=?1").bind(f.attempt).run();
  await controlDraftExecution(f.local,f.id,f.userId,1,'continue');
  const fetch=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{const body=JSON.parse(String(init?.body)),input=body.messages.reduce((n:number,m:{content:unknown})=>n+(typeof m.content==='string'?m.content.length:JSON.stringify(m.content).length),0);expect(input).toBeLessThanOrEqual(12000);return response();});vi.stubGlobal('fetch',fetch);
  const ready=await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,2,0);expect(ready.execution?.totalCalls).toBe(501);
  const bounded=(await loadDraftCheckpoint(env,f.attempt))!.checkpoint;expect(JSON.stringify(bounded).length).toBeLessThan(18000);expect(bounded.contextPhase?.stage).toBe(1);expect(JSON.stringify(bounded.contextPhase?.summaryData)).toContain('nextOffset');
 });
 it('never marks a continued segment failed because its predecessor completed',async()=>{
  const f=await fixture();vi.stubGlobal('fetch',vi.fn(async()=>response([call('read',f.fileId)])));
  await expect(previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,1,0)).rejects.toBeInstanceOf(DraftPreviewYield);
  await enqueueDraftPreviewSegment(f.local,{draftId:f.id,userId:f.userId,revision:1,attempt:f.attempt,generation:1,tasks:[]});
  const current=`${f.attempt}-g1-s1`,get=vi.fn(async(id:string)=>({status:async()=>({status:id===current?'running':'complete'})})),local={...f.local,AGENT_WORKFLOW:{create:f.create,get}} as unknown as Env;
  await env.DB.prepare('UPDATE project_creation_drafts SET updated_at=?2 WHERE id=?1').bind(f.id,new Date(Date.now()-800000).toISOString()).run();
  await recoverDraftPreviews(local);expect((await draftView(local,await getDraft(local,f.id,f.userId))).previewState).toBe('running');
  await env.DB.prepare("UPDATE ai_executions SET state='paused',pause_reason='round_limit' WHERE target_kind='draft_preview' AND target_id=?1").bind(f.attempt).run();get.mockImplementation(async()=>({status:async()=>({status:'complete'})}));
  await recoverDraftPreviews(local);expect((await draftView(local,await getDraft(local,f.id,f.userId))).previewState).toBe('paused_round_limit');
 });
 it('does not issue a 101st automatic request and preserves checkpoint progress',async()=>{
  const f=await fixture(100),fetch=vi.fn(async()=>response([call('again',f.fileId)]));vi.stubGlobal('fetch',fetch);
  for(let segment=0;segment<100;segment++)await expect(previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,1,segment)).rejects.toBeInstanceOf(DraftPreviewYield);
  const paused=await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,1,100);expect(fetch).toHaveBeenCalledTimes(100);expect(paused.execution).toMatchObject({state:'paused',windowCalls:100,totalCalls:100,pauseReason:'round_limit'});expect((await loadDraftCheckpoint(env,f.attempt))?.checkpoint.step).toBe(100);
 },30000); // 101 次完整 durable 段（模型调用+加密 checkpoint 持久化）串行需 ~9s，默认 5s 阈值不够
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
 it.each(['deepseek','deepseek-anthropic'] as const)('freezes %s directory prefix and appends repair feedback after complete tool exchanges',async(preset)=>{
  const f=await fixture(),cfg=(await loadAiConfig(env.DB))!,originalConfig=structuredClone(cfg.config),messagesProtocol=preset==='deepseek-anthropic';
  Object.assign(cfg.config.textEconomy,{providerPreset:preset,apiProtocol:messagesProtocol?'messages':'chat-completions',apiUrl:messagesProtocol?'https://api.deepseek.com/anthropic/v1/messages':'https://api.deepseek.com/chat/completions',model:'deepseek-v4-pro',supportsJson:!messagesProtocol,reasoningEffort:undefined,temperature:undefined,topP:undefined});
  await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2 WHERE id=?1').bind(cfg.id,JSON.stringify(cfg.config)).run();
  const bodies:Array<{messages:Array<{role:string;content:unknown}>;tools:unknown;system?:unknown}>=[];
  const fetch=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
   bodies.push(JSON.parse(String(init?.body)));const reading=bodies.length===1;
   return messagesProtocol?Response.json({stop_reason:reading?'tool_use':'end_turn',content:reading?[{type:'thinking',thinking:'Fixture thinking',signature:'fixture'},{type:'tool_use',id:'read',name:'read_draft_document',input:{fileId:f.fileId,offset:0}}]:[{type:'text',text:JSON.stringify(plan)}],usage:{input_tokens:10,output_tokens:10}}):response(reading?[call('read',f.fileId)]:[]);
  });vi.stubGlobal('fetch',fetch);
  await expect(previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,1,0)).rejects.toBeInstanceOf(DraftPreviewYield);
  const snapshot=(await loadDraftCheckpoint(env,f.attempt))!;expect(snapshot.checkpoint.context[0]?.pages).toEqual([]);expect(snapshot.checkpoint.contextPhase?.timeline[0]?.kind).toBe('exchange');
  snapshot.checkpoint.feedback='修复新增需求';await saveDraftCheckpoint(env,snapshot.checkpoint,snapshot.etag);
  expect((await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,1,1)).previewState).toBe('ready');
  expect(bodies[1]!.messages.slice(0,bodies[0]!.messages.length)).toEqual(bodies[0]!.messages);expect(bodies[1]!.tools).toEqual(bodies[0]!.tools);
  expect(bodies[1]!.system).toEqual(bodies[0]!.system);expect(JSON.stringify(bodies[0]!.messages.at(-1)!.content)).not.toContain('证据');
  if(messagesProtocol)expect(JSON.stringify(bodies[1]!.messages.at(-1)!.content)).toContain('修复新增需求');
  else {expect(bodies[1]!.messages.at(-1)).toMatchObject({role:'user',content:'修复新增需求'});expect(bodies[1]!.messages.at(-2)?.role).toBe('tool');}
  await env.DB.prepare('UPDATE ai_config_versions SET config_json=?2 WHERE id=?1').bind(cfg.id,JSON.stringify(originalConfig)).run();
 });
 it('keeps an invalid explicit final result paused without another automatic call',async()=>{
  const f=await fixture(1),fetch=vi.fn(async()=>fetch.mock.calls.length===1?response([call('read',f.fileId)]):Response.json({choices:[{message:{content:'invalid final JSON'}}]}));vi.stubGlobal('fetch',fetch);
  await expect(previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt)).rejects.toBeInstanceOf(DraftPreviewYield);
  await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt);await controlDraftExecution(f.local,f.id,f.userId,1,'output');
  const paused=await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,2,1);expect(paused.execution).toMatchObject({state:'paused',pauseReason:'output_invalid',totalCalls:2});expect(paused.previewState).toBe('paused_round_limit');
  await previewDraft(f.local,f.id,f.userId,1,'ai',[],false,undefined,f.attempt,2,1);expect(fetch).toHaveBeenCalledTimes(2);
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
