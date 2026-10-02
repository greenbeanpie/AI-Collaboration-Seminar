import { describe,it,expect } from 'vitest';
import { env } from './helpers/env';
import { seedProject,seedUser } from './helpers/seed';
import { newId,nowIso } from '../src/core/db';
import { executeDiscoveryTool } from '../src/services/project-context';
import { referencesFromRead,validateReadReferences,type ProjectReference } from '../src/services/project-evidence';
import { projectReferenceGuard } from '../src/services/project-reference-guard';
async function fixture(){
 const owner=await seedUser(),projectId=await seedProject(owner.userId),now=nowIso(),jobId=newId(),proposalId=newId(),rubricId=newId(),standardsId=newId(),assessmentId=newId();
 await env.DB.batch([
  env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'agent_run','succeeded','{}',?3,?3)").bind(jobId,projectId,now),
  env.DB.prepare("INSERT INTO collaboration_proposals(id,project_id,kind,job_id,payload_json,settings_revision,status,revision,created_at,updated_at) VALUES(?1,?2,'decompose',?3,?4,1,'pending',2,?5,?5)").bind(proposalId,projectId,jobId,JSON.stringify({tasks:[{title:'人工修订后的调研',detail:'调查内容'.repeat(2400)}]}),now),
  env.DB.prepare("INSERT INTO collaboration_proposal_revisions(id,proposal_id,project_id,revision,payload_json,status,actor_id,reason,created_at) VALUES(?1,?2,?3,1,?4,'pending',?5,'先验证假设再推进',?6)").bind(newId(),proposalId,projectId,JSON.stringify({tasks:[{title:'原AI建议'}]}),owner.userId,now),
  env.DB.prepare("INSERT INTO rubric_versions(id,project_id,version,source,weights_json,status,created_at) VALUES(?1,?2,1,'custom','[]','confirmed',?3)").bind(rubricId,projectId,now),
  env.DB.prepare("INSERT INTO standards_versions(id,project_id,version,title,status,rubric_version_id,created_at,updated_at) VALUES(?1,?2,1,'固定标准','confirmed',?3,?4,?4)").bind(standardsId,projectId,rubricId,now),
  env.DB.prepare("INSERT INTO assessments(id,project_id,kind,goal_revision,standards_version_id,inputs_json,status,report_json,ai_report_json,revision,origin,created_by,created_at) VALUES(?1,?2,'material_review',1,?3,?4,'succeeded',?5,?6,2,'ai_adjusted',?7,?8)").bind(assessmentId,projectId,standardsId,JSON.stringify({materialVersionIds:[newId()],goal:{title:'固定主目标'}}),JSON.stringify({weightedTotal:88,summary:'管理员有效评价'}),JSON.stringify({weightedTotal:60,summary:'原AI报告'}),owner.userId,now),
  env.DB.prepare('INSERT INTO assessment_corrections(id,assessment_id,project_id,actor_id,revision,reason,previous_report_json,report_json,created_at) VALUES(?1,?2,?3,?4,2,?5,?6,?7,?8)').bind(newId(),assessmentId,projectId,owner.userId,'补充人工核验证据',JSON.stringify({weightedTotal:60}),JSON.stringify({weightedTotal:88}),now)
 ]);
 return {owner,projectId,proposalId,assessmentId,standardsId};
}
async function guard(projectId:string,refs:ProjectReference[]){return (await env.DB.prepare(`SELECT ${projectReferenceGuard('?1','?2')} ok`).bind(JSON.stringify(refs),projectId).first<{ok:number}>())!.ok;}
describe('project plans and effective assessments are autonomous-readable',()=>{
 it('lists all plan states without claiming body reads, reads full revision reasons in chunks and refuses cross-project scope',async()=>{
  const f=await fixture(),other=await fixture();
  const listing=await executeDiscoveryTool(env,f.projectId,'list_project_plans',{});
  expect(JSON.stringify(listing)).toContain(f.proposalId);expect(JSON.stringify(listing)).not.toContain(other.proposalId);expect(referencesFromRead(listing)).toEqual([]);
  for(const status of ['pending','applied','stale']){await env.DB.prepare('UPDATE collaboration_proposals SET status=?2 WHERE id=?1').bind(f.proposalId,status).run();const listed=await executeDiscoveryTool(env,f.projectId,'list_project_plans',{query:status});expect(JSON.stringify(listed)).toContain(f.proposalId);}
  const refs:ProjectReference[]=[];let offset=0,text='';
  do{const read=await executeDiscoveryTool(env,f.projectId,'read_project_plan',{id:f.proposalId,offset});expect(Array.from(read.text as string).length).toBeLessThanOrEqual(6000);refs.push(...referencesFromRead(read));text+=read.text;offset=read.nextOffset as number;}while(offset!==null);
  const parsed=JSON.parse(text);expect(parsed.effectiveProposal.tasks[0].title).toBe('人工修订后的调研');expect(parsed.revisionHistory[0].reason).toBe('先验证假设再推进');expect(()=>JSON.parse(refs[0]!.quote!)).toThrow();
  await validateReadReferences(env,f.projectId,refs);expect(await guard(f.projectId,refs)).toBe(1);
  await expect(executeDiscoveryTool(env,other.projectId,'read_project_plan',{id:f.proposalId})).rejects.toThrow('不属于');
  expect(await guard(other.projectId,refs)).toBe(0);
  await env.DB.prepare('UPDATE collaboration_proposals SET revision=revision+1 WHERE id=?1').bind(f.proposalId).run();
  await expect(validateReadReferences(env,f.projectId,refs)).rejects.toThrow('已变化');expect(await guard(f.projectId,refs)).toBe(0);
 });
 it('separates effective human report, original AI and correction history with frozen inputs; quote and revision updates invalidate atomically',async()=>{
  const f=await fixture(),other=await fixture(),listing=await executeDiscoveryTool(env,f.projectId,'list_assessments',{});
  expect(referencesFromRead(listing)).toEqual([]);
  const read=await executeDiscoveryTool(env,f.projectId,'read_assessment',{id:f.assessmentId}),report=JSON.parse(read.text as string),refs=referencesFromRead(read);
  expect(report).toMatchObject({origin:'ai_adjusted',effectiveReport:{weightedTotal:88,summary:'管理员有效评价'},originalAiReport:{weightedTotal:60,summary:'原AI报告'},goalRevision:1,standardsVersionId:f.standardsId,fixedInputs:{goal:{title:'固定主目标'}}});
  expect(report.correctionHistory[0].reason).toBe('补充人工核验证据');await validateReadReferences(env,f.projectId,refs);expect(await guard(f.projectId,refs)).toBe(1);
  const forged=refs.map(r=>({...r,quote:'从未存在的报告内容'}));await expect(validateReadReferences(env,f.projectId,forged)).rejects.toThrow('引用不符');expect(await guard(f.projectId,forged)).toBe(0);
  await expect(executeDiscoveryTool(env,other.projectId,'read_assessment',{id:f.assessmentId})).rejects.toThrow('不属于');expect(await guard(other.projectId,refs)).toBe(0);
  await env.DB.prepare('UPDATE assessments SET revision=revision+1 WHERE id=?1').bind(f.assessmentId).run();await expect(validateReadReferences(env,f.projectId,refs)).rejects.toThrow('已变化');expect(await guard(f.projectId,refs)).toBe(0);
 });
 it('paginates long assessment documents without treating truncated JSON as a structured snapshot',async()=>{
  const f=await fixture(),long='人工复核依据😀'.repeat(1500);
  await env.DB.prepare('UPDATE assessments SET report_json=?2 WHERE id=?1').bind(f.assessmentId,JSON.stringify({weightedTotal:88,summary:long})).run();
  let offset:number|null=0,text='';const refs:ProjectReference[]=[];
  do{const read=await executeDiscoveryTool(env,f.projectId,'read_assessment',{id:f.assessmentId,offset});expect(Array.from(read.text as string).length).toBeLessThanOrEqual(6000);text+=read.text;refs.push(...referencesFromRead(read));offset=read.nextOffset as number|null;}while(offset!==null);
  expect(refs.length).toBeGreaterThan(1);expect(()=>JSON.parse(refs[0]!.quote!)).toThrow();expect(JSON.parse(text).effectiveReport.summary).toBe(long);
  await validateReadReferences(env,f.projectId,refs);expect(await guard(f.projectId,refs)).toBe(1);
 });
});
