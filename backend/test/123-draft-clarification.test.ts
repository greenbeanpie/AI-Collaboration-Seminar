import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { seedUser, authCookie } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { newId } from '../src/core/db';
import { createApp } from '../src/app';
import { previewDraft, getDraft, draftView } from '../src/services/creation-drafts';
import { enqueueDraftPreview, recoverDraftPreviews } from '../src/services/draft-preview-jobs';
import { answerClarification } from '../src/services/ai-clarifications';
import { loadDraftCheckpoint } from '../src/services/draft-preview-checkpoints';
import type { Env } from '../src/env';

afterEach(()=>vi.unstubAllGlobals());
const finalPlan={goal:{title:'形成调研成果',detail:'赛道尚未决定，先完成共同适用工作'},tasks:[{key:'research',title:'完成需求与竞品研究',detail:'研究共同需求，保留赛道未决事实',criteria:'交付证据与范围建议',effortHours:3,dependsOn:[],citations:[]}]};
const modelResponse=(question?:string)=>Response.json({choices:[{finish_reason:question?'tool_calls':'stop',message:question?{role:'assistant',content:null,tool_calls:[{id:'same-provider-call',type:'function',function:{name:'ask_user_question',arguments:JSON.stringify({question,reason:'影响交付范围',options:['教育方向','公共服务方向'],allowUndecided:true})}}]}:{role:'assistant',content:JSON.stringify(finalPlan)}}],usage:{prompt_tokens:20,completion_tokens:15}});
async function fixture(workspace=false) {
  await configureGoFixture();
  const owner=await seedUser(),app=createApp(),instances=new Set<string>();
  const create=vi.fn(async(args:{id:string})=>{if(instances.has(args.id))throw new Error('already exists');instances.add(args.id);return {id:args.id};});
  const get=vi.fn(async(id:string)=>({status:async()=>{if(!instances.has(id))throw new Error('not found');return {status:'running'};}}));
  const local={...env,AGENT_WORKFLOW:{create,get}} as unknown as Env;
  const request=(path:string,body?:unknown,method=body?'POST':'GET',token=owner.token)=>app.fetch(new Request(`${BASE}/api/v1/creation-drafts${path}`,{method,headers:{cookie:authCookie(token),'content-type':'application/json','idempotency-key':newId()},...(body?{body:JSON.stringify(body)}:{})}),local);
  const response=await request('',{name:'澄清测试',brief:'比赛项目',aiCollaborationEnabled:true,...(workspace?{workspace:{templateId:'blank',materials:[],standards:null}}:{})});
  const draft=(await response.json() as {data:{id:string;revision:number}}).data;
  return {owner,local,request,create,instances,...draft};
}
const body=async(r:Response)=>(await r.json() as {data:any}).data;
const read=async(f:Awaited<ReturnType<typeof fixture>>)=>draftView(f.local,await getDraft(f.local,f.id,f.owner.userId));

