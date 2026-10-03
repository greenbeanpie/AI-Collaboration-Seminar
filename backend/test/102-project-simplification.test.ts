import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { assessmentSchema, registerProjectSimplificationRoutes } from '../src/api/project-simplification';
import { env, BASE } from './helpers/env';
import { seedProject, seedUser, authCookie } from './helpers/seed';
import { configureGoFixture, assertGoRequest } from './helpers/provider-config';
import { newId, nowIso } from '../src/core/db';
import type { Env } from '../src/env';
import { projectGoal, replaceTaskDependencies, taskDependencies, saveStandard, confirmStandard, confirmedStandard } from '../src/services/project-simplification';
import { createManualAssessment } from '../src/services/assessment-corrections';
import { runMaterialAssessmentJob } from '../src/services/assessments';
import { runRehearsalTurnJob } from '../src/services/rehearsal';
import { runCollaborationAiJob } from '../src/services/collaboration-ai';
import { getJob } from '../src/services/jobs';
import { InvestigationContinuation } from '../src/services/project-investigation';

await configureGoFixture();
afterEach(()=>vi.unstubAllGlobals());
const offline={...env,AGENT_WORKFLOW:{create:async()=>{throw new Error('fixture has no workflow engine');}}} as unknown as Env;
async function fixture(){const user=await seedUser(),projectId=await seedProject(user.userId),app=createApp();registerProjectSimplificationRoutes(app);const request=(path:string,body?:unknown,method=body?'POST':'GET',token=user.token)=>app.fetch(new Request(`${BASE}/api/v1/projects/${projectId}${path}`,{method,headers:{cookie:authCookie(token),'content-type':'application/json','idempotency-key':newId()},...(body?{body:JSON.stringify(body)}:{})}),offline);return {user,projectId,request};}
async function json(response:Response){return (await response.json() as {data:any}).data;}
async function task(f:Awaited<ReturnType<typeof fixture>>,title:string,legacy=false,status='todo'){const id=newId(),now=nowIso();await env.DB.prepare('INSERT INTO tasks(id,project_id,title,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria) VALUES(?1,?2,?3,?4,7,?5,?6,?6,?7,?8)').bind(id,f.projectId,title,status,f.user.userId,now,legacy?null:'open',legacy?'':'交付有依据的成果').run();return id;}
async function standard(f:Awaited<ReturnType<typeof fixture>>,weights=[{key:'quality',label:'质量',weight:3},{key:'coverage',label:'覆盖',weight:1}]){const draft=await saveStandard(env,f.projectId,f.user.userId,{title:'项目要求与评分',requirements:[{title:'包含可复核案例',detail:'案例有明确结果',category:'deliverable'}],weights});return confirmStandard(env,f.projectId,f.user.userId,draft.standardsVersionId,draft.revision);}
async function material(f:Awaited<ReturnType<typeof fixture>>,markdown='案例有明确结果。'){const materialId=newId(),versionId=newId(),now=nowIso();await env.DB.batch([env.DB.prepare('INSERT INTO materials(id,project_id,title,created_by,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)').bind(materialId,f.projectId,'成果',f.user.userId,now),env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES(?1,?2,?3,1,?4,?5,'manual',?6,?7)").bind(versionId,materialId,f.projectId,JSON.stringify({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:markdown}]}]}),markdown,f.user.userId,now)]);return versionId;}
function model(output:unknown,inspect?:(body:any)=>void){return vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{assertGoRequest(url,init);inspect?.(JSON.parse(String(init?.body)));return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}],usage:{prompt_tokens:10,completion_tokens:20}}),{headers:{'content-type':'application/json'}});});}

