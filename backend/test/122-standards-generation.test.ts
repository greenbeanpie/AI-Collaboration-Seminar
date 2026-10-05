import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, BASE } from './helpers/env';
import { configureGoFixture, assertGoRequest } from './helpers/provider-config';
import { seedProject, seedUser, authCookie } from './helpers/seed';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { generatedStandardSchema, enqueueStandardsGeneration } from '../src/services/standards-generation';
import { runAiJob } from '../src/services/ai-jobs';
import { getJob } from '../src/services/jobs';
import { projectGoal, saveStandard } from '../src/services/project-simplification';
import { newId, nowIso } from '../src/core/db';
await configureGoFixture();
afterEach(()=>vi.unstubAllGlobals());
const offline={...env,AGENT_WORKFLOW:{create:async()=>{throw new Error('offline fixture');}}} as unknown as Env;
const draft={methodSource:'proposed',dimensions:[{key:'quality',label:'成果质量',weight:100,citations:[]}]};
async function fixture(){await env.DB.prepare('UPDATE ai_config_versions SET enabled=1').run();const user=await seedUser(),projectId=await seedProject(user.userId);return {user,projectId};}
function provider(before?:()=>Promise<void>){const fn=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{assertGoRequest(url,init);await before?.();return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...draft,referenceIds:[],decisionReferences:[]})}}],usage:{prompt_tokens:30,completion_tokens:20}}),{headers:{'content-type':'application/json'}});});vi.stubGlobal('fetch',fn);return fn;}
describe('AI project standards drafts',()=>{
  it('rejects old broad-output jobs before any model call instead of reopening their paid investigation',async()=>{
    const f=await fixture(),job=await enqueueStandardsGeneration(offline,f.projectId,f.user.userId),mock=provider();
    await env.DB.prepare("UPDATE jobs SET input_json=json_remove(input_json,'$.scoringOutputVersion') WHERE id=?1").bind(job.jobId).run();
    await runAiJob(offline,job.jobId);expect((await getJob(env,job.jobId)).status).toBe('failed');expect(mock).not.toHaveBeenCalled();
  });
  it('retains real scoring citations from tool reads through generation and saved standard snapshots',async()=>{
    const f=await fixture(),sourceId=newId(),versionId=newId(),fragmentId=newId(),fileId=newId(),now=nowIso();
    await env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,created_by,created_at,updated_at) VALUES(?1,?2,'不相关的内部任务描述','不相关的内部任务描述','todo',?3,?4,?4)").bind(newId(),f.projectId,f.user.userId,now).run();
    await env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,original_name,created_at) VALUES(?1,?2,?3,?1,'.pdf','available','评分方法.pdf',?4)").bind(fileId,f.projectId,f.user.userId,now).run();
    await env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'file','评分方法',?3,?4,?5,?5)").bind(sourceId,f.projectId,versionId,f.user.userId,now).run();
    await env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,status,created_at) VALUES(?1,?2,?3,1,'file',?4,'ready',?5)").bind(versionId,sourceId,f.projectId,fileId,now).run();
    await env.DB.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,page_number,seq,kind,content,created_at) VALUES(?1,?2,?3,1,1,'text','成果质量60分；证据质量40分。报名截止12日。',?4)").bind(fragmentId,versionId,f.projectId,now).run();
    const referenceId=`source:${versionId}:${fragmentId}:0`;
    let calls=0;
    vi.stubGlobal('fetch',vi.fn(async(url,init)=>{assertGoRequest(url,init);expect(String(init?.body)).not.toContain('不相关的内部任务描述');calls++;return Response.json({choices:[{message:calls===1?{content:null,tool_calls:[{id:'read',type:'function',function:{name:'read_resource',arguments:JSON.stringify({resourceType:'source',versionId,offset:0})}}]}:{content:JSON.stringify({methodSource:'documented',dimensions:[{key:'quality',label:'成果质量',weight:60,citations:[{referenceId,quote:'成果质量60分'}]},{key:'evidence',label:'证据质量',weight:40,citations:[{referenceId,quote:'证据质量40分'}]}],referenceIds:[referenceId],decisionReferences:[]})}}],usage:{prompt_tokens:30,completion_tokens:20}});}));
    const job=await enqueueStandardsGeneration(offline,f.projectId,f.user.userId);await runAiJob(offline,job.jobId);
    const completed=await getJob(env,job.jobId);expect(completed.status,completed.error_json??'').toBe('succeeded');
    const result=JSON.parse(completed.result_json!);expect(result.draft.requirements[0].citations[0]).toMatchObject({sourceVersionId:versionId,fragmentId,fileName:'评分方法.pdf',quote:'成果质量60分'});
    expect(JSON.stringify(result)).not.toContain('报名');
    const saved=await saveStandard(env,f.projectId,f.user.userId,result.draft);expect(saved.requirements[1]!.citations[0]).toMatchObject({sourceVersionId:versionId,quote:'证据质量40分'});
  });
  it('rejects malformed weights and nonexistent mapped dimensions',()=>{expect(generatedStandardSchema.safeParse(draft).success).toBe(true);expect(generatedStandardSchema.safeParse({...draft,dimensions:[{key:'other',label:'其他',weight:90,citations:[]}]}).success).toBe(false);});
  it('runs through the AI workflow and keeps generation unsaved and activates the owner-saved version immediately',async()=>{const f=await fixture(),job=await enqueueStandardsGeneration(offline,f.projectId,f.user.userId),mock=provider();await runAiJob(offline,job.jobId);const result=await getJob(env,job.jobId);expect(result.status).toBe('succeeded');expect(JSON.parse(result.result_json!).draft).toMatchObject({requirements:[{category:'scoring',detail:'',citations:[]}],weights:[{label:'成果质量',weight:100}],notes:''});expect(await env.DB.prepare('SELECT id FROM standards_versions WHERE project_id=?1').bind(f.projectId).first()).toBeNull();const saved=await saveStandard(env,f.projectId,f.user.userId,JSON.parse(result.result_json!).draft);expect(saved.status).toBe('confirmed');expect(saved.active).toBe(true);await runAiJob(offline,job.jobId);expect(mock).toHaveBeenCalledTimes(1);});
  it('rejects changed goal and revoked ownership before sending a model request',async()=>{const f=await fixture(),a=await enqueueStandardsGeneration(offline,f.projectId,f.user.userId),mock=provider();await env.DB.prepare('UPDATE project_goals SET revision=revision+1 WHERE project_id=?1').bind(f.projectId).run();await runAiJob(offline,a.jobId);expect((await getJob(env,a.jobId)).status).toBe('failed');const b=await enqueueStandardsGeneration(offline,f.projectId,f.user.userId);await env.DB.prepare("UPDATE project_members SET role='member' WHERE project_id=?1").bind(f.projectId).run();await runAiJob(offline,b.jobId);expect((await getJob(env,b.jobId)).status).toBe('failed');expect(mock).not.toHaveBeenCalled();});
  it('rejects a late response after the project goal changes',async()=>{const f=await fixture(),a=await enqueueStandardsGeneration(offline,f.projectId,f.user.userId);provider(async()=>{await env.DB.prepare('UPDATE project_goals SET revision=revision+1 WHERE project_id=?1').bind(f.projectId).run();});await runAiJob(offline,a.jobId);expect((await getJob(env,a.jobId)).status).toBe('failed');});
  it('enforces permission and idempotency at the HTTP endpoint',async()=>{const f=await fixture(),app=createApp(),key=crypto.randomUUID();const request=(token:string)=>app.fetch(new Request(`${BASE}/api/v1/projects/${f.projectId}/standards/generate`,{method:'POST',headers:{cookie:authCookie(token),'content-type':'application/json','idempotency-key':key},body:'{}'}),offline);const first=await request(f.user.token),again=await request(f.user.token);expect(first.status).toBe(202);expect(again.status).toBe(202);expect((await first.json() as any).data.jobId).toBe((await again.json() as any).data.jobId);const outsider=await seedUser();expect((await request(outsider.token)).status).toBe(403);const goal=await projectGoal(env,f.projectId);expect(goal.revision).toBe(1);});
});
