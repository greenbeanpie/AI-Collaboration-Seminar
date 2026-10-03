import { expect, it, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import { env, BASE } from './helpers/env';
import { seedProject, seedUser, authCookie } from './helpers/seed';
import { currentProjectFeedback, saveProjectFeedback, feedbackForJob } from '../src/services/project-feedback';
import { gatewayChat } from '../src/ai/gateway';
import { aiModelConfigSchema } from '../src/ai/config';
import { newId, nowIso } from '../src/core/db';

async function fixture(){const owner=await seedUser();const projectId=await seedProject(owner.userId);return {owner,projectId};}
it('replaces and clears effective feedback while preserving versions and refusing stale saves',async()=>{
 const {owner,projectId}=await fixture();
 expect((await currentProjectFeedback(env,projectId)).version).toBe(0);
 await saveProjectFeedback(env,projectId,owner.userId,'第一版完整要求',0);
 await saveProjectFeedback(env,projectId,owner.userId,'第二版要求',1);
 await expect(saveProjectFeedback(env,projectId,owner.userId,'过期覆盖',1)).rejects.toMatchObject({code:'VERSION_CONFLICT'});
 await saveProjectFeedback(env,projectId,owner.userId,'',2);
 expect((await currentProjectFeedback(env,projectId)).feedback).toBe('');
 expect((await env.DB.prepare('SELECT COUNT(*) n FROM project_feedback_versions WHERE project_id=?1').bind(projectId).first<{n:number}>())?.n).toBe(3);
});
it('lets ordinary members read but denies feedback writes even with taskManage',async()=>{
 const {owner,projectId}=await fixture();const member=await seedUser();
 await env.DB.prepare("INSERT INTO project_members(project_id,user_id,role,joined_at,permissions_json) VALUES(?1,?2,'member',?3,?4)").bind(projectId,member.userId,nowIso(),JSON.stringify({taskManage:true})).run();
 await saveProjectFeedback(env,projectId,owner.userId,'完整上下文',0);
 const url=`${BASE}/api/v1/projects/${projectId}/collaboration/feedback/current`;
 expect((await SELF.fetch(url,{headers:{cookie:authCookie(member.token)}})).status).toBe(200);
 const response=await SELF.fetch(url,{method:'POST',headers:{cookie:authCookie(member.token),'content-type':'application/json'},body:JSON.stringify({feedback:'越权',expectedVersion:1})});
 expect(response.status).toBe(403);
});
it('freezes full job feedback and gateway transmits that version after later edits',async()=>{
 const {owner,projectId}=await fixture();const jobId=newId();
 const original='完整上下文'.repeat(250);
 const frozen=await saveProjectFeedback(env,projectId,owner.userId,original,0);
 await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'agent_run','queued',?3,?4,?4)").bind(jobId,projectId,JSON.stringify({feedbackSnapshot:frozen}),nowIso()).run();
 await saveProjectFeedback(env,projectId,owner.userId,'新版本',1);
 expect((await feedbackForJob(env,projectId,jobId)).feedback).toBe(original);
 const fetch=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({choices:[{message:{content:'ok'}}]}));
 const config=aiModelConfigSchema.parse({provider:'workers-ai',model:'fixture',timeoutMs:1000,maxInputChars:48000,maxOutputTokens:1000,supportsJson:true,supportsVision:false});
 const endpoint={accountId:'fixture',apiToken:'fixture',gatewayId:'fixture',diagnostics:env};
 await gatewayChat(endpoint,{config,projectId,jobId,messages:[{role:'user',content:'任务请求'}]},fetch);
 const body=JSON.parse(String(fetch.mock.calls[0]![1]?.body));
 expect(JSON.stringify(body)).toContain(original);expect(JSON.stringify(body)).not.toContain('新版本');
 const blocked=vi.fn();
 await expect(gatewayChat(endpoint,{config:{...config,maxInputChars:100},projectId,jobId,messages:[{role:'user',content:'请求'}]},blocked)).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});
 expect(blocked).not.toHaveBeenCalled();
});
