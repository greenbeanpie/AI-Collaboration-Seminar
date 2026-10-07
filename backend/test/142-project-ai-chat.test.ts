import { SELF } from 'cloudflare:test';
import { afterEach,describe,it,expect,vi } from 'vitest';
import { env,BASE } from './helpers/env';
import { seedProject,seedUser,authCookie } from './helpers/seed';
import { configureGoFixture,assertGoRequest } from './helpers/provider-config';
import { newId,nowIso } from '../src/core/db';
import { runProjectChatJob,assertChatJob,chatContextStamp,recordChatOperation,chatResourceHref,clearChat,recoverChatContextCleanup } from '../src/services/project-ai-chat';
import { retryFailedAiJob } from '../src/services/admin-ai-retries';
import { getJob,failJob } from '../src/services/jobs';
const request=(token:string,path:string,body?:unknown,method=body?'POST':'GET',key=newId())=>SELF.fetch(BASE+'/api/v1'+path,{method,headers:{cookie:authCookie(token),'content-type':'application/json','idempotency-key':key},...(body?{body:JSON.stringify(body)}:{})});
afterEach(()=>vi.unstubAllGlobals());
async function fixture(){await configureGoFixture();const owner=await seedUser(),projectId=await seedProject(owner.userId);await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(projectId).run();await chatContextStamp(env,projectId);return {owner,projectId,path:`/projects/${projectId}/ai-chat`};}
async function question(f:Awaited<ReturnType<typeof fixture>>,content='这个项目的目标是什么？'){const r=await request(f.owner.token,f.path,{content});expect(r.status).toBe(202);return (await r.json() as {data:{questionId:string;jobId:string}}).data;}
function provider(){const mock=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{assertGoRequest(url,init);return Response.json({choices:[{message:{content:JSON.stringify({markdown:'当前项目目标见项目主目标，尚无其他资料。',referenceIds:[]})}}],usage:{prompt_tokens:10,completion_tokens:10}});});vi.stubGlobal('fetch',mock);return mock;}
describe('private project AI chat',()=>{
 it('saves answer, safe resource operations and restored history with idempotent creation',async()=>{const f=await fixture();provider();const key=newId();const first=await request(f.owner.token,f.path,{content:'目标？'},'POST',key);expect(first.status).toBe(202);const q=(await first.json() as any).data;expect((await (await request(f.owner.token,f.path,{content:'目标？'},'POST',key)).json() as any).data).toEqual(q);await runProjectChatJob(env,q.jobId);expect((await getJob(env,q.jobId)).status).toBe('succeeded');const history=(await (await request(f.owner.token,f.path)).json() as any).data;expect(history.items.map((m:any)=>m.role)).toEqual(['user','assistant']);const ops=(await (await request(f.owner.token,f.path+`/questions/${q.questionId}/operations`)).json() as any).data;expect(ops.items.length).toBeGreaterThanOrEqual(4);expect(ops.items[0]).toMatchObject({status:'completed',kind:'read',attempt:1});expect(JSON.stringify(ops)).not.toContain('args_json');expect((await request(f.owner.token,f.path,undefined,'DELETE')).status).toBe(200);expect((await request(f.owner.token,`/jobs/${q.jobId}`)).status).toBe(403);});
 it('isolates users, refuses concurrent questions and clear while pending',async()=>{const f=await fixture(),other=await seedUser();await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(),f.projectId,other.userId,nowIso()).run();const q=await question(f);expect((await request(f.owner.token,f.path,{content:'再问'})).status).toBe(409);expect((await request(f.owner.token,f.path,undefined,'DELETE')).status).toBe(409);expect((await request(other.token,`/jobs/${q.jobId}`)).status).toBe(403);expect((await request(other.token,`/projects/${f.projectId}/ai-tools/calls?jobId=${q.jobId}`)).status).toBe(403);expect((await (await request(other.token,f.path)).json() as any).data.items).toEqual([]);expect((await request(other.token,f.path+`/questions/${q.questionId}/operations`)).status).toBe(404);});
 it('resumes failed jobs under original question with attempt history and rejects cleared jobs',async()=>{const f=await fixture(),q=await question(f);await recordChatOperation(env,q.questionId,q.jobId,{key:'read',name:'read_resource',status:'running'});await failJob(env,q.jobId,{code:'INVALID_STATE',message:'test interruption'});const failedState=(await (await request(f.owner.token,`/jobs/${q.jobId}`)).json() as any).data;expect(failedState.activity.resumeReason).toContain('尚未保存检查点');const retry=await retryFailedAiJob(env,q.jobId,undefined,undefined,{actorId:f.owner.userId,allowUncertainDispatch:true});expect(retry.status).toBe('queued');expect((await assertChatJob(env,retry.jobId!)).q.id).toBe(q.questionId);await recordChatOperation(env,q.questionId,retry.jobId!,{key:'read',name:'read_resource',status:'completed'});const ops=(await (await request(f.owner.token,f.path+`/questions/${q.questionId}/operations`)).json() as any).data.items;expect(ops.map((o:any)=>o.attempt)).toEqual([1,2]);expect(ops[0].status).toBe('failed');await failJob(env,retry.jobId!,{code:'INVALID_STATE',message:'interrupted'});expect((await request(f.owner.token,f.path,undefined,'DELETE')).status).toBe(200);expect((await retryFailedAiJob(env,retry.jobId!)).status).toBe('skipped');});
 it('rejects stale context and revoked membership before retry',async()=>{const f=await fixture(),q=await question(f);const stamp=await chatContextStamp(env,f.projectId);await failJob(env,q.jobId,{code:'INVALID_STATE',message:'interrupted'});await env.DB.prepare("UPDATE projects SET description='changed' WHERE id=?1").bind(f.projectId).run();expect(await chatContextStamp(env,f.projectId)).not.toBe(stamp);expect((await retryFailedAiJob(env,q.jobId)).status).toBe('skipped');await env.DB.prepare('DELETE FROM project_members WHERE project_id=?1 AND user_id=?2').bind(f.projectId,f.owner.userId).run();expect((await request(f.owner.token,f.path)).status).toBe(403);});
});

