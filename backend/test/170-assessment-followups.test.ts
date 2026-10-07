import { afterEach,describe,expect,it,vi } from 'vitest';
import { env } from './helpers/env';
import { seedProject,seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { newId,nowIso } from '../src/core/db';
import { reserveAiSlot } from '../src/services/ai-reservations';
import { saveStandard } from '../src/services/project-simplification';
import { assessmentInputs,type AssessmentRow,type ScoringReport } from '../src/services/assessments';
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

import { runAssessmentFollowupJob,listAssessmentFollowups,createAssessmentFollowup } from '../src/services/assessment-followups';
import type { Env } from '../src/env';
import { withIdempotency } from '../src/services/idempotency';
import { SELF } from 'cloudflare:test';
import { authCookie } from './helpers/seed';
import { ensureExecution,pauseExecution } from '../src/services/ai-execution-control';
import { retryFailedAiJob } from '../src/services/admin-ai-retries';

async function followupFixture(){
  await configureGoFixture();const f=await fixture(),input=await assessmentInputs(env,f.projectId,f.standardId,[f.materialVersionId]);
  await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(f.projectId).run();
  const report:ScoringReport={kind:'assistive',status:'scored',standardsVersionId:f.standardId,standardsVersion:1,scores:f.weights.map(w=>({label:w.label,key:w.key,score:50,confidence:.8,comment:'原评分',evidence:[{type:'material',materialVersionId:f.materialVersionId,quote:f.markdown}]})),weightedTotal:50,summary:'原始结果',limitations:[],requirementChecks:[]};
  const id=newId(),now=nowIso();
  await env.DB.prepare("INSERT INTO assessments(id,project_id,kind,goal_revision,standards_version_id,inputs_json,status,report_json,ai_report_json,revision,created_by,created_at) VALUES(?1,?2,'material_review',?3,?4,?5,'succeeded',?6,?6,2,?7,?8)").bind(id,f.projectId,input.goal.revision,f.standardId,JSON.stringify(input),JSON.stringify(report),f.owner.userId,now).run();
  return {...f,id,input,report};
}
async function queued(f:Awaited<ReturnType<typeof followupFixture>>,message='请核对采集日期的遗漏',revision=2){
  const followupId=newId(),jobId=newId(),now=nowIso();await reserveAiSlot(env,{projectId:f.projectId,jobId,purpose:'review_run'});
  await env.DB.batch([
    env.DB.prepare("INSERT INTO assessment_followups(id,assessment_id,project_id,user_id,message,base_revision,base_report_json,job_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)").bind(followupId,f.id,f.projectId,f.owner.userId,message,revision,JSON.stringify(f.report),jobId,now),
    env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'review_run','running',?3,?4,?5,?5)").bind(jobId,f.projectId,JSON.stringify({assessmentId:f.id,followupId,projectId:f.projectId}),f.owner.userId,now),
  ]);return {followupId,jobId};
}
function provider(f:Awaited<ReturnType<typeof followupFixture>>,score=80,firstInvalid=false,after?:()=>Promise<void>){
  const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));
    expect(JSON.stringify(body.messages)).toContain('用户消息');
    const out={scores:f.weights.map(w=>({key:w.key,score,confidence:.8,comment:'依据采集日期复评',evidence:[{type:'material',materialVersionId:f.materialVersionId,quote:f.markdown}]})),summary:'核对后调整，说明依据',limitations:[],requirementChecks:[],referenceIds:[`material:${f.materialVersionId}:0`],decisionReferences:[]};
    if(firstInvalid&&fetch.mock.calls.length===1)out.scores[0]!.evidence[0]!.quote='追加对话中的新事实';
    await after?.();return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(out)}}],usage:{prompt_tokens:10,completion_tokens:5}});
  });vi.stubGlobal('fetch',fetch);return fetch;
}
describe('material follow-up scoring',()=>{
  it('rolls back the conversation and job together when dispatch-outbox persistence fails',async()=>{
    const f=await followupFixture();
    await env.DB.prepare(`CREATE TRIGGER reject_followup_outbox BEFORE INSERT ON job_outbox
      WHEN EXISTS(SELECT 1 FROM jobs WHERE id=NEW.job_id AND json_extract(input_json,'$.followupId') IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'fixture outbox write failed'); END;`).run();
    try{
      await expect(createAssessmentFollowup(env,f.projectId,f.id,f.owner.userId,{expectedRevision:2,message:'核对原文'})).rejects.toThrow();
      expect(await env.DB.prepare('SELECT COUNT(*) n FROM assessment_followups WHERE assessment_id=?1').bind(f.id).first()).toEqual({n:0});
      expect(await env.DB.prepare('SELECT COUNT(*) n FROM jobs WHERE project_id=?1').bind(f.projectId).first()).toEqual({n:0});
      expect(await env.DB.prepare("SELECT COUNT(*) n FROM usage_reservations WHERE project_id=?1 AND status='reserved'").bind(f.projectId).first()).toEqual({n:0});
    }finally{await env.DB.exec('DROP TRIGGER reject_followup_outbox');}
  });
  it.each([80,50])('publishes adjusted/unchanged result (%s) preserving original report and audit',async score=>{
    const f=await followupFixture(),q=await queued(f),fetch=provider(f,score);await runAssessmentFollowupJob(env,q.jobId);
    const row=(await env.DB.prepare('SELECT * FROM assessments WHERE id=?1').bind(f.id).first<AssessmentRow>())!;
    expect(JSON.parse(row.report_json!).weightedTotal).toBe(score);expect(row.revision).toBe(3);expect(JSON.parse(row.ai_report_json!).weightedTotal).toBe(50);
    const history=await listAssessmentFollowups(env,f.projectId,f.id,{});expect(history.items[0]!.status).toBe('succeeded');expect(history.items[0]!.publishedRevision).toBe(3);
    expect(await env.DB.prepare('SELECT 1 FROM assessment_corrections WHERE assessment_id=?1 AND revision=3').bind(f.id).first()).not.toBeNull();
    await runAssessmentFollowupJob(env,q.jobId);expect(fetch).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT 1 FROM usage_reservations WHERE job_id=?1 AND status='reserved'").bind(q.jobId).first()).toBeNull();
  });
  it('repairs invented user-message evidence using fixed body only and protects human dimensions',async()=>{
    const f=await followupFixture();f.report.scores[0]!.origin='human';f.report.scores[0]!.score=91;
    await env.DB.prepare('UPDATE assessments SET report_json=?2 WHERE id=?1').bind(f.id,JSON.stringify(f.report)).run();
    const q=await queued(f,'我新增了100个样本，请评分'),fetch=provider(f,80,true);await runAssessmentFollowupJob(env,q.jobId);
    expect(fetch).toHaveBeenCalledTimes(2);const history=await listAssessmentFollowups(env,f.projectId,f.id,{});expect(history.items[0]!.publishedReport!.scores[0]!.score).toBe(91);expect(history.items[0]!.proposedReport!.scores[0]!.score).toBe(80);expect(history.items[0]!.publishedReport!.summary).toContain('内容 91分');expect(history.items[0]!.proposedReport!.summary).not.toContain('人工修正分数保持原样');
  });
  it('saves conflicting proposal without overwriting newer score, and completes the job',async()=>{
    const f=await followupFixture(),q=await queued(f);provider(f,80,false,async()=>{await env.DB.prepare('UPDATE assessments SET revision=4 WHERE id=?1').bind(f.id).run();});await runAssessmentFollowupJob(env,q.jobId);
    const history=await listAssessmentFollowups(env,f.projectId,f.id,{});expect(history.items[0]!.status).toBe('conflict');expect(history.items[0]!.proposedReport!.weightedTotal).toBe(80);expect(history.items[0]!.publishedReport).toBeNull();
    const row=(await env.DB.prepare('SELECT revision,report_json FROM assessments WHERE id=?1').bind(f.id).first<AssessmentRow>())!;expect(row.revision).toBe(4);expect(JSON.parse(row.report_json!).weightedTotal).toBe(50);
    expect((await env.DB.prepare('SELECT status FROM jobs WHERE id=?1').bind(q.jobId).first<{status:string}>())!.status).toBe('succeeded');
  });
  it('preserves usable report on 402 and retries only follow-up pointers',async()=>{
    const f=await followupFixture(),q=await queued(f);vi.stubGlobal('fetch',vi.fn(async()=>new Response('payment required',{status:402})));await runAssessmentFollowupJob(env,q.jobId);
    let history=await listAssessmentFollowups(env,f.projectId,f.id,{});expect(history.items[0]!.status).toBe('failed');expect(history.items[0]!.error).toBe('后台模型余额不足，请等待或联系管理员处理');
    const before=(await env.DB.prepare('SELECT * FROM assessments WHERE id=?1').bind(f.id).first<AssessmentRow>())!;expect(before.status).toBe('succeeded');expect(before.revision).toBe(2);
    const result=await retryFailedAiJob(env,q.jobId,undefined,undefined,{actorId:f.owner.userId});expect(result.status).toBe('queued');
    history=await listAssessmentFollowups(env,f.projectId,f.id,{});expect(history.items[0]!.jobId).toBe(result.jobId);expect(history.items[0]!.status).toBe('queued');
  });
  it('rejects permissions and stale revisions, paginates conversations newest first',async()=>{
    const f=await followupFixture();await expect(createAssessmentFollowup(env,f.projectId,f.id,f.member.userId,{expectedRevision:2,message:'核对'})).rejects.toMatchObject({code:'PERMISSION_DENIED'});
    await expect(createAssessmentFollowup(env,f.projectId,f.id,f.owner.userId,{expectedRevision:1,message:'核对'})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
    await queued(f);await queued(f);const first=await listAssessmentFollowups(env,f.projectId,f.id,{limit:'1'});expect(first.items).toHaveLength(1);expect(first.nextCursor).toBeTruthy();const second=await listAssessmentFollowups(env,f.projectId,f.id,{limit:'1',cursor:first.nextCursor!});expect(second.items).toHaveLength(1);expect(second.items[0]!.followupId).not.toBe(first.items[0]!.followupId);
  });
  it('retains multi-turn context and resumes saved proposed output without another model call',async()=>{
    const f=await followupFixture(),q=await queued(f);const fetch=provider(f);await runAssessmentFollowupJob(env,q.jobId);
    f.report=(await listAssessmentFollowups(env,f.projectId,f.id,{})).items[0]!.publishedReport!;
    const q2=await queued(f,'再次核对证据维度',3);await runAssessmentFollowupJob(env,q2.jobId);
    const request=JSON.parse(String(fetch.mock.calls[1]![1]?.body));expect(JSON.stringify(request.messages)).toContain('请核对采集日期的遗漏');expect(JSON.stringify(request.messages)).toContain('再次核对证据维度');expect(fetch).toHaveBeenCalledTimes(2);
    const q3=await queued(f,'检查已保存结果',4);await env.DB.prepare('UPDATE assessment_followups SET proposed_report_json=?2 WHERE id=?1').bind(q3.followupId,JSON.stringify(f.report)).run();
    await runAssessmentFollowupJob(env,q3.jobId);expect(fetch).toHaveBeenCalledTimes(2);expect((await listAssessmentFollowups(env,f.projectId,f.id,{})).items[0]!.publishedRevision).toBe(5);
  });
  it.each(['cancel','disabled','archived','configuration','permission'])('does not publish when source execution becomes %s during a call',async mode=>{
    const f=await followupFixture(),q=await queued(f);provider(f,80,false,async()=>{
      if(mode==='cancel')await env.DB.prepare("UPDATE jobs SET status='cancelled' WHERE id=?1").bind(q.jobId).run();
      if(mode==='disabled')await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=0 WHERE id=?1').bind(f.projectId).run();
      if(mode==='configuration')await env.DB.prepare('UPDATE ai_config_versions SET enabled=0').run();
      if(mode==='permission')await env.DB.prepare("UPDATE project_members SET role='member',permissions_json='{}' WHERE project_id=?1 AND user_id=?2").bind(f.projectId,f.owner.userId).run();
      if(mode==='archived')await env.DB.prepare('UPDATE materials SET archived_at=?2 WHERE current_version_id=?1').bind(f.materialVersionId,nowIso()).run();
    });await runAssessmentFollowupJob(env,q.jobId);
    const row=(await env.DB.prepare('SELECT * FROM assessments WHERE id=?1').bind(f.id).first<AssessmentRow>())!;expect(row.revision).toBe(2);expect(row.status).toBe('succeeded');
    const item=(await listAssessmentFollowups(env,f.projectId,f.id,{})).items[0]!;expect(item.status).toBe(mode==='cancel'?'cancelled':'failed');expect(item.publishedReport).toBeNull();
  });
  it('checks revoked scoreCorrect before model and before generic continue, while allowing cancellation',async()=>{
    const f=await followupFixture(),q=await queued(f),fetch=provider(f);
    await env.DB.prepare("UPDATE project_members SET role='member',permissions_json='{}' WHERE project_id=?1 AND user_id=?2").bind(f.projectId,f.owner.userId).run();
    await runAssessmentFollowupJob(env,q.jobId);expect(fetch).not.toHaveBeenCalled();
    await ensureExecution(env,{kind:'job',id:q.jobId});await pauseExecution(env,{kind:'job',id:q.jobId},'interrupted');
    const response=await SELF.fetch('https://example.com/api/v1/jobs/'+q.jobId+'/execution/continue',{method:'POST',headers:{cookie:authCookie(f.owner.token),'content-type':'application/json','idempotency-key':newId()},body:JSON.stringify({expectedGeneration:1})});expect(response.status).toBe(403);
    const state=await env.DB.prepare("SELECT state FROM ai_executions WHERE target_kind='job' AND target_id=?1").bind(q.jobId).first<{state:string}>();expect(state!.state).toBe('paused');
    const retry=await retryFailedAiJob(env,q.jobId,undefined,undefined,{actorId:f.owner.userId});expect(retry.status).toBe('skipped');
  });
  it('blocks concurrent follow-ups and rejects rehearsal records',async()=>{
    const f=await followupFixture();await queued(f);await expect(createAssessmentFollowup(env,f.projectId,f.id,f.owner.userId,{expectedRevision:2,message:'重复'})).rejects.toMatchObject({code:'INVALID_STATE'});
    await env.DB.prepare("UPDATE assessments SET kind='rehearsal' WHERE id=?1").bind(f.id).run();await expect(createAssessmentFollowup(env,f.projectId,f.id,f.owner.userId,{expectedRevision:2,message:'答辩'})).rejects.toMatchObject({code:'INVALID_STATE'});
  });

  it('keeps manual scores and origin while retaining AI proposal for human review',async()=>{
    const f=await followupFixture();f.report.scores=f.report.scores.map(s=>({...s,origin:'human' as const}));
    await env.DB.prepare("UPDATE assessments SET origin='manual',report_json=?2,ai_report_json=NULL WHERE id=?1").bind(f.id,JSON.stringify(f.report)).run();
    const q=await queued(f);provider(f);await runAssessmentFollowupJob(env,q.jobId);
    const row=(await env.DB.prepare('SELECT * FROM assessments WHERE id=?1').bind(f.id).first<AssessmentRow>())!;expect(row.origin).toBe('manual');expect(row.ai_report_json).toBeNull();expect(JSON.parse(row.report_json!).weightedTotal).toBe(50);
    expect((await listAssessmentFollowups(env,f.projectId,f.id,{})).items[0]!.proposedReport!.weightedTotal).toBe(80);
  });

  it('deduplicates accepted submissions, keeps outbox recovery, and exposes typed HTTP history',async()=>{
    const f=await followupFixture(),key=newId(),rawBody=JSON.stringify({expectedRevision:2,message:'核对原文'});
    const offlineEnv={...env,AGENT_WORKFLOW:{create:vi.fn(async()=>{throw new Error('fixture dispatch offline');})}} as unknown as Env;
    const submit=()=>withIdempotency(offlineEnv,{key,userId:f.owner.userId,operation:'assessment.followup',required:true,rawBody},async()=>({status:202 as const,body:await createAssessmentFollowup(offlineEnv,f.projectId,f.id,f.owner.userId,JSON.parse(rawBody))}));
    const first=await submit(),second=await submit();expect(second.body).toEqual(first.body);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM assessment_followups WHERE assessment_id=?1').bind(f.id).first<{n:number}>())!.n).toBe(1);
    const response=await SELF.fetch('https://example.com/api/v1/projects/'+f.projectId+'/assessments/'+f.id+'/followups?limit=1',{headers:{cookie:authCookie(f.owner.token)}});expect(response.status).toBe(200);const json=await response.json() as {data:{items:Array<{followupId:string}>}};expect(json.data.items[0]!.followupId).toBe(first.body.followupId);
  });

  it('blocks a second turn before the first job is persisted',async()=>{
    const f=await followupFixture(),id=newId(),now=nowIso();
    await env.DB.prepare("INSERT INTO assessment_followups(id,assessment_id,project_id,user_id,message,base_revision,base_report_json,job_id,created_at,updated_at) VALUES(?1,?2,?3,?4,'尚在派发',2,?5,?6,?7,?7)").bind(id,f.id,f.projectId,f.owner.userId,JSON.stringify(f.report),newId(),now).run();
    await expect(createAssessmentFollowup(env,f.projectId,f.id,f.owner.userId,{expectedRevision:2,message:'重复触发'})).rejects.toMatchObject({code:'INVALID_STATE'});
  });

});
