import { afterEach,describe,expect,it,vi } from 'vitest';
import { env } from './helpers/env';
import { seedProject,seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { newId,nowIso } from '../src/core/db';
import { reserveAiSlot } from '../src/services/ai-reservations';
import { saveStandard } from '../src/services/project-simplification';
import { assessmentInputs,scoreAssessment,type AssessmentRow } from '../src/services/assessments';
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

describe('material scoring uses related evidence and zero for wholly absent dimensions',()=>{
  it.each(['valid','null','unsupported','invented'])('returns a numeric total and repairs invalid output (%s)',async mode=>{
    await configureGoFixture();
    const f=await fixture(),input=await assessmentInputs(env,f.projectId,f.standardId,[f.materialVersionId]);
    const row={id:newId(),project_id:f.projectId,kind:'material_review',entity_id:null,goal_revision:input.goal.revision,standards_version_id:f.standardId,inputs_json:JSON.stringify(input),status:'pending',report_json:null,job_id:null,created_by:f.owner.userId,created_at:nowIso()} as AssessmentRow;
    const valid={scores:[{key:'content',score:70,confidence:.4,comment:'从其他部分的采集日期间接判断内容覆盖，置信度有限',evidence:[{type:'material',materialVersionId:f.materialVersionId,quote:'三条样本均记录采集日期。'}]},{key:'evidence',score:0,confidence:.9,comment:'全部成果完全未提及该维度所需内容，按0分计',evidence:[]}],summary:'现有成果辅助评分，缺失部分计0',limitations:['内容维度使用间接证据，置信度有限'],requirementChecks:[],referenceIds:[`material:${f.materialVersionId}:0`],decisionReferences:[]};
    const jobId=newId();
    await reserveAiSlot(env,{projectId:f.projectId,jobId,purpose:'review_run',maxCalls:24});
    await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'review_run','running','{}',?3,?4,?4)").bind(jobId,f.projectId,f.owner.userId,nowIso()).run();
    let repair='';
    const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body));
      if(fetch.mock.calls.length===1){expect(body.messages[0].content).toContain('结合全部固定成果');expect(body.messages[0].content).toContain('不得返回null');}
      else repair=body.messages.at(-1).content;
      const out=structuredClone(valid);
      if(fetch.mock.calls.length===1){
        if(mode==='null')out.scores[1]!.score=null as unknown as number;
        if(mode==='unsupported')out.scores[1]!.score=90;
        if(mode==='invented')out.scores[0]!.evidence[0]!.quote='伪造证据';
      }
      return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(out)}}],usage:{prompt_tokens:10,completion_tokens:5}});
    });vi.stubGlobal('fetch',fetch);
    const result=await scoreAssessment(env,row,jobId);
    expect(result.status).toBe('scored');expect(result.weightedTotal).toBe(42);
    expect(result.scores.map(s=>s.score)).toEqual([70,0]);expect(result.scores[0]!.confidence).toBe(.4);
    expect(result.scores[1]!.evidence).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(mode==='valid'?1:2);
    if(mode!=='valid')expect(repair).toContain(mode==='null'?'不得返回null':mode==='unsupported'?'正分必须引用':'评分证据与固定材料');
  });
});