describe('one goal and informative subtask dependencies',()=>{
  it('rejects independent scoring creation and lets owners correct existing historical manual records with AI disabled',async()=>{
    const f=await fixture(),s=await standard(f);
    await env.DB.prepare('UPDATE ai_config_versions SET enabled=0').run();
    const createdResponse=await f.request('/assessments/manual',{standardsVersionId:s.standardsVersionId,scores:[{key:'quality',score:80},{key:'coverage',score:40}],reason:'人工核对'});
    expect(createdResponse.status).toBe(404);
    const created=await createManualAssessment(env,f.projectId,f.user.userId,{standardsVersionId:s.standardsVersionId,scores:[{key:'quality',score:80},{key:'coverage',score:40}],reason:'历史人工核对'});
    expect(created).toMatchObject({origin:'manual',revision:1,report:{weightedTotal:70}});
    expect(created.report!.scores.every((score:any)=>score.confidence===null&&score.origin==='human')).toBe(true);
    const correction=await f.request(`/assessments/${created.assessmentId}/scores`,{expectedRevision:1,scores:[{key:'coverage',score:80}],reason:'补充核查覆盖情况'},'PATCH');
    expect(correction.status).toBe(200);
    expect(await json(correction)).toMatchObject({origin:'manual',revision:2,report:{weightedTotal:80}});
    expect((await f.request(`/assessments/${created.assessmentId}/scores`,{expectedRevision:1,scores:[{key:'quality',score:0}],reason:'旧版本'},'PATCH')).status).toBe(409);
    const outsider=await seedUser();
    expect((await f.request(`/assessments/${created.assessmentId}/scores`,{expectedRevision:2,scores:[{key:'quality',score:0}],reason:'无权限'},'PATCH',outsider.token)).status).toBe(403);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM assessment_corrections WHERE assessment_id=?1').bind(created.assessmentId).first<{n:number}>())!.n).toBe(2);
    const member=await seedUser();
    await env.DB.prepare("INSERT INTO project_members(id,project_id,user_id,role,joined_at) VALUES(?1,?2,?3,'member',?4)").bind(newId(),f.projectId,member.userId,nowIso()).run();
    const correctionBody={expectedRevision:2,scores:[{key:'quality',score:90}],reason:'授权复评'};
    expect((await f.request(`/assessments/${created.assessmentId}/scores`,correctionBody,'PATCH',member.token)).status).toBe(403);
    await env.DB.prepare('UPDATE project_members SET permissions_json=?3 WHERE project_id=?1 AND user_id=?2').bind(f.projectId,member.userId,JSON.stringify({scoreCorrect:true})).run();
    expect((await f.request(`/assessments/${created.assessmentId}/scores`,correctionBody,'PATCH',member.token)).status).toBe(200);
    await env.DB.prepare('UPDATE project_members SET permissions_json=?3 WHERE project_id=?1 AND user_id=?2').bind(f.projectId,member.userId,JSON.stringify({scoreCorrect:false})).run();
    expect((await f.request(`/assessments/${created.assessmentId}/scores`,{...correctionBody,expectedRevision:3},'PATCH',member.token)).status).toBe(403);
    await configureGoFixture();
  });
  it('normalizes legacy display without modifying IDs, status, revisions or inventing submissions',async()=>{const f=await fixture(),id=await task(f,'历史完成',true,'done');const goal=await json(await f.request('/goal'));expect(goal.title).toBe('测试项目');const list=await json(await f.request('/tasks'));expect(list.items[0]).toMatchObject({taskId:id,status:'done',lifecycleState:'accepted',revision:7,unfinishedDependencyIds:[]});expect(await env.DB.prepare('SELECT lifecycle_state,status,revision FROM tasks WHERE id=?1').bind(id).first()).toEqual({lifecycle_state:null,status:'done',revision:7});expect((await env.DB.prepare('SELECT COUNT(*) n FROM task_submissions').first<{n:number}>())!.n).toBe(0);});
  it('creates criterion-less old-client requests in the canonical lifecycle and prevents completion bypass',async()=>{const f=await fixture(),created=await json(await f.request('/tasks',{title:'待补验收标准'}));expect(created).toMatchObject({lifecycleState:'open',criteria:''});expect((await f.request(`/tasks/${created.taskId}`,{expectedRevision:created.revision,status:'done'},'PATCH')).status).toBe(409);const assigned=await json(await f.request('/tasks',{title:'已分工待补标准',assigneeId:f.user.userId}));expect(assigned).toMatchObject({lifecycleState:'in_progress',status:'doing'});expect((await f.request(`/tasks/${assigned.taskId}/submissions`,{expectedRevision:assigned.revision,body:'成果'})).status).toBe(400);expect((await env.DB.prepare('SELECT COUNT(*) n FROM tasks WHERE project_id=?1 AND lifecycle_state IS NULL').bind(f.projectId).first<{n:number}>())!.n).toBe(0);});
  it('rejects cycles, self/cross-project edges and stale graph revisions with no partial writes',async()=>{const f=await fixture(),a=await task(f,'A'),b=await task(f,'B'),goal=await projectGoal(env,f.projectId);const saved=await replaceTaskDependencies(env,f.projectId,f.user.userId,b,goal.graphRevision,[a]);expect(saved.unfinishedDependencyIds).toEqual([a]);await expect(replaceTaskDependencies(env,f.projectId,f.user.userId,a,saved.graphRevision,[b])).rejects.toThrow('循环');await expect(replaceTaskDependencies(env,f.projectId,f.user.userId,a,saved.graphRevision,[a])).rejects.toThrow('其他');await expect(replaceTaskDependencies(env,f.projectId,f.user.userId,a,saved.graphRevision,[newId()])).rejects.toThrow('其他');await expect(replaceTaskDependencies(env,f.projectId,f.user.userId,a,goal.graphRevision,[])).rejects.toMatchObject({code:'VERSION_CONFLICT'});expect(await taskDependencies(env,f.projectId,a)).toEqual({dependsOnTaskIds:[],unfinishedDependencyIds:[]});});
  it('concurrent opposing edges have one winner and no cycle',async()=>{const f=await fixture(),a=await task(f,'A'),b=await task(f,'B'),goal=await projectGoal(env,f.projectId);const results=await Promise.allSettled([replaceTaskDependencies(env,f.projectId,f.user.userId,a,goal.graphRevision,[b]),replaceTaskDependencies(env,f.projectId,f.user.userId,b,goal.graphRevision,[a])]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await env.DB.prepare('SELECT COUNT(*) n FROM task_dependencies WHERE project_id=?1').bind(f.projectId).first<{n:number}>())!.n).toBe(1);});
  it('creates edges atomically and allows submission while predecessors are unfinished',async()=>{const f=await fixture(),a=await task(f,'前置任务'),goal=await projectGoal(env,f.projectId);const response=await f.request('/tasks',{title:'提前推进',criteria:'交付有依据的成果',dependsOnTaskIds:[a],expectedGraphRevision:goal.graphRevision});expect(response.status).toBe(201);const child=await json(response);expect(child.dependsOnTaskIds).toEqual([a]);const claim=await json(await f.request(`/tasks/${child.taskId}/claim`,{expectedRevision:child.revision}));const submitted=await f.request(`/tasks/${child.taskId}/submissions`,{expectedRevision:claim.revision,body:'已提前完成'});expect(submitted.status).toBe(201);expect((await json(await f.request('/tasks'))).items.find((t:any)=>t.taskId===child.taskId).unfinishedDependencyIds).toEqual([a]);});
  it('requires explicit criteria before legacy submission and preserves completed history',async()=>{const f=await fixture(),id=await task(f,'旧待办',true);await env.DB.prepare('UPDATE tasks SET assignee_id=?2 WHERE id=?1').bind(id,f.user.userId).run();expect((await f.request(`/tasks/${id}/submissions`,{expectedRevision:7,body:'成果'})).status).toBe(400);const edited=await json(await f.request(`/tasks/${id}`,{expectedRevision:7,criteria:'能够复核'},'PATCH'));expect((await f.request(`/tasks/${id}/submissions`,{expectedRevision:edited.revision,body:'成果'})).status).toBe(201);});
  it('keeps AI goal and graph pending even in automatic mode, then applies keyed edges once using full background',async()=>{
    const f=await fixture(),versionId=await material(f,'完整项目背景：需要先调研，再撰写报告。');
    await env.DB.prepare("UPDATE projects SET ai_collaboration_enabled=1,assignment_mode='automatic' WHERE id=?1").bind(f.projectId).run();
    const goal=await projectGoal(env,f.projectId),created=await json(await f.request('/collaboration/decompose',{brief:'完成可复核的研究报告',materialVersionIds:[versionId]}));
    vi.stubGlobal('fetch',model({goal:{title:'完成研究报告',detail:'有依据的报告'},tasks:[{key:'research',dependsOn:[],title:'调研',detail:'整理证据',criteria:'证据可追溯',effortHours:2},{key:'report',dependsOn:['research'],title:'报告',detail:'根据证据撰写',criteria:'有明确结论',effortHours:3}]},body=>expect(JSON.stringify(body)).toContain('完整项目背景')));
    await runCollaborationAiJob(offline,created.jobId);
    const result=JSON.parse((await getJob(env,created.jobId)).result_json!);expect(result.autoApplied).toBe(false);expect((await projectGoal(env,f.projectId)).title).toBe(goal.title);
    const applied=await f.request(`/collaboration/proposals/${result.proposalId}/apply`,{expectedRevision:1});expect(applied.status).toBe(200);
    const rows=(await json(await f.request('/tasks'))).items,report=rows.find((r:any)=>r.title==='报告'),research=rows.find((r:any)=>r.title==='调研');expect(report.dependsOnTaskIds).toEqual([research.taskId]);expect(rows).toHaveLength(2);expect((await projectGoal(env,f.projectId)).title).toBe('完成研究报告');
    expect((await f.request(`/collaboration/proposals/${result.proposalId}/apply`,{expectedRevision:1})).status).toBe(409);expect((await json(await f.request('/tasks'))).items).toHaveLength(2);
  });
});
describe('atomic requirements and grading versions',()=>{
  it('adds an approved supplemental task without copying or changing existing work',async()=>{
    const f=await fixture(),existing=await task(f,'已有样本采集');
    await env.DB.prepare('UPDATE projects SET ai_collaboration_enabled=1 WHERE id=?1').bind(f.projectId).run();
    const created=await json(await f.request('/collaboration/decompose',{brief:'沿用采集任务，仅新增数据整理',taskIds:[existing]}));
    vi.stubGlobal('fetch',model({updates:[],tasks:[{title:'数据整理',detail:'仅整理采集后的结果',criteria:'数据可溯源',effortHours:2}]}));
    await runCollaborationAiJob(offline,created.jobId);
    const result=JSON.parse((await getJob(env,created.jobId)).result_json!);
    expect((await f.request(`/collaboration/proposals/${result.proposalId}/apply`,{expectedRevision:1})).status).toBe(200);
    const rows=(await json(await f.request('/tasks'))).items;
    expect(rows).toHaveLength(2);expect(rows.find((r:any)=>r.title==='数据整理').dependsOnTaskIds).toEqual([]);
    expect(rows.find((r:any)=>r.taskId===existing).revision).toBe(7);
  });
  it('publishes selected components together and keeps non-scoring requirements',async()=>{const f=await fixture();const created=await json(await f.request('/standards',{title:'统一要求',requirements:[{title:'交付日期',detail:'周五提交',category:'deadline',dueDate:'2026-10-09',duePrecision:'date'},{title:'成果质量',detail:'证据清晰',dimensionKey:'quality'}],weights:[{key:'quality',label:'质量',weight:100}]}));expect(created.requirements[0].dueDate).toBe('2026-10-09');expect(created.mappings).toHaveLength(1);const confirmed=await json(await f.request(`/standards/${created.standardsVersionId}/confirm`,{expectedRevision:created.revision}));expect(confirmed.status).toBe('confirmed');expect(confirmed.requirements).toHaveLength(2);expect((await env.DB.prepare('SELECT status FROM rubric_versions WHERE id=?1').bind(confirmed.rubricVersionId).first<{status:string}>())!.status).toBe('confirmed');expect((await f.request(`/standards/${created.standardsVersionId}`,{expectedRevision:confirmed.revision,title:'覆盖',requirements:[],weights:[]},'PATCH')).status).toBe(409);expect(await confirmedStandard(env,f.projectId,created.standardsVersionId)).toMatchObject({title:'统一要求'});});
  it('supports a pure checklist without fabricating dimensions or grade',async()=>{const f=await fixture(),published=await standard(f,[]);expect(published.rubric.weights).toEqual([]);expect(published.requirements).toHaveLength(1);});
  it('preserves an explicitly sourced ISO deadline precision without inventing or dropping time',async()=>{const f=await fixture(),date='2026-10-09T23:59:00+08:00';const saved=await json(await f.request('/standards',{requirements:[{title:'正式截止时间',detail:'按通知时间提交',dueDate:date,duePrecision:'datetime'}],weights:[]}));expect(saved.requirements[0]).toMatchObject({dueDate:date,duePrecision:'datetime'});expect((await f.request('/standards',{requirements:[{title:'不一致日期',dueDate:date,duePrecision:'date'}],weights:[]})).status).toBe(400);});
  it('rejects duplicate dimensions and cross-project references before creating components',async()=>{const f=await fixture(),outsider=await seedUser();expect((await f.request('/standards',{requirements:[],weights:[{key:'x',label:'一',weight:50},{key:'x',label:'二',weight:50}]})).status).toBe(400);expect((await f.request('/standards',{requirementSetIds:[],rubricVersionId:newId()})).status).toBe(400);expect((await f.request('/standards',{requirements:[],weights:[]},'POST',outsider.token)).status).toBe(403);expect((await env.DB.prepare('SELECT COUNT(*) n FROM standards_versions WHERE project_id=?1').bind(f.projectId).first<{n:number}>())!.n).toBe(0);});
});
describe('creation preview and atomic goal graph commit',()=>{
  it('commits reviewed goal, keyed dependencies and editable background exactly once',async()=>{
    const user=await seedUser(),app=createApp();
    const request=(path:string,body:unknown)=>app.fetch(new Request(`${BASE}/api/v1/creation-drafts${path}`,{method:'POST',headers:{cookie:authCookie(user.token),'content-type':'application/json','idempotency-key':newId()},body:JSON.stringify(body)}),offline);
    const draft=await json(await request('',{name:'研究项目',description:'原始背景正文',brief:'完成报告',goal:{title:'交付有证据的研究报告',detail:'明确解释研究结论'},teamSize:1,aiCollaborationEnabled:false,inviteLabels:[],inviteUsernames:[]}));
    const preview=await json(await request(`/${draft.id}/preview`,{expectedRevision:1,mode:'manual',tasks:[{key:'collect',dependsOn:[],title:'搜集证据',detail:'原始资料',criteria:'可核对',effortHours:1,citations:[]},{key:'write',dependsOn:['collect'],title:'撰写报告',detail:'形成结论',criteria:'对应证据',effortHours:2,citations:[]}]}));
    expect(preview.preview.goal.title).toBe('交付有证据的研究报告');
    const result=await json(await request(`/${draft.id}/commit`,{expectedRevision:1,confirmed:true}));
    expect((await projectGoal(env,result.projectId)).title).toBe('交付有证据的研究报告');
    const rows=await env.DB.prepare('SELECT id,title FROM tasks WHERE project_id=?1').bind(result.projectId).all<{id:string;title:string}>();expect(rows.results).toHaveLength(2);
    const collect=rows.results.find(t=>t.title==='搜集证据')!,write=rows.results.find(t=>t.title==='撰写报告')!;expect((await taskDependencies(env,result.projectId,write.id)).dependsOnTaskIds).toEqual([collect.id]);
    expect(await env.DB.prepare('SELECT title,purpose,is_default_background FROM materials WHERE project_id=?1').bind(result.projectId).first()).toEqual({title:'项目背景',purpose:'background',is_default_background:1});
    expect((await json(await request(`/${draft.id}/commit`,{expectedRevision:1,confirmed:true}))).projectId).toBe(result.projectId);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM task_dependencies WHERE project_id=?1').bind(result.projectId).first<{n:number}>())!.n).toBe(1);
  });
});
describe('independent goal assessments with complete evidence',()=>{
  it('preserves old rehearsal narratives and review JSON under the historical contract without fabricating current grades',async()=>{
    const f=await fixture(),s=await standard(f),reviewId=newId(),rehearsalId=newId(),now=nowIso();
    const oldReview={overall:{score:72,summary:'当时的模拟预审总结'},scores:[{key:'quality',score:72,comment:'历史评语',suggestions:['原始建议']}],legacyEvidence:{note:'原始字段不能丢弃'}};
    const oldRehearsal={content:'以前只有文字演练总结，未产生分数。',strengths:['回答清晰'],improvements:['补充实例'],originalMetadata:{session:'旧问答'}};
    await env.DB.batch([
      env.DB.prepare("INSERT INTO reviews(id,project_id,requirement_set_id,rubric_version_id,material_version_ids_json,status,report_json,created_by,created_at) VALUES(?1,?2,?3,?4,'[]','succeeded',?5,?6,?7)").bind(reviewId,f.projectId,s.requirementSetIds[0],s.rubricVersionId,JSON.stringify(oldReview),f.user.userId,now),
      env.DB.prepare("INSERT INTO rehearsals(id,project_id,scope,status,created_by,created_at,finished_at) VALUES(?1,?2,'all','finished',?3,?4,?4)").bind(rehearsalId,f.projectId,f.user.userId,now),
      env.DB.prepare("INSERT INTO rehearsal_turns(id,rehearsal_id,project_id,sequence,kind,content_json,created_at) VALUES(?1,?2,?3,1,'summary',?4,?5)").bind(newId(),rehearsalId,f.projectId,JSON.stringify(oldRehearsal),now),
    ]);
    for(const [id,report] of [[reviewId,oldReview],[rehearsalId,oldRehearsal]] as const){
      const dto=await json(await f.request(`/assessments/${id}`)),parsed=assessmentSchema.parse(dto);
      expect(parsed).toMatchObject({assessmentId:id,historical:true,goal:null,goalRevision:null,standardsVersionId:null});
      expect(parsed.report).toEqual(report);expect(assessmentSchema.safeParse({...dto,historical:false}).success).toBe(false);
    }
    const list=await json(await f.request('/assessments'));expect(list.items).toHaveLength(2);expect((await env.DB.prepare('SELECT COUNT(*) n FROM assessments WHERE project_id=?1').bind(f.projectId).first<{n:number}>())!.n).toBe(0);
  });
  it('treats selected background as priority reference and freezes real output versions independently',async()=>{
    const f=await fixture(),s=await standard(f),output=await material(f,'真实成果正文'),background=await material(f,'仅供参考的背景');
    await env.DB.prepare("UPDATE materials SET purpose='output',current_version_id=?2 WHERE id=(SELECT material_id FROM material_versions WHERE id=?1)").bind(output,output).run();
    await env.DB.prepare("UPDATE materials SET purpose='background',current_version_id=?2 WHERE id=(SELECT material_id FROM material_versions WHERE id=?1)").bind(background,background).run();
    const created=await json(await f.request('/assessments',{kind:'material_review',standardsVersionId:s.standardsVersionId,materialVersionIds:[background]}));
    const row=await env.DB.prepare('SELECT inputs_json FROM assessments WHERE id=?1').bind(created.assessmentId).first<{inputs_json:string}>();
    const inputs=JSON.parse(row!.inputs_json);expect(inputs.materialVersionIds).toEqual([output]);expect(inputs.referenceMaterialVersionIds).toEqual([background]);
    await env.DB.prepare('UPDATE materials SET current_version_id=NULL WHERE id=(SELECT material_id FROM material_versions WHERE id=?1)').bind(output).run();
    const saved=await json(await f.request(`/assessments/${created.assessmentId}`));expect(saved.materialVersionIds).toEqual([output]);
  });
  it('computes weighted total on server, freezes goal and standard, sends full body beyond old 8000 limit',async()=>{const f=await fixture(),s=await standard(f),text='正文'.repeat(4500)+'案例有明确结果。',versionId=await material(f,text),goal=await projectGoal(env,f.projectId),created=await json(await f.request('/assessments',{kind:'material_review',standardsVersionId:s.standardsVersionId,materialVersionIds:[versionId],goalRevision:goal.revision}));const evidence=[{type:'material',materialVersionId:versionId,quote:'案例有明确结果。'}];const fetch=model({scores:[{key:'coverage',score:40,confidence:.9,comment:'范围',evidence},{key:'quality',score:80,confidence:.9,comment:'质量',evidence}],summary:'完整检查',limitations:[],requirementChecks:[{requirementId:s.requirements[0]!.requirementId,status:'met',comment:'有案例',evidence}]},body=>expect(JSON.stringify(body)).toContain(text));vi.stubGlobal('fetch',fetch);await f.request('/goal',{expectedRevision:goal.revision,title:'新目标'},'PATCH');await runMaterialAssessmentJob(offline,created.jobId);const result=await json(await f.request(`/assessments/${created.assessmentId}`));expect(result.report.weightedTotal).toBe(70);expect(result.goal.title).toBe(goal.title);expect(result.goalRevision).toBe(goal.revision);expect(result.jobId).toBe(created.jobId);expect(fetch).toHaveBeenCalledOnce();});
  it('rejects forged citations and missing rubric dimensions',async()=>{const f=await fixture(),s=await standard(f),versionId=await material(f),created=await json(await f.request('/assessments',{kind:'material_review',standardsVersionId:s.standardsVersionId,materialVersionIds:[versionId]}));vi.stubGlobal('fetch',model({scores:[{key:'quality',score:80,confidence:.9,comment:'虚构',evidence:[{type:'material',materialVersionId:versionId,quote:'不存在的句子'}]}],summary:'检查',limitations:[],requirementChecks:[]}));await runMaterialAssessmentJob(offline,created.jobId);expect((await getJob(env,created.jobId)).status).toBe('failed');expect((await json(await f.request(`/assessments/${created.assessmentId}`))).report).toBeNull();});
  it('does not turn missing evidence into a zero or average score',async()=>{const f=await fixture(),s=await standard(f),versionId=await material(f),created=await json(await f.request('/assessments',{kind:'material_review',standardsVersionId:s.standardsVersionId,materialVersionIds:[versionId]}));vi.stubGlobal('fetch',model({scores:s.rubric.weights.map(w=>({key:w.key,score:80,confidence:.9,comment:'无证据',evidence:[]})),summary:'需要补证据',limitations:[],requirementChecks:[{requirementId:s.requirements[0]!.requirementId,status:'unknown',comment:'证据不足',evidence:[]}]}));await runMaterialAssessmentJob(offline,created.jobId);const result=await json(await f.request(`/assessments/${created.assessmentId}`));expect(result.report).toMatchObject({status:'unscorable',weightedTotal:null});expect(result.report.scores.every((s:any)=>s.score===null)).toBe(true);});
  it('finishes no-answer rehearsal as unscorable without a provider call and locks late answers',async()=>{const f=await fixture(),s=await standard(f),created=await json(await f.request('/assessments',{kind:'rehearsal',standardsVersionId:s.standardsVersionId,materialVersionIds:[]}));expect((await f.request(`/rehearsals/${created.rehearsalId}/finish`,{})).status).toBe(409);vi.stubGlobal('fetch',model({action:'question',content:'请说明案例结果。'}));await runRehearsalTurnJob(offline,created.jobId);const end=await json(await f.request(`/rehearsals/${created.rehearsalId}/finish`,{}));const fetch=vi.fn();vi.stubGlobal('fetch',fetch);expect((await f.request(`/rehearsals/${created.rehearsalId}/answers`,{content:'晚到回答'})).status).toBe(409);await runRehearsalTurnJob(offline,end.jobId);const result=await json(await f.request(`/assessments/${created.assessmentId}`));expect(result.report).toMatchObject({status:'unscorable',weightedTotal:null});expect(result.report.scores.every((s:any)=>s.score===null)).toBe(true);expect(fetch).not.toHaveBeenCalled();expect(result.jobId).toBe(end.jobId);});
  it('grades rehearsal from frozen actual answers independently of material review',async()=>{const f=await fixture(),s=await standard(f),created=await json(await f.request('/assessments',{kind:'rehearsal',standardsVersionId:s.standardsVersionId,materialVersionIds:[]}));vi.stubGlobal('fetch',model({action:'question',content:'请说明案例结果。'}));await runRehearsalTurnJob(offline,created.jobId);const answer=await json(await f.request(`/rehearsals/${created.rehearsalId}/answers`,{content:'案例有明确结果。'}));expect(answer.turnId).toBeTruthy();expect((await f.request(`/rehearsals/${created.rehearsalId}/finish`,{})).status).toBe(409);await runRehearsalTurnJob(offline,answer.jobId);const end=await json(await f.request(`/rehearsals/${created.rehearsalId}/finish`,{}));const evidence=[{type:'answer',turnSequence:2,quote:'案例有明确结果。'}];vi.stubGlobal('fetch',model({scores:s.rubric.weights.map(w=>({key:w.key,score:90,confidence:.9,comment:'回答有依据',evidence})),summary:'演练评分',limitations:[],requirementChecks:[{requirementId:s.requirements[0]!.requirementId,status:'met',comment:'明确说明',evidence}]}));await runRehearsalTurnJob(offline,end.jobId);const result=await json(await f.request(`/assessments/${created.assessmentId}`));expect(result.report.weightedTotal).toBe(90);expect(result.report.scores[0].evidence[0].turnSequence).toBe(2);expect((await json(await f.request('/assessments'))).items).toHaveLength(1);});
});

