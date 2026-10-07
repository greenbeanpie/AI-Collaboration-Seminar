import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { newId, nowIso } from '../src/core/db';
import { loadAiConfig } from '../src/ai/config';
import { aiJsonCall } from '../src/services/agent';
import { saveInvestigation } from '../src/services/project-investigation';
import { reserveAiSlot } from '../src/services/ai-reservations';
import { decisionReferences, modelOutputIssues, referenceRepairContext, type ProjectReference } from '../src/services/project-evidence';

afterEach(() => vi.unstubAllGlobals());

describe('mixed valid and invalid reference repair', () => {
  const reads:ProjectReference[] = ['survey', 'analysis'].map(id => ({id:`material:${id}:0`,resourceType:'material',resourceId:id,versionId:id,quote:`${id}正文`,usage:'read'}));
  it('reports only the rejected ID, preserving valid evidence in the same decision', () => {
    const content=JSON.stringify({decisionReferences:[{decisionPath:'scores[3]',referenceIds:[reads[0]!.id,reads[1]!.id,'material:empty:0']}]});
    try { decisionReferences(content,reads); throw new Error('expected rejection'); }
    catch(error) {
      expect(modelOutputIssues(error)).toEqual([{path:['decisionReferences',0,'referenceIds'],message:'决策引用了未读取的参考资料',invalidIds:['material:empty:0']}]);
    }
  });
  it('does not classify malformed decision fields as invalid evidence', () => {
    try { decisionReferences(JSON.stringify({decisionReferences:[{decisionPath:0,referenceIds:[reads[0]!.id]}]}),reads); throw new Error('expected rejection'); }
    catch(error) { expect(modelOutputIssues(error)).toEqual([{path:['decisionReferences',0],message:'决策依据字段结构无效',invalidIds:[]}]); }
  });
  it('restores tool-read text and distinguishes public IDs from evidence version IDs', () => {
    const context=referenceRepairContext(reads,[{content:JSON.stringify({markdown:reads[0]!.quote})}]);
    expect(context).toContain('materialVersionId使用versionId');
    expect(context).toContain('analysis正文');
    expect(context).toContain('正文已完整提供在前面的输入中');
    expect(context).toContain(reads[0]!.id);
  });
  it.each([false,true])('keeps two genuine data materials after output-only correction (restored=%s)', async restored => {
    await configureGoFixture();
    const owner=await seedUser(),projectId=await seedProject(owner.userId),now=nowIso();
    const materials=[] as ProjectReference[];
    for(const text of ['有效问卷96份，平均满意度3.02分。','三个时段排队人数26人、17人、9人。']) {
      const materialId=newId(),versionId=newId();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO materials(id,project_id,title,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'数据成果',?3,?4,?5,?5)").bind(materialId,projectId,versionId,owner.userId,now),
        env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES(?1,?2,?3,1,'{}',?4,'manual',?5,?6)").bind(versionId,materialId,projectId,text,owner.userId,now),
      ]);
      materials.push({id:`material:${versionId}:0`,resourceType:'material',resourceId:materialId,versionId,revision:1,title:'数据成果',quote:text,usage:'read'});
    }
    const config=(await loadAiConfig(env.DB))!,invalidId=`material:${newId()}:0`;
    const resultContent=(invalid:boolean)=>JSON.stringify({summary:'完整数据支持评价',evidence:materials.map(m=>({materialVersionId:m.versionId,quote:m.quote})),referenceIds:materials.map(m=>m.id),decisionReferences:[{decisionPath:'evidence',referenceIds:[...materials.map(m=>m.id),...(invalid?[invalidId]:[])]}]});
    let jobId:string|undefined;
    if(restored) {
      jobId=newId();
      await reserveAiSlot(env,{projectId,jobId,purpose:'review_run'});
      await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_by,created_at,updated_at) VALUES(?1,?2,'review_run','running','{}',?3,?4,?4)").bind(jobId,projectId,owner.userId,now).run();
      await saveInvestigation(env,{projectId,jobId,userId:owner.userId},jobId+'-mixed-reference-regression','mixed-reference-regression', {step:3,exchanges:[],references:materials,trace:[],content:resultContent(true),effectiveStandardsVersionId:null});
    }
    let repair='';
    const fetch=vi.fn(async (_url:RequestInfo|URL,init?:RequestInit)=>{
      if(restored||fetch.mock.calls.length>1) repair=JSON.parse(String(init?.body)).messages.at(-1).content;
      return Response.json({choices:[{finish_reason:'stop',message:{content:resultContent(!restored&&fetch.mock.calls.length===1)}}],usage:{prompt_tokens:10,completion_tokens:10}});
    });
    vi.stubGlobal('fetch',fetch);
    const result=await aiJsonCall(env,{projectId,jobId,projectTools:{projectId,userId:owner.userId,jobId,initialReferences:materials},purpose:'review',configVersionId:config.id,model:config.config.review.model,modelConfig:config.config.review,promptVersion:'mixed-reference-regression',messages:[{role:'user',content:'评价调研数据'}],schema:z.object({summary:z.string(),evidence:z.array(z.object({materialVersionId:z.string(),quote:z.string()}))}).strict()});
    expect(result.repaired).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(restored?1:2);
    expect(repair).toContain(JSON.stringify([invalidId]));
    for(const m of materials) {
      expect(repair).toContain(m.quote!);
      expect(result.references).toContainEqual(expect.objectContaining({id:m.id,usage:'decision'}));
    }
    expect(result.data.evidence).toHaveLength(2);
    expect((await env.DB.prepare('SELECT count(*) n FROM ai_tool_calls WHERE project_id=?1').bind(projectId).first<{n:number}>())!.n).toBe(0);
  });
});