describe('chat durable recovery',()=>{
 it('reads a real project material through tools and saves only the selected fixed-version citation',async()=>{
  const f=await fixture(),materialId=newId(),versionId=newId(),now=nowIso();
  await env.DB.batch([
   env.DB.prepare("INSERT INTO materials(id,project_id,title,created_by,created_at,updated_at,current_version_id) VALUES(?1,?2,'调研说明',?3,?4,?4,?5)").bind(materialId,f.projectId,f.owner.userId,now,versionId),
   env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES(?1,?2,?3,1,'{}','报告必须包含三个调查样本。','manual',?4,?5)").bind(versionId,materialId,f.projectId,f.owner.userId,now),
  ]);
  const q=await question(f,'报告需要几个调查样本？');
  let calls=0;
  vi.stubGlobal('fetch',vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
   assertGoRequest(url,init);calls++;
   if(calls===1)return Response.json({choices:[{message:{content:null,tool_calls:[{id:'read-material',type:'function',function:{name:'read_resource',arguments:JSON.stringify({resourceType:'material',versionId,offset:0})}}]}}],usage:{prompt_tokens:10,completion_tokens:10}});
   const body=JSON.parse(String(init?.body)) as {messages:Array<{role:string;content:string}>};
   const tool=body.messages.find(message=>message.role==='tool');
   expect(tool).toBeDefined();
   const read=JSON.parse(tool!.content) as {text:string;referenceIds:string[]};
   expect(read.text).toContain('三个调查样本');
   return Response.json({choices:[{message:{content:JSON.stringify({markdown:'依据调研说明，报告需要三个调查样本。',referenceIds:read.referenceIds})}}],usage:{prompt_tokens:10,completion_tokens:10}});
  }));
  await runProjectChatJob(env,q.jobId);
  expect((await getJob(env,q.jobId)).status).toBe('succeeded');
  const history=(await (await request(f.owner.token,f.path)).json() as {data:{items:Array<{role:string;references:Array<{title:string;href:string}>}>}}).data;
  expect(history.items.find(message=>message.role==='assistant')?.references).toEqual([{title:'调研说明',href:`/app/projects/${f.projectId}/data?resourceType=material&resourceId=${materialId}&materialVersionId=${versionId}`}]);
  const operations=(await (await request(f.owner.token,f.path+`/questions/${q.questionId}/operations`)).json() as {data:{items:Array<{label:string;status:string}>}}).data.items;
  expect(operations).toContainEqual(expect.objectContaining({label:'读取调研说明',status:'completed'}));
  expect(calls).toBe(2);
 });
 it('never caches personal history or an unauthorized chat response',async()=>{
  const f=await fixture(),outsider=await seedUser();
  for(const token of [f.owner.token,outsider.token]){
   const response=await request(token,f.path);
   expect(response.headers.get('cache-control')).toContain('no-store');
   expect(response.status).toBe(token===f.owner.token?200:403);
  }
 });
 it('reuses the encrypted complete answer after D1 save failure without another provider request',async()=>{
  const f=await fixture(),mock=provider(),q=await question(f);
  let blocked=true;
  const db=new Proxy(env.DB,{get(target,key){if(key==='prepare')return (sql:string)=>{if(blocked&&sql.startsWith('INSERT OR IGNORE INTO project_ai_chat_messages')){blocked=false;throw new Error('injected answer save outage');}return target.prepare(sql);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  await runProjectChatJob({...env,DB:db},q.jobId);
  expect((await getJob(env,q.jobId)).status).toBe('failed');expect(mock).toHaveBeenCalledTimes(1);
  expect(await env.FILES.get(`ai/project-chat/${q.questionId}/${q.jobId}.json`)).not.toBeNull();
  const next=await retryFailedAiJob(env,q.jobId,undefined,undefined,{actorId:f.owner.userId,allowUncertainDispatch:true});expect(next.status).toBe('queued');
  await runProjectChatJob(env,next.jobId!);expect((await getJob(env,next.jobId!)).status).toBe('succeeded');expect(mock).toHaveBeenCalledTimes(1);
  const history=(await (await request(f.owner.token,f.path)).json() as any).data.items;expect(history).toHaveLength(2);
  await request(f.owner.token,f.path,undefined,'DELETE');expect(await env.FILES.get(`ai/project-chat/${q.questionId}/${q.jobId}.json`)).toBeNull();
  expect(await env.FILES.get(`ai/investigations/${q.jobId}-project-chat-v1/${q.jobId}.json`)).toBeNull();
 });
 it('requires manual consent for an unconfirmed provider response and resumes the same question',async()=>{
  const f=await fixture(),q=await question(f);let calls=0;
  vi.stubGlobal('fetch',vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{assertGoRequest(url,init);calls++;if(calls===1)throw new Error('network response lost');return Response.json({choices:[{message:{content:JSON.stringify({markdown:'继续成功',referenceIds:[]})}}],usage:{prompt_tokens:10,completion_tokens:10}});}));
  await runProjectChatJob(env,q.jobId);expect((await getJob(env,q.jobId)).status).toBe('failed');
  const state=(await (await request(f.owner.token,`/jobs/${q.jobId}`)).json() as any).data;expect(state.activity.uncertain).toBe(true);
  const automatic=await env.DB.prepare("SELECT 1 FROM ai_automatic_retries WHERE target_id=?1 AND status IN ('pending','dispatching')").bind(q.jobId).first();expect(automatic).toBeNull();
  const next=await retryFailedAiJob(env,q.jobId,undefined,undefined,{actorId:f.owner.userId,allowUncertainDispatch:true});await runProjectChatJob(env,next.jobId!);expect((await getJob(env,next.jobId!)).status).toBe('succeeded');expect(calls).toBe(2);
 });
 it('preserves completed tools when interrupted before the next model step',async()=>{
  const f=await fixture(),q=await question(f);let calls=0;
  vi.stubGlobal('fetch',vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{assertGoRequest(url,init);calls++;if(calls===1)return Response.json({choices:[{message:{content:null,tool_calls:[{id:'task-call',type:'function',function:{name:'list_tasks',arguments:'{"offset":0}'}}]}}],usage:{prompt_tokens:10,completion_tokens:10}});if(calls===2)throw new Error('interrupted after tools');return Response.json({choices:[{message:{content:JSON.stringify({markdown:'任务情况已核对',referenceIds:[]})}}],usage:{prompt_tokens:10,completion_tokens:10}});}));
  await runProjectChatJob(env,q.jobId);expect((await getJob(env,q.jobId)).status).toBe('failed');
  const first=await env.DB.prepare("SELECT COUNT(*) n FROM ai_tool_calls WHERE job_id=?1 AND name='list_tasks'").bind(q.jobId).first<{n:number}>();expect(first?.n).toBe(1);
  const next=await retryFailedAiJob(env,q.jobId,undefined,undefined,{actorId:f.owner.userId,allowUncertainDispatch:true});await runProjectChatJob(env,next.jobId!);expect((await getJob(env,next.jobId!)).status).toBe('succeeded');
  const repeat=await env.DB.prepare("SELECT COUNT(*) n FROM ai_tool_calls WHERE job_id=?1 AND name='list_tasks'").bind(next.jobId!).first<{n:number}>();expect(repeat?.n).toBe(0);expect(calls).toBe(3);
 });
 it('does not invoke the provider when AI is disabled, but retains read and clear access',async()=>{
  const f=await fixture(),q=await question(f),mock=provider();await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=0 WHERE id=?1').bind(f.projectId).run();await runProjectChatJob(env,q.jobId);expect(mock).not.toHaveBeenCalled();expect((await getJob(env,q.jobId)).status).toBe('failed');expect((await request(f.owner.token,f.path,{content:'disabled'})).status).toBe(503);expect((await request(f.owner.token,f.path)).status).toBe(200);expect((await request(f.owner.token,f.path,undefined,'DELETE')).status).toBe(200);
 });
});