describe('material assessment execution continuation',()=>{
  it('keeps the assessment and reservation active during safe continuation and publishes only the final report',async()=>{
    const f=await fixture(),s=await standard(f),versionId=await material(f),created=await json(await f.request('/assessments',{kind:'material_review',standardsVersionId:s.standardsVersionId,materialVersionIds:[versionId]}));
    const evidence=[{type:'material',materialVersionId:versionId,quote:'案例有明确结果。'}];let round=0;
    const fetch=vi.fn(async()=>{const first=round++===0;return Response.json({choices:[{finish_reason:first?'tool_calls':'stop',message:first?{tool_calls:[{id:'read',type:'function',function:{name:'list_project_resources',arguments:'{}'}}]}:{content:JSON.stringify({scores:s.rubric.weights.map(w=>({key:w.key,score:80,confidence:.9,comment:'可核对',evidence})),summary:'实际材料评分',limitations:[],requirementChecks:s.requirements.map(r=>({requirementId:r.requirementId,status:'met',comment:'有依据',evidence}))})}}],usage:{prompt_tokens:10,completion_tokens:5}});});vi.stubGlobal('fetch',fetch);
    const sliced={...offline,AI_EXECUTION_SLICE:true as const};
    await expect(runMaterialAssessmentJob(sliced,created.jobId)).rejects.toBeInstanceOf(InvestigationContinuation);
    expect((await getJob(env,created.jobId)).status).not.toBe('failed');
    expect((await env.DB.prepare('SELECT status,report_json FROM assessments WHERE id=?1').bind(created.assessmentId).first())).toMatchObject({status:'pending',report_json:null});
    await expect(runMaterialAssessmentJob(sliced,created.jobId)).rejects.toBeInstanceOf(InvestigationContinuation);
    await runMaterialAssessmentJob(sliced,created.jobId);
    expect((await getJob(env,created.jobId)).status).toBe('succeeded');
    expect((await json(await f.request(`/assessments/${created.assessmentId}`))).report.weightedTotal).toBe(80);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