describe('durable private draft clarification',()=>{
  it('uses a real tool without preflight, reloads the pending question, resumes undecided once and preserves explicit creation',async()=>{
    const f=await fixture(true),requests:Record<string,any>[]=[];
    const provider=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{requests.push(JSON.parse(String(init?.body)));return modelResponse(requests.length===1?'请选择参赛方向':undefined);});
    vi.stubGlobal('fetch',provider);
    const first=await body(await f.request(`/${f.id}/preview`,{expectedRevision:1,mode:'ai'}));
    expect(first.previewState).toBe('waiting_input');expect(first.preview).toBeNull();expect(first.clarification).toMatchObject({question:'请选择参赛方向',round:1,maxRounds:3,status:'pending'});
    expect(requests[0]!.tools).toEqual(expect.arrayContaining([expect.objectContaining({function:expect.objectContaining({name:'ask_user_question'})})]));
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await body(await f.request(`/${f.id}`))).clarification.id).toBe(first.clarification.id);
    expect((await f.request(`/${f.id}/preview`,{expectedRevision:1,mode:'manual',regenerate:true,tasks:[]})).status).toBe(409);
    expect((await f.request(`/${f.id}/preview`,{expectedRevision:1,mode:'ai',background:true,regenerate:true})).status).toBe(409);
    expect((await f.request(`/${f.id}/commit`,{expectedRevision:1,confirmed:true})).status).toBe(409);
    const stranger=await seedUser();
    const path=`/${f.id}/clarifications/${first.clarification.id}/answer`,answer={expectedRevision:1,undecided:true};
    expect((await f.request(path,answer,'POST',stranger.token)).status).toBe(404);
    expect((await f.request(path,{expectedRevision:1,option:'擅自添加方向'})).status).toBe(400);
    expect((await body(await f.request(path,answer))).previewState).toBe('running');
    expect((await f.request(path,answer)).status).toBe(200);
    expect(f.instances.size).toBe(1);
    const ready=await previewDraft(f.local,f.id,f.owner.userId,1,'ai',[],false,undefined,first.previewAttemptId);
    expect(ready.previewState).toBe('ready');expect(ready.revision).toBe(2);expect(provider).toHaveBeenCalledTimes(2);
    const toolResult=requests[1]!.messages.find((m:any)=>m.role==='tool');
    expect(JSON.parse(toolResult.content)).toMatchObject({status:'answered',answer:{undecided:true}});
    expect(ready.preview?.goal?.detail).toContain('尚未决定');
    expect((await f.request(path,answer)).status).toBe(200);expect(f.instances.size).toBe(1);expect(provider).toHaveBeenCalledTimes(2);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM projects WHERE created_by=?1').bind(f.owner.userId).first<{n:number}>())!.n).toBe(0);
    const calls=await env.DB.prepare('SELECT * FROM ai_calls WHERE draft_id=?1').bind(f.id).all();expect(calls.results).toHaveLength(2);
    const stored=await env.FILES.get(`ai/draft-investigations/${first.previewAttemptId}.json`);expect(await stored!.text()).not.toContain('请选择参赛方向');
    const committed=await f.request(`/${f.id}/commit`,{expectedRevision:2,expectedPreviewAttemptId:first.previewAttemptId,confirmed:true});expect(committed.status).toBe(201);expect(provider).toHaveBeenCalledTimes(2);
  });

  it('limits clarification to three rounds and supports providers that reuse tool IDs',async()=>{
    const f=await fixture(),requests:Record<string,any>[]=[];
    vi.stubGlobal('fetch',vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{requests.push(JSON.parse(String(init?.body)));return modelResponse(requests.length<=4?`第${requests.length}个范围问题`:undefined);}));
    let state=await body(await f.request(`/${f.id}/preview`,{expectedRevision:1,mode:'ai'}));
    const attempt=state.previewAttemptId;
    for(let round=1;round<=3;round++) {
      expect(state.previewState).toBe('waiting_input');expect(state.clarification.round).toBe(round);
      expect((await f.request(`/${f.id}/clarifications/${state.clarification.id}/answer`,{expectedRevision:1,text:`第${round}轮补充`})).status).toBe(200);
      state=await previewDraft(f.local,f.id,f.owner.userId,1,'ai',[],false,undefined,attempt);
    }
    expect(state.previewState).toBe('ready');expect(requests).toHaveLength(5);
    const toolResults=requests[4]!.messages.filter((m:any)=>m.role==='tool').map((m:any)=>JSON.parse(m.content));
    expect(toolResults.at(-1)).toMatchObject({status:'limit_reached',remainingRounds:0});
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM ai_clarifications WHERE draft_id=?1').bind(f.id).first<{n:number}>())!.n).toBe(3);
  });

  it('cancels a question before manual editing and rejects stale answers after whole-draft cancellation',async()=>{
    const f=await fixture();vi.stubGlobal('fetch',vi.fn(async()=>modelResponse('需要选择方向')));
    let state=await body(await f.request(`/${f.id}/preview`,{expectedRevision:1,mode:'ai'}));
    const firstId=state.clarification.id;
    const cancelled=await f.request(`/${f.id}/clarifications/${firstId}/cancel`,{expectedRevision:1});expect(cancelled.status).toBe(200);expect((await body(cancelled)).previewState).toBe('none');
    const manual=await f.request(`/${f.id}/preview`,{expectedRevision:1,mode:'manual',tasks:finalPlan.tasks});expect(manual.status).toBe(200);
    expect((await f.request(`/${f.id}/clarifications/${firstId}/answer`,{expectedRevision:1,text:'迟到回答'})).status).toBe(409);
    state=await body(await f.request(`/${f.id}/preview`,{expectedRevision:1,mode:'ai',regenerate:true}));
    expect(state.previewState).toBe('waiting_input');
    const cancelledDraft=await f.request(`/${f.id}/state`,{expectedRevision:1,status:'cancelled'});expect(cancelledDraft.status).toBe(200);
    expect((await f.request(`/${f.id}/clarifications/${state.clarification.id}/answer`,{expectedRevision:1,text:'取消后的回答'})).status).toBe(409);
    expect(await env.DB.prepare('SELECT status FROM ai_clarifications WHERE id=?1').bind(state.clarification.id).first()).toEqual({status:'cancelled'});
    expect(f.instances.size).toBe(0);
  });

  it('serializes concurrent continuation dispatches with a durable R2 compare-and-swap',async()=>{
    const f=await fixture();let finish:(value:Response)=>void=()=>{},started:()=>void=()=>{};
    const startedPromise=new Promise<void>(resolve=>{started=resolve;});
    const provider=vi.fn(async()=>{if(provider.mock.calls.length===1)return modelResponse('范围是什么');started();return new Promise<Response>(resolve=>{finish=resolve;});});vi.stubGlobal('fetch',provider);
    const state=await body(await f.request(`/${f.id}/preview`,{expectedRevision:1,mode:'ai'}));
    await f.request(`/${f.id}/clarifications/${state.clarification.id}/answer`,{expectedRevision:1,option:'教育方向'});
    const first=previewDraft(f.local,f.id,f.owner.userId,1,'ai',[],false,undefined,state.previewAttemptId);
    await startedPromise;
    const concurrent=await previewDraft(f.local,f.id,f.owner.userId,1,'ai',[],false,undefined,state.previewAttemptId);
    expect(concurrent.previewState).toBe('running');expect(provider).toHaveBeenCalledTimes(2);
    finish(modelResponse());expect((await first).previewState).toBe('ready');expect(provider).toHaveBeenCalledTimes(2);
  });

  it('recovers initial dispatch failure from its durable outbox and does not dispatch while waiting',async()=>{
    const f=await fixture();f.create.mockRejectedValueOnce(new Error('unavailable'));
    const pending=await enqueueDraftPreview(f.local,f.id,f.owner.userId,1,[],false);
    expect(pending.previewState).toBe('running');expect(pending.previewError).toContain('自动核对恢复');expect(f.instances.size).toBe(0);
    expect(await env.DB.prepare('SELECT status FROM draft_preview_dispatches WHERE instance_id=?1').bind(pending.previewAttemptId).first()).toEqual({status:'pending'});
    await recoverDraftPreviews(f.local);expect(f.instances.size).toBe(1);
    expect((await read(f)).previewError).toBeNull();
    const provider=vi.fn(async()=>modelResponse('请确认范围'));vi.stubGlobal('fetch',provider);
    const waiting=await previewDraft(f.local,f.id,f.owner.userId,1,'ai',[],false,undefined,pending.previewAttemptId!);expect(waiting.previewState).toBe('waiting_input');
    await env.DB.prepare("UPDATE draft_preview_dispatches SET status='pending' WHERE instance_id=?1").bind(pending.previewAttemptId).run();
    const calls=f.create.mock.calls.length;await recoverDraftPreviews(f.local);expect(f.create.mock.calls.length).toBe(calls);expect(provider).toHaveBeenCalledOnce();
  });

  it('recovers a persisted answer after a process crash or unknown dispatch response without a new attempt',async()=>{
    const f=await fixture();const provider=vi.fn(async()=>modelResponse(provider.mock.calls.length===1?'需要确定交付范围':undefined));vi.stubGlobal('fetch',provider);
    const waiting=await body(await f.request(`/${f.id}/preview`,{expectedRevision:1,mode:'ai'}));
    // Simulate process exit after the answer transaction but before the endpoint dispatches.
    await answerClarification(f.local,{draftId:f.id,userId:f.owner.userId,attemptId:waiting.previewAttemptId,revision:1},waiting.clarification.id,{expectedRevision:1,undecided:true});
    expect((await read(f)).previewState).toBe('running');expect(f.instances.size).toBe(0);
    expect(await env.DB.prepare('SELECT status FROM draft_preview_dispatches WHERE question_id=?1').bind(waiting.clarification.id).first()).toEqual({status:'pending'});
    f.create.mockRejectedValueOnce(new Error('lost response before acceptance'));
    await recoverDraftPreviews(f.local);expect(f.instances.size).toBe(0);expect((await read(f)).previewError).toContain('自动核对恢复');
    // A later recovery succeeds with the exact same deterministic ID.
    await recoverDraftPreviews(f.local);expect([...f.instances]).toEqual([`${waiting.previewAttemptId}-q-${waiting.clarification.id}`]);
    await recoverDraftPreviews(f.local);expect(f.create).toHaveBeenCalledTimes(2);
    const ready=await previewDraft(f.local,f.id,f.owner.userId,1,'ai',[],false,undefined,waiting.previewAttemptId);
    expect(ready.previewState).toBe('ready');expect(ready.previewAttemptId).toBe(waiting.previewAttemptId);expect(provider).toHaveBeenCalledTimes(2);
  });

  it('recognizes a successfully created Workflow after an ambiguous create response and cancels stale intents',async()=>{
    const f=await fixture();
    f.create.mockImplementationOnce(async({id})=>{f.instances.add(id);throw new Error('response lost');});
    const pending=await enqueueDraftPreview(f.local,f.id,f.owner.userId,1,[],false);
    expect(pending.previewState).toBe('running');expect(pending.previewError).toBeNull();
    expect(await env.DB.prepare('SELECT status FROM draft_preview_dispatches WHERE instance_id=?1').bind(pending.previewAttemptId).first()).toEqual({status:'dispatched'});
    await env.DB.prepare("UPDATE draft_preview_dispatches SET status='pending' WHERE instance_id=?1").bind(pending.previewAttemptId).run();
    await f.request(`/${f.id}/state`,{expectedRevision:1,status:'cancelled'});
    await recoverDraftPreviews(f.local);expect(f.create).toHaveBeenCalledOnce();
    expect(await env.DB.prepare('SELECT status FROM draft_preview_dispatches WHERE instance_id=?1').bind(pending.previewAttemptId).first()).toEqual({status:'cancelled'});
  });

  it('rejects changed configuration while waiting and never replays an uncertain paid dispatch',async()=>{
    const f=await fixture();vi.stubGlobal('fetch',vi.fn(async()=>modelResponse('选择目标')));
    const state=await body(await f.request(`/${f.id}/preview`,{expectedRevision:1,mode:'ai'}));
    await env.DB.prepare('INSERT INTO ai_config_versions(id,version,config_json,enabled,created_at) SELECT ?1,version+1,config_json,enabled,created_at FROM ai_config_versions ORDER BY version DESC LIMIT 1').bind(newId()).run();
    expect((await f.request(`/${f.id}/clarifications/${state.clarification.id}/answer`,{expectedRevision:1,text:'明确目标'})).status).toBe(409);
    expect((await read(f)).previewState).toBe('waiting_input');expect(f.instances.size).toBe(0);
    expect((await f.request(`/${f.id}/clarifications/${state.clarification.id}/cancel`,{expectedRevision:1})).status).toBe(200);
    const provider=vi.fn(async()=>{throw new TypeError('network failed');});vi.stubGlobal('fetch',provider);
    expect((await f.request(`/${f.id}/preview`,{expectedRevision:1,mode:'ai',regenerate:true})).status).toBe(503);
    const failed=await read(f);expect(failed.previewState).toBe('failed');expect(provider).toHaveBeenCalledOnce();
    const checkpoint=await loadDraftCheckpoint(f.local,failed.previewAttemptId!);expect(checkpoint!.checkpoint.pendingDispatch).toBe(true);
    await env.DB.prepare("UPDATE project_creation_drafts SET preview_state='running' WHERE id=?1").bind(f.id).run();
    expect((await previewDraft(f.local,f.id,f.owner.userId,1,'ai',[],false,undefined,failed.previewAttemptId!)).previewState).toBe('running');expect(provider).toHaveBeenCalledOnce();
  });
});