describe('chat paging, locators and clear fencing',()=>{
 it('paginates complete question pairs and keeps chronological order',async()=>{
  const f=await fixture(),sessionId=newId(),stamp=await chatContextStamp(env,f.projectId),now=nowIso();
  await env.DB.prepare('INSERT INTO project_ai_chat_sessions(id,project_id,user_id,updated_at) VALUES(?1,?2,?3,?4)').bind(sessionId,f.projectId,f.owner.userId,now).run();
  for(let i=0;i<21;i++){const id=newId();await env.DB.batch([
   env.DB.prepare('INSERT INTO project_ai_chat_questions(id,session_id,generation,project_id,user_id,content,job_id,context_stamp,created_at) VALUES(?1,?2,1,?3,?4,?5,?6,?7,?8)').bind(id,sessionId,f.projectId,f.owner.userId,'question '+i,newId(),stamp,now),
   env.DB.prepare("INSERT INTO project_ai_chat_messages(question_id,role,content,created_at) VALUES(?1,'user',?2,?3)").bind(id,'question '+i,now),
   env.DB.prepare("INSERT INTO project_ai_chat_messages(question_id,role,content,created_at) VALUES(?1,'assistant',?2,?3)").bind(id,'answer '+i,now),
  ]);}
  const latest=(await (await request(f.owner.token,f.path)).json() as any).data;expect(latest.items).toHaveLength(40);expect(latest.items[0].content).toBe('question 1');expect(latest.items.at(-1).content).toBe('answer 20');
  for(let i=0;i<latest.items.length;i+=2)expect(latest.items[i].questionId).toBe(latest.items[i+1].questionId);
  const older=(await (await request(f.owner.token,f.path+'?cursor='+latest.nextCursor)).json() as any).data;expect(older.items.map((m:any)=>m.content)).toEqual(['question 0','answer 0']);expect(older.nextCursor).toBeNull();
 });
 it('uses existing project workspace locators for source pages, material versions and tasks',()=>{
  expect(chatResourceHref('p',{resourceType:'source',resourceId:'s',versionId:'v',pageNumber:3})).toBe('/app/projects/p/data?resourceType=source&resourceId=s&sourceVersionId=v&page=3#source-page-s-3');
  expect(chatResourceHref('p',{resourceType:'material',resourceId:'m',versionId:'v'})).toBe('/app/projects/p/data?resourceType=material&resourceId=m&materialVersionId=v');
  expect(chatResourceHref('p',{resourceType:'project',resourceId:'p'})).toBe('/app/projects/p');
  expect(chatResourceHref('p',{resourceType:'assessment',resourceId:'a'})).toBe('/app/projects/p/assessment?section=checks&assessmentId=a');
  expect(chatResourceHref('p',{resourceType:'event',resourceId:'e'})).toBe('/app/projects/p/ledger');
  expect(chatResourceHref('p',{resourceType:'task',resourceId:'t'})).toBe('/app/projects/p/tasks?task=t');
 });
 it('keeps cleared contexts fenced when object deletion fails and retries durable cleanup',async()=>{
  const f=await fixture(),q=await question(f);await failJob(env,q.jobId,{code:'INVALID_STATE',message:'failed'});await env.FILES.put(`ai/project-chat/${q.questionId}/${q.jobId}.json`,'private test');
  const files=new Proxy(env.FILES,{get(target,key){if(key==='delete')return ()=>Promise.reject(new Error('temporary object deletion outage'));const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  expect(await clearChat({...env,FILES:files},f.projectId,f.owner.userId)).toEqual({cleared:true});
  expect((await retryFailedAiJob(env,q.jobId)).status).toBe('skipped');
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM project_ai_chat_context_cleanup').first<{n:number}>())?.n).toBeGreaterThan(0);
  await recoverChatContextCleanup(env);expect(await env.FILES.get(`ai/project-chat/${q.questionId}/${q.jobId}.json`)).toBeNull();
 });
 it('serializes concurrent clear and retry without resurrecting deleted questions',async()=>{
  const f=await fixture(),q=await question(f);await failJob(env,q.jobId,{code:'INVALID_STATE',message:'failed'});
  const [cleared,retry]=await Promise.allSettled([clearChat(env,f.projectId,f.owner.userId),retryFailedAiJob(env,q.jobId,undefined,undefined,{actorId:f.owner.userId,allowUncertainDispatch:true})]);
  if(cleared.status==='fulfilled'){expect(retry.status==='fulfilled'&&retry.value.status).toBe('skipped');expect((await (await request(f.owner.token,f.path)).json() as any).data.items).toEqual([]);}
  else{expect(retry.status==='fulfilled'&&retry.value.status).toBe('queued');expect((await request(f.owner.token,f.path,undefined,'DELETE')).status).toBe(409);}
 });
});
