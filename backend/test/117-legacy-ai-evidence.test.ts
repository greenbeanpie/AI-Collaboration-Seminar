import { saveStandard } from '../src/services/project-simplification';
import { createExecutionContext,waitOnExecutionContext } from 'cloudflare:test';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { env,BASE } from './helpers/env';
import { seedProject,seedUser,authCookie } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { createApp } from '../src/app';
import { newId,nowIso } from '../src/core/db';
import { reserveAiSlot } from '../src/services/ai-reservations';
import { snapshotRequirementSources } from '../src/services/source-inputs';
import { runReviewJob } from '../src/services/review';
import { runRehearsalTurnJob } from '../src/services/rehearsal';
import { getJob } from '../src/services/jobs';
await configureGoFixture();
afterEach(()=>vi.unstubAllGlobals());
async function fixture(){
  const owner=await seedUser(),member=await seedUser(),projectId=await seedProject(owner.userId),now=nowIso(),sourceId=newId(),versionId=newId(),setId=newId(),rubricId=newId(),materialId=newId(),materialVersionId=newId();
  const weights=[{key:'content',label:'内容',weight:60},{key:'evidence',label:'证据',weight:40}],markdown='固定成果正文：三条样本均记录采集日期。';
  await env.DB.batch([
    env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(),projectId,member.userId,now),
    env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'paste','要求来源',?3,?4,?5,?5)").bind(sourceId,projectId,versionId,owner.userId,now),
    env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,status,created_at) VALUES(?1,?2,?3,1,'paste','ready',?4)").bind(versionId,sourceId,projectId,now),
    env.DB.prepare("INSERT INTO requirement_sets(id,project_id,source_version_id,status,revision,created_at,updated_at) VALUES(?1,?2,?3,'confirmed',1,?4,?4)").bind(setId,projectId,versionId,now),
    env.DB.prepare("INSERT INTO rubric_versions(id,project_id,version,source,weights_json,status,created_at) VALUES(?1,?2,1,'custom',?3,'confirmed',?4)").bind(rubricId,projectId,JSON.stringify(weights),now),
    env.DB.prepare("INSERT INTO materials(id,project_id,title,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'成果',?3,?4,?5,?5)").bind(materialId,projectId,materialVersionId,owner.userId,now),
    env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES(?1,?2,?3,1,'{}',?4,'manual',?5,?6)").bind(materialVersionId,materialId,projectId,markdown,owner.userId,now),
  ]);
  const standard=await saveStandard(env,projectId,owner.userId,{requirementSetIds:[setId],rubricVersionId:rubricId});
  return {standardId:standard.standardsVersionId,owner,member,projectId,setId,rubricId,materialVersionId,markdown,weights};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function job(f:Fixture,kind:'review_run'|'rehearsal_turn',input:unknown){
  const id=newId(),now=nowIso();await reserveAiSlot(env,{projectId:f.projectId,jobId:id,purpose:kind,maxCalls:24});
  await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,?5,?6,?6)").bind(id,f.projectId,kind,JSON.stringify(input),f.owner.userId,now).run();return id;
}
async function review(f:Fixture){
  const id=newId(),sourceSnapshots=await snapshotRequirementSources(env,f.projectId,f.setId);
  await env.DB.prepare("INSERT INTO reviews(id,project_id,requirement_set_id,rubric_version_id,material_version_ids_json,status,created_by,created_at) VALUES(?1,?2,?3,?4,?5,'pending',?6,?7)").bind(id,f.projectId,f.setId,f.rubricId,JSON.stringify([f.materialVersionId]),f.owner.userId,nowIso()).run();
  return {id,jobId:await job(f,'review_run',{reviewId:id,projectId:f.projectId,standardsVersionId:f.standardId,sourceSnapshots})};
}
function provider(output:unknown,capture?:(body:{messages:Array<{role:string;content:string}>})=>void){
  const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{capture?.(JSON.parse(String(init?.body)));return Response.json({choices:[{message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:10,completion_tokens:5}});});vi.stubGlobal('fetch',fetch);return fetch;
}
function report(f:Fixture,proof=true){return {scores:f.weights.map((weight,index)=>({key:weight.key,score:index?60:80,confidence:.9,comment:'固定成果评语',suggestions:[],evidence:proof?[{materialVersionId:f.materialVersionId,quote:'三条样本均记录采集日期。'}]:[]})),overall:{score:1,summary:'固定成果评价'},referenceIds:[],decisionReferences:[{decisionPath:'overall.summary',referenceIds:[`project:${f.projectId}:0`]}]};}
async function request(f:Fixture,path:string,method='GET',body?:unknown){const ctx=createExecutionContext();const res=await createApp().fetch(new Request(`${BASE}/api/v1/projects/${f.projectId}/${path}`,{method,headers:{cookie:authCookie(f.owner.token),'content-type':'application/json','idempotency-key':newId()},...(body?{body:JSON.stringify(body)}:{})}),env,ctx);await waitOnExecutionContext(ctx);return res;}
describe('legacy AI compatibility retains trustworthy evidence',()=>{
  it('computes weighted total on the server and preserves references through the old review shape',async()=>{
    const f=await fixture(),r=await review(f);provider(report(f));await runReviewJob(env,r.jobId);
    expect((await getJob(env,r.jobId)).status).toBe('succeeded');
    const response=await request(f,`reviews/${r.id}`),body=await response.json() as {data:{report:{scores:unknown[];overall:{score:number};status:string;references:unknown[];decisionReferences:unknown[]}}};
    expect(body.data.report.overall.score).toBe(72);expect(body.data.report.status).toBe('scored');expect(body.data.report.scores).toHaveLength(2);expect(body.data.report.references.length).toBeGreaterThan(0);expect(body.data.report.decisionReferences).toHaveLength(1);
  });
  it('keeps numeric scores and total null when evidence is missing, not zero or model total',async()=>{
    const f=await fixture(),r=await review(f);provider(report(f,false));await runReviewJob(env,r.jobId);
    const row=(await env.DB.prepare('SELECT report_json FROM reviews WHERE id=?1').bind(r.id).first<{report_json:string}>())!,result=JSON.parse(row.report_json);
    expect(result.status).toBe('unscorable');expect(result.overall.score).toBeNull();expect(result.scores.every((score:{score:unknown})=>score.score===null)).toBe(true);expect(result.limitations).toHaveLength(2);
  });
  it('rejects invented fixed-material quotes',async()=>{
    const f=await fixture(),r=await review(f),output=report(f);output.scores[0]!.evidence[0]!.quote='并不存在的资料';provider(output);await runReviewJob(env,r.jobId);
    expect((await getJob(env,r.jobId)).status).toBe('failed');expect((await env.DB.prepare('SELECT report_json FROM reviews WHERE id=?1').bind(r.id).first<{report_json:string|null}>())!.report_json).toBeNull();
  });
  it('rejects explicit untracked rubric choices and queued reviews without a tracked project standard',async()=>{
    const f=await fixture(),otherRubric=newId();
    await env.DB.prepare("INSERT INTO rubric_versions(id,project_id,version,source,weights_json,status,created_at) VALUES(?1,?2,2,'custom',?3,'draft',?4)").bind(otherRubric,f.projectId,JSON.stringify(f.weights),nowIso()).run();
    const response=await request(f,'reviews','POST',{rubricVersionId:otherRubric,requirementSetId:f.setId,materialVersionIds:[f.materialVersionId]});expect(response.status).toBe(409);await response.text();
    const r=await review(f);
    await env.DB.prepare("UPDATE jobs SET input_json=json_remove(input_json,'$.standardsVersionId') WHERE id=?1").bind(r.jobId).run();
    const fetch=provider(report(f));await runReviewJob(env,r.jobId);
    expect(fetch).not.toHaveBeenCalled();expect((await getJob(env,r.jobId)).status).toBe('failed');
    expect((await env.DB.prepare('SELECT report_json FROM reviews WHERE id=?1').bind(r.id).first<{report_json:string|null}>())!.report_json).toBeNull();
    expect((await request(f,`reviews/${r.id}`)).status).toBe(200);
  });
  it('passes the selected member and actual responsibility tasks and retains legacy summary evidence in GET turns',async()=>{
    const f=await fixture(),taskId=newId(),otherTaskId=newId(),now=nowIso();
    for(const [id,assignee,title]of[[taskId,f.member.userId,'目标成员负责的采样'],[otherTaskId,f.owner.userId,'其他成员负责的排版']])await env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,criteria,status,revision,assignee_id,created_by,created_at,updated_at,lifecycle_state) VALUES(?1,?2,?3,'实际任务说明','记录来源','doing',1,?4,?5,?6,?6,'in_progress')").bind(id,f.projectId,title,assignee,f.owner.userId,now).run();
    const rehearsalId=newId();await env.DB.prepare("INSERT INTO rehearsals(id,project_id,scope,member_id,material_version_ids_json,status,created_by,created_at) VALUES(?1,?2,'member',?3,'[]','active',?4,?5)").bind(rehearsalId,f.projectId,f.member.userId,f.owner.userId,now).run();
    const jobId=await job(f,'rehearsal_turn',{rehearsalId,projectId:f.projectId,phase:'summary',standardsVersionId:f.standardId});await env.DB.prepare('UPDATE rehearsals SET processing_job_id=?2 WHERE id=?1').bind(rehearsalId,jobId).run();
    provider({summary:'对实际任务和回答的总结',strengths:[],improvements:[],referenceIds:[],decisionReferences:[{decisionPath:'summary',referenceIds:[`project:${f.projectId}:0`]}]},body=>{
      const user=body.messages[1]!.content;expect(user).toContain(f.member.userId);expect(user).toContain(taskId);expect(user).not.toContain(otherTaskId);expect(body.messages[0]!.content).toContain('个人');
    });
    await runRehearsalTurnJob(env,jobId);expect((await getJob(env,jobId)).status).toBe('succeeded');
    const response=await request(f,`rehearsals/${rehearsalId}`),body=await response.json() as {data:{turns:Array<{content:string;references:unknown[];decisionReferences:unknown[]}>}};
    expect(body.data.turns[0]!.content).toBe('对实际任务和回答的总结');expect(body.data.turns[0]!.references.length).toBeGreaterThan(0);expect(body.data.turns[0]!.decisionReferences).toHaveLength(1);
  });
  it('does not publish or fail a replacement review when the old attempt loses ownership before its write',async()=>{
    const f=await fixture(),r=await review(f),replacement=await job(f,'review_run',{projectId:f.projectId,reviewId:r.id});
    await env.DB.prepare('UPDATE reviews SET job_id=?2 WHERE id=?1').bind(r.id,r.jobId).run();
    provider(report(f));
    let switched=false;
    const selected=new WeakSet<object>();
    const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>{const proxy=new Proxy(statement,{get(target,key){if(key==='bind')return (...args:unknown[])=>wrap(target.bind(...args));const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});selected.add(proxy);return proxy;};
    const db=new Proxy(env.DB,{get(target,key){
      if(key==='prepare')return (sql:string)=>sql.includes("UPDATE reviews SET status='succeeded'")?wrap(target.prepare(sql)):target.prepare(sql);
      if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!switched&&statements.some(statement=>selected.has(statement))){switched=true;await env.DB.batch([env.DB.prepare("UPDATE jobs SET status='failed' WHERE id=?1").bind(r.jobId),env.DB.prepare('UPDATE reviews SET job_id=?2 WHERE id=?1').bind(r.id,replacement)]);}return target.batch(statements);};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    await runReviewJob({...env,DB:db},r.jobId);
    expect(switched).toBe(true);
    expect(await env.DB.prepare('SELECT status,job_id,report_json FROM reviews WHERE id=?1').bind(r.id).first()).toEqual({status:'pending',job_id:replacement,report_json:null});
  });
  it('an old rehearsal failure cannot mark the replacement assessment failed',async()=>{
    const f=await fixture(),rehearsalId=newId(),now=nowIso();
    const old=await job(f,'rehearsal_turn',{rehearsalId,projectId:f.projectId,phase:'summary'}),replacement=await job(f,'rehearsal_turn',{rehearsalId,projectId:f.projectId,phase:'summary'}),assessmentId=newId();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO rehearsals(id,project_id,scope,material_version_ids_json,status,created_by,created_at,processing_job_id,finish_job_id) VALUES(?1,?2,'all','[]','active',?3,?4,?5,?5)").bind(rehearsalId,f.projectId,f.owner.userId,now,replacement),
      env.DB.prepare("INSERT INTO assessments(id,project_id,kind,entity_id,goal_revision,standards_version_id,inputs_json,status,job_id,created_by,created_at) VALUES(?1,?2,'rehearsal',?3,1,?4,'{}','active',?5,?6,?7)").bind(assessmentId,f.projectId,rehearsalId,f.standardId,replacement,f.owner.userId,now)
    ]);
    const fetch=provider({});await runRehearsalTurnJob(env,old);expect(fetch).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status,job_id FROM assessments WHERE id=?1').bind(assessmentId).first()).toEqual({status:'active',job_id:replacement});
  });

});
