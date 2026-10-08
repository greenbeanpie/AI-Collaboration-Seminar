import { saveInvestigation } from '../src/services/project-investigation';
import { SELF } from 'cloudflare:test';
import { afterEach,describe,it,expect,vi } from 'vitest';
import { env,BASE } from './helpers/env';
import type { Env } from '../src/env';
import { seedProject,seedUser,authCookie } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { newId,nowIso } from '../src/core/db';
import { reserveAiSlot } from '../src/services/ai-reservations';
import { getJob } from '../src/services/jobs';
import { projectGoal } from '../src/services/project-simplification';
import { runCollaborationAiJob } from '../src/services/collaboration-ai';
import { invalidateStaleProjectClarifications,executeClarification,answerClarification,cancelClarification,listProjectClarifications,UserClarificationPending,questionInputSchema,type ClarificationBinding } from '../src/services/ai-clarifications';
import { applyToolMode,normalizeToolResponse } from '../src/ai/tool-transport';
import { askUserQuestionDefinition } from '../src/services/ai-clarifications';
import { loadAiConfig } from '../src/ai/config';
afterEach(()=>vi.unstubAllGlobals());
const question={question:'准备参加哪条赛道？',reason:'两条赛道所需交付物不同',options:['创意赛道','创业赛道'],allowUndecided:true};
async function fixture(){
 await configureGoFixture();const owner=await seedUser(),projectId=await seedProject(owner.userId),jobId=newId();
 await env.DB.prepare("UPDATE projects SET ai_collaboration_enabled=1,planning_mode='manual' WHERE id=?1").bind(projectId).run();
 const goal=await projectGoal(env,projectId),cfg=(await loadAiConfig(env.DB))!;
 const input={operation:'collaboration.decompose',projectId,requestedBy:owner.userId,settingsRevision:1,goalRevision:goal.revision,graphRevision:goal.graphRevision,goalSnapshot:goal,brief:'根据资料规划可交付的任务',configVersionId:cfg.id};
 await reserveAiSlot(env,{projectId,jobId,purpose:'assignment_suggest',maxCalls:8});
 await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'agent_run','running',?3,?4,?5,?5)").bind(jobId,projectId,JSON.stringify(input),owner.userId,nowIso()).run();
 await env.DB.prepare("INSERT INTO ai_execution_slices(job_id,slice,instance_id,status,created_at,updated_at) VALUES(?1,0,?1,'running',?2,?2)").bind(jobId,nowIso()).run();
 return {owner,projectId,jobId,binding:{userId:owner.userId,projectId,jobId,attemptId:jobId} satisfies ClarificationBinding};
}
async function ask(f:Awaited<ReturnType<typeof fixture>>,id='0:call-ask',args=question){await expect(executeClarification(env,f.binding,{id,name:'ask_user_question',args})).rejects.toBeInstanceOf(UserClarificationPending);return (await listProjectClarifications(env,f.projectId,f.owner.userId))[0]!;}
const post=(user:{token:string},path:string,body:unknown)=>SELF.fetch(BASE+path,{method:'POST',headers:{cookie:authCookie(user.token),'content-type':'application/json'},body:JSON.stringify(body)});
describe('durable AI user clarification',()=>{
 it('pauses actual provider tools before planning changes and resumes pending output without replaying the paid request',async()=>{
  const f=await fixture();let turn=0;const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{
   const body=JSON.parse(String(init?.body));expect(body.tools.some((t:any)=>t.function.name==='ask_user_question')).toBe(true);
   if(turn++===0)return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'call-ask',type:'function',function:{name:'ask_user_question',arguments:JSON.stringify(question)}}]}}],usage:{prompt_tokens:20,completion_tokens:10}});
   const answer=body.messages.find((m:any)=>m.role==='tool'&&m.tool_call_id==='call-ask');expect(JSON.parse(answer.content)).toMatchObject({status:'answered',answer:{undecided:true}});
   return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({tasks:[{key:'t1',dependsOn:[],title:'赛道共通研究成果',detail:'赛道尚未决定；先完成共通研究。工时为粗估。',criteria:'形成共通调研简报',effortHours:3}],reusedTaskIds:[]})}}],usage:{prompt_tokens:25,completion_tokens:12}});
  });vi.stubGlobal('fetch',fetch);
  await runCollaborationAiJob(env,f.jobId);expect((await getJob(env,f.jobId)).status).toBe('waiting_input');expect(fetch).toHaveBeenCalledTimes(1);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM tasks WHERE project_id=?1').bind(f.projectId).first<any>())!.n).toBe(0);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM collaboration_proposals WHERE job_id=?1').bind(f.jobId).first<any>())!.n).toBe(0);
  const q=(await listProjectClarifications(env,f.projectId,f.owner.userId))[0]!;
  await runCollaborationAiJob(env,f.jobId);expect(fetch).toHaveBeenCalledTimes(1);
  await answerClarification(env,f.binding,q.id,{expectedRevision:q.revision,undecided:true});
  await runCollaborationAiJob(env,f.jobId);expect(fetch).toHaveBeenCalledTimes(2);expect((await getJob(env,f.jobId)).status).toBe('succeeded');
  const saved=await env.DB.prepare('SELECT payload_json FROM collaboration_proposals WHERE job_id=?1').bind(f.jobId).first<any>();expect(saved.payload_json).toContain('尚未决定');
  expect((await env.DB.prepare("SELECT COUNT(*) n FROM ai_tool_calls WHERE job_id=?1 AND name='ask_user_question'").bind(f.jobId).first<any>())!.n).toBe(1);
  await expect(answerClarification(env,f.binding,q.id,{expectedRevision:q.revision,undecided:true})).resolves.toMatchObject({status:'answered'});
 });
 it('preserves an old prompt checkpoint instead of replaying its already received model response',async()=>{
  const f=await fixture();
  const raw={choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'old-call',type:'function',function:{name:'list_tasks',arguments:'{}'}}]}}]};
  const toolOutput=normalizeToolResponse('chat-completions',raw);
  await saveInvestigation(env,{projectId:f.projectId,userId:f.owner.userId,jobId:f.jobId},f.jobId+'-collaboration-decompose-v3-evidence','collaboration-decompose-v3-evidence',{step:0,exchanges:[],references:[],trace:[],pendingOutput:{...toolOutput,toolOutput,promptTokens:10,completionTokens:5,latencyMs:1}});
  const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));expect(body.messages.some((m:any)=>m.role==='tool'&&m.tool_call_id==='old-call')).toBe(true);return Response.json({choices:[{message:{content:JSON.stringify({tasks:[{title:'最小成果',detail:'共同适用',criteria:'可验收',effortHours:2}]})}}]});});vi.stubGlobal('fetch',fetch);
  await runCollaborationAiJob(env,f.jobId);expect((await getJob(env,f.jobId)).status).toBe('succeeded');expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('keeps questions and choices on reload and hides another initiator’s question details',async()=>{
  const f=await fixture(),q=await ask(f),other=await seedUser();
  await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'owner',?4)").bind(newId(),f.projectId,other.userId,nowIso()).run();
  const read=await SELF.fetch(`${BASE}/api/v1/jobs/${f.jobId}`,{headers:{cookie:authCookie(f.owner.token)}});expect(await read.json()).toMatchObject({data:{status:'waiting_input',result:{clarification:{id:q.id,options:question.options}}}});
  const readOther=await SELF.fetch(`${BASE}/api/v1/jobs/${f.jobId}`,{headers:{cookie:authCookie(other.token)}});expect(JSON.stringify(await readOther.json())).not.toContain(question.question);
  const list=await SELF.fetch(`${BASE}/api/v1/projects/${f.projectId}/ai/clarifications`,{headers:{cookie:authCookie(other.token)}});expect(list.headers.get('Cache-Control')).toBe('no-store');expect(await list.json()).toMatchObject({data:{items:[]}});
  const forbidden=await post(other,`/api/v1/projects/${f.projectId}/ai/clarifications/${q.id}/answer`,{expectedRevision:1,option:question.options[0]});expect(forbidden.status).toBe(404);
 });
 it('rejects cross-project IDs, revoked authority, unknown choices, empty answers and stale revisions',async()=>{
  const f=await fixture(),q=await ask(f),other=await fixture();
  await expect(answerClarification(env,{...f.binding,projectId:other.projectId},q.id,{expectedRevision:1,text:'回答'})).rejects.toThrow('不属于');
  for(const answer of [{option:'伪造赛道'},{text:' '},{text:'a',undecided:true},{option:question.options[0],expectedRevision:2}])await expect(answerClarification(env,f.binding,q.id,{expectedRevision:1,...answer})).rejects.toThrow();
  await env.DB.prepare("UPDATE project_members SET role='member' WHERE project_id=?1 AND user_id=?2").bind(f.projectId,f.owner.userId).run();
  await expect(answerClarification(env,f.binding,q.id,{expectedRevision:1,option:question.options[0]})).rejects.toThrow('权限已变化');
  expect((await getJob(env,f.jobId)).status).toBe('waiting_input');
 });
 it.each(['goal','settings','config'])('rejects changed %s snapshots before accepting an answer',async(change)=>{
  const f=await fixture(),q=await ask(f);
  if(change==='goal')await env.DB.prepare('UPDATE project_goals SET revision=revision+1 WHERE project_id=?1').bind(f.projectId).run();
  if(change==='settings')await env.DB.prepare('UPDATE projects SET collaboration_revision=collaboration_revision+1 WHERE id=?1').bind(f.projectId).run();
  if(change==='config')await env.DB.prepare('UPDATE ai_config_versions SET enabled=0').run();
  await expect(answerClarification(env,f.binding,q.id,{expectedRevision:1,text:'补充'})).rejects.toThrow('已变化');
  // Users may cancel a stale request without requiring the old config to become valid.
  await expect(cancelClarification(env,f.binding,q.id,1)).resolves.toMatchObject({status:'cancelled'});
 });
 it('concurrent same answers enqueue exactly one continuation and a different late answer cannot overwrite',async()=>{
  const f=await fixture(),q=await ask(f);const a={expectedRevision:1,option:question.options[0]};
  const results=await Promise.allSettled([answerClarification(env,f.binding,q.id,a),answerClarification(env,f.binding,q.id,a)]);
  expect(results.every(r=>r.status==='fulfilled')).toBe(true);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM ai_execution_slices WHERE job_id=?1').bind(f.jobId).first<any>())!.n).toBe(2);
  await expect(answerClarification(env,f.binding,q.id,{expectedRevision:1,option:question.options[1]})).rejects.toThrow('已回答');
  await answerClarification(env,f.binding,q.id,a);expect((await env.DB.prepare('SELECT COUNT(*) n FROM ai_execution_slices WHERE job_id=?1').bind(f.jobId).first<any>())!.n).toBe(2);
 });
 it('a cancellation losing to an answer cannot falsely mark the continuing tool as cancelled',async()=>{
  const f=await fixture(),q=await ask(f);let raced=false;
  const db=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!raced){raced=true;await answerClarification(env,f.binding,q.id,{expectedRevision:1,text:'先提交的回答'});}return target.batch(statements);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  await expect(cancelClarification({...env,DB:db} as Env,f.binding,q.id,1)).rejects.toThrow('问题已变化');
  expect((await getJob(env,f.jobId)).status).toBe('running');
  const audit=await env.DB.prepare('SELECT result_json FROM ai_tool_calls WHERE id=?1').bind(q.id).first<any>();expect(JSON.parse(audit.result_json).status).toBe('answered');
  expect((await env.DB.prepare('SELECT status,answer_json FROM ai_clarifications WHERE id=?1').bind(q.id).first<any>())!.status).toBe('answered');
 });
 it('an authority race inside the write transaction cannot store an answer or create a continuation',async()=>{
  const f=await fixture(),q=await ask(f);let raced=false;
  const db=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!raced){raced=true;await target.prepare("UPDATE project_members SET role='member' WHERE project_id=?1 AND user_id=?2").bind(f.projectId,f.owner.userId).run();}return target.batch(statements);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  await expect(answerClarification({...env,DB:db} as Env,f.binding,q.id,{expectedRevision:1,text:'回答'})).rejects.toThrow('上下文发生变化');
  expect((await env.DB.prepare('SELECT status,answer_json FROM ai_clarifications WHERE id=?1').bind(q.id).first<any>())).toMatchObject({status:'pending',answer_json:null});
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM ai_execution_slices WHERE job_id=?1').bind(f.jobId).first<any>())!.n).toBe(1);
 });
 it('cancels durably, releases remaining reservation safely and refuses late answers or provider replay',async()=>{
  const f=await fixture(),q=await ask(f);await cancelClarification(env,f.binding,q.id,1);await cancelClarification(env,f.binding,q.id,1);
  expect((await getJob(env,f.jobId)).status).toBe('cancelled');expect(await listProjectClarifications(env,f.projectId,f.owner.userId)).toEqual([]);
  await expect(answerClarification(env,f.binding,q.id,{expectedRevision:1,text:'迟到'})).rejects.toThrow();
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await runCollaborationAiJob(env,f.jobId);expect(fetch).not.toHaveBeenCalled();
 });
 it('invalidates a revoked pending requester without running a model or leaving the budget reserved',async()=>{
  const f=await fixture(),q=await ask(f);await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(f.projectId,f.owner.userId).run();
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await invalidateStaleProjectClarifications(env);
  expect((await getJob(env,f.jobId)).status).toBe('failed');expect((await env.DB.prepare('SELECT status FROM ai_clarifications WHERE id=?1').bind(q.id).first<any>())!.status).toBe('cancelled');
  expect((await env.DB.prepare('SELECT status FROM usage_reservations WHERE job_id=?1').bind(f.jobId).first<any>())!.status).not.toBe('reserved');expect(fetch).not.toHaveBeenCalled();
 });
 it('provides a genuine tool definition for all existing provider protocols',async()=>{
  const cfg=(await loadAiConfig(env.DB))!.config.textEconomy;
  for(const protocol of ['chat-completions','responses','messages','gemini'] as const){const body:any={messages:[],contents:[],input:[]};applyToolMode({...cfg,apiProtocol:protocol},protocol,body,{definitions:[askUserQuestionDefinition]});expect(JSON.stringify(body)).toContain('ask_user_question');}
  expect(questionInputSchema.safeParse({...question,options:['重复','重复']}).success).toBe(false);
 });
});
