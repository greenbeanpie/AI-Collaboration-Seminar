import { afterEach,describe,expect,it,vi } from 'vitest';
import { env } from './helpers/env';
import { seedProject,seedUser } from './helpers/seed';
import { newId,nowIso } from '../src/core/db';
import { executeDiscoveryTool } from '../src/services/project-context';
import { referencesFromRead,validateReadReferences,decisionReferences,extractDecisionReferences } from '../src/services/project-evidence';
import { projectToolConversation } from '../src/services/project-ai-tools';
import { configureGoFixture } from './helpers/provider-config';
import { loadAiConfig } from '../src/ai/config';
import { reserveAiSlot } from '../src/services/ai-reservations';
import { aiJsonCall,businessJson } from '../src/services/agent';
import { redactPrivateExchanges } from '../src/services/project-investigation';
import { ensureExecution, readExecution, resumeExecution } from '../src/services/ai-execution-control';
import { z } from 'zod';
afterEach(()=>vi.unstubAllGlobals());
async function fixture(){const owner=await seedUser(),projectId=await seedProject(owner.userId);return {owner,projectId};}
describe('autonomous project investigation',()=>{
  it.each([false,true])('feeds invalid provenance back to model without tools and reuses paid repaired checkpoints (direct=%s)',async direct=>{
    await configureGoFixture();const f=await fixture(),config=(await loadAiConfig(env.DB))!,jobId=newId();
    await reserveAiSlot(env,{projectId:f.projectId,jobId,purpose:'review_run',maxCalls:5});
    await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'review_run','running','{}',?3,?3)").bind(jobId,f.projectId,nowIso()).run();
    const blankVersion=newId(),blankMaterial=newId();await env.DB.batch([env.DB.prepare("INSERT INTO materials(id,project_id,title,kind,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'空正文成果','report',?3,?4,?5,?5)").bind(blankMaterial,f.projectId,blankVersion,f.owner.userId,nowIso()),env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES(?1,?2,?3,1,'{}','','manual',?4,?5)").bind(blankVersion,blankMaterial,f.projectId,f.owner.userId,nowIso())]);
    const emptyRead=await executeDiscoveryTool(env,f.projectId,'read_resource',{resourceType:'material',versionId:blankVersion,offset:0});expect(referencesFromRead(emptyRead)).toEqual([]);
    let round=0;const fetch=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body));
      if(round++===0)return Response.json({choices:[{message:{content:JSON.stringify({title:'真实结论',referenceIds:[`project:${f.projectId}:0`],decisionReferences:[{decisionPath:'scores[3]',referenceIds:[`material:${blankVersion}:0`]}]})}}],usage:{prompt_tokens:10,completion_tokens:5}});
      expect(body.tools).toBeUndefined();expect(JSON.stringify(body.messages)).toContain('decisionReferences');expect(JSON.stringify(body.messages)).toContain(`material:${blankVersion}:0`);expect(JSON.stringify(body.messages)).toContain('project:'+f.projectId);
      return Response.json({choices:[{message:{content:JSON.stringify({title:'真实结论',referenceIds:[],decisionReferences:[]})}}],usage:{prompt_tokens:10,completion_tokens:5}});
    });vi.stubGlobal('fetch',fetch);
    const shared={messages:[{role:'user' as const,content:'调查项目'}],promptVersion:'invalid-reference-checkpoint',configVersionId:config.id};
    const run=()=>direct?projectToolConversation(env,{...shared,context:{projectId:f.projectId,userId:f.owner.userId,jobId},config:config.config.review}):aiJsonCall(env,{...shared,projectId:f.projectId,jobId,projectTools:{projectId:f.projectId,userId:f.owner.userId,jobId},purpose:'review',model:config.config.review.model,modelConfig:config.config.review,schema:z.object({title:z.string()}).strict()});
    const out=await run();expect(JSON.stringify(out)).toContain('真实结论');expect(fetch).toHaveBeenCalledTimes(2);
    await run();expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('bounds job final repairs and resumes a new correction after explicit continuation without replaying investigation',async()=>{
    await configureGoFixture();const f=await fixture(),config=(await loadAiConfig(env.DB))!,jobId=newId();
    await reserveAiSlot(env,{projectId:f.projectId,jobId,purpose:'review_run',maxCalls:10});
    await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'review_run','running','{}',?3,?3)").bind(jobId,f.projectId,nowIso()).run();await ensureExecution(env,{kind:'job',id:jobId});
    const fetch=vi.fn(async()=>Response.json({choices:[{message:{content:JSON.stringify({title:'原结论',referenceIds:['never-read']})}}],usage:{prompt_tokens:10,completion_tokens:5}}));vi.stubGlobal('fetch',fetch);
    const params={projectId:f.projectId,jobId,projectTools:{projectId:f.projectId,userId:f.owner.userId,jobId},purpose:'review' as const,configVersionId:config.id,model:config.config.review.model,modelConfig:config.config.review,promptVersion:'bounded-reference-repair',messages:[{role:'user' as const,content:'检查'}],schema:z.object({title:z.string()}).strict()};
    await expect(aiJsonCall(env,params)).rejects.toMatchObject({details:{executionPause:true}});expect(fetch).toHaveBeenCalledTimes(3);expect(await readExecution(env,{kind:'job',id:jobId})).toMatchObject({state:'paused',pauseReason:'output_invalid'});
    await resumeExecution(env,{kind:'job',id:jobId},1,'continue');await env.DB.prepare("UPDATE jobs SET status='running' WHERE id=?1").bind(jobId).run();fetch.mockImplementation(async(_url?:unknown,init?:RequestInit)=>{const body=JSON.parse(String(init?.body));expect(body.tools).toBeUndefined();expect(JSON.stringify(body.messages)).toContain('never-read');return Response.json({choices:[{message:{content:'{"title":"原结论","referenceIds":[]}'}}],usage:{prompt_tokens:10,completion_tokens:5}});});
    expect((await aiJsonCall(env,params)).data.title).toBe('原结论');expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('rejects forged initial material metadata before any model dispatch',async()=>{
    await configureGoFixture();const f=await fixture(),config=(await loadAiConfig(env.DB))!;const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    await expect(projectToolConversation(env,{context:{projectId:f.projectId,userId:f.owner.userId,initialReferences:[{id:'material:forged:0',resourceType:'material',resourceId:newId(),versionId:newId(),revision:1,quote:'伪造正文',usage:'read'}]},config:config.config.review,configVersionId:config.id,messages:[{role:'user',content:'检查'}],promptVersion:'forged-material'})).rejects.toThrow('已读取材料引用不符');expect(fetch).not.toHaveBeenCalled();
  });

  it('repairs a wrong limitations type using the exact schema failure without rerunning discovery',async()=>{
    await configureGoFixture();const f=await fixture(),config=(await loadAiConfig(env.DB))!;let round=0;
    const fetch=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
      if(round++===0)return Response.json({choices:[{message:{content:'{"title":"保持结论","limitations":"仅有结构稿"}'}}],usage:{prompt_tokens:10,completion_tokens:5}});
      const body=JSON.parse(String(init?.body));
      expect(JSON.stringify(body.messages)).toContain('limitations');expect(JSON.stringify(body.messages)).toContain('invalid_type');expect(body.tools).toBeUndefined();
      return Response.json({choices:[{message:{content:'{"title":"保持结论","limitations":["仅有结构稿"]}'}}],usage:{prompt_tokens:10,completion_tokens:5}});
    });vi.stubGlobal('fetch',fetch);
    const out=await aiJsonCall(env,{projectId:f.projectId,projectTools:{projectId:f.projectId,userId:f.owner.userId},purpose:'review',configVersionId:config.id,model:config.config.review.model,modelConfig:config.config.review,promptVersion:'typed-repair',messages:[{role:'user',content:'核验结构稿'}],schema:z.object({title:z.string(),limitations:z.array(z.string())}).strict()});
    expect(out.data).toEqual({title:'保持结论',limitations:['仅有结构稿']});expect(fetch).toHaveBeenCalledTimes(2);expect(out.repaired).toBe(true);
  });
  it('keeps business schemas strict while separating validated transport references and redacting private assistant prose',async()=>{
    expect(z.object({title:z.string()}).strict().parse(businessJson('```json\n{"title":"方案","referenceIds":[],"decisionReferences":[]}\n```'))).toEqual({title:'方案'});
    expect(()=>z.object({title:z.string()}).strict().parse(businessJson('{"title":"方案","unexpected":"must reject"}'))).toThrow();
    const redacted=redactPrivateExchanges([{assistant:{role:'assistant',content:'private biography',tool_calls:[{id:'t',function:{name:'list_tasks',arguments:'{}'}}]},results:[]}]);
    expect(JSON.stringify(redacted)).not.toContain('private biography');expect(JSON.stringify(redacted)).toContain('list_tasks');
    await configureGoFixture();const f=await fixture(),config=(await loadAiConfig(env.DB))!;
    const fetch=vi.fn(async()=>Response.json({choices:[{finish_reason:'stop',message:{content:'{"title":"建议","referenceIds":[],"decisionReferences":[]}'}}],usage:{prompt_tokens:10,completion_tokens:5}}));vi.stubGlobal('fetch',fetch);
    const out=await aiJsonCall(env,{projectId:f.projectId,projectTools:{projectId:f.projectId,userId:f.owner.userId},purpose:'textEconomy',configVersionId:config.id,model:config.config.textEconomy.model,modelConfig:config.config.textEconomy,promptVersion:'strict-fixture',messages:[{role:'user',content:'请给建议'}],schema:z.object({title:z.string()}).strict()});
    expect(out.data).toEqual({title:'建议'});expect(out.references?.length).toBeGreaterThan(0);expect(out.decisionReferences).toEqual([]);
  });
  it('repairs final JSON once without replaying tools and rechecks private dispatch context',async()=>{
    await configureGoFixture();const f=await fixture(),config=(await loadAiConfig(env.DB))!;let round=0,prepared=0;
    const fetch=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body)),i=round++;
      if(i===0)return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'discover',type:'function',function:{name:'list_project_resources',arguments:'{"offset":0}'}}]}}],usage:{prompt_tokens:10,completion_tokens:5}});
      if(i===1)return Response.json({choices:[{message:{content:'{"wrong":"needs structure repair"}'}}],usage:{prompt_tokens:10,completion_tokens:5}});
      expect(body.tools).toBeUndefined();expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-go-job-key');expect(new Headers(init?.headers).has('cf-aig-authorization')).toBe(false);
      expect(JSON.stringify(body)).toContain('fresh-private-context');
      return Response.json({choices:[{message:{content:'{"title":"已修复","referenceIds":[],"decisionReferences":[]}'}}],usage:{prompt_tokens:10,completion_tokens:5}});
    });vi.stubGlobal('fetch',fetch);
    const out=await aiJsonCall(env,{projectId:f.projectId,projectTools:{projectId:f.projectId,userId:f.owner.userId},purpose:'textEconomy',configVersionId:config.id,model:config.config.textEconomy.model,modelConfig:config.config.textEconomy,promptVersion:'repair-fixture',privateContext:true,messages:[{role:'user',content:'调查项目'}],prepareMessages:async()=>{prepared++;return [{role:'user',content:'fresh-private-context'}];},schema:z.object({title:z.string()}).strict()});
    expect(out.data).toEqual({title:'已修复'});expect(out.repaired).toBe(true);expect(out.toolTrace).toHaveLength(1);expect(fetch).toHaveBeenCalledTimes(3);expect(prepared).toBe(3);
  });
  it('discovers paste sources and material beyond first page and validates read version evidence',async()=>{
    const {owner,projectId}=await fixture(),now=nowIso(),versionId=newId(),materialId=newId();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO materials(id,project_id,title,kind,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'直接编辑成果','report',?3,?4,?5,?5)").bind(materialId,projectId,versionId,owner.userId,now),
      env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES(?1,?2,?3,1,'{}',?4,'manual',?5,?6)").bind(versionId,materialId,projectId,'验收依据'.repeat(4000),owner.userId,now),
      ...Array.from({length:25},(_,i)=>env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,created_by,created_at,updated_at) VALUES(?1,?2,'paste',?3,?4,?5,?5)").bind(newId(),projectId,'粘贴'+i,owner.userId,now))
    ]);
    // Discovery requires source current versions; add immutable versions for each paste.
    const sources=await env.DB.prepare('SELECT id FROM sources WHERE project_id=?1').bind(projectId).all<{id:string}>();
    for(const source of sources.results){const v=newId();await env.DB.batch([
      env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,status,created_at) VALUES(?1,?2,?3,1,'paste','ready',?4)").bind(v,source.id,projectId,now),
      env.DB.prepare('UPDATE sources SET current_version_id=?2 WHERE id=?1').bind(source.id,v)
    ]);}
    const first=await executeDiscoveryTool(env,projectId,'list_project_resources',{}),second=await executeDiscoveryTool(env,projectId,'list_project_resources',{offset:20});
    expect((first.items as unknown[]).length).toBe(20);expect(first.nextOffset).toBe(20);expect((second.items as unknown[]).length).toBe(6);
    const read=await executeDiscoveryTool(env,projectId,'read_resource',{resourceType:'material',versionId,offset:6000});
    expect((read.text as string).length).toBe(6000);expect(read.nextOffset).toBe(12000);
    const refs=referencesFromRead(read);await validateReadReferences(env,projectId,refs);
    const found=await executeDiscoveryTool(env,projectId,'search_project_information',{query:'验收依据'});
    expect(JSON.stringify(found)).toContain(materialId);
    const versions=await executeDiscoveryTool(env,projectId,'list_resource_versions',{resourceType:'material',id:materialId});
    expect(JSON.stringify(versions)).toContain(versionId);
    expect(decisionReferences(JSON.stringify({referenceIds:[refs[0]!.id]}),refs)[0]!.usage).toBe('decision');
    expect(extractDecisionReferences(JSON.stringify({decisionReferences:[{decisionPath:'tasks[0]',referenceIds:[refs[0]!.id]}]}),refs)[0]!.decisionPath).toBe('tasks[0]');
    expect(()=>extractDecisionReferences('{"decisionReferences":[{"decisionPath":"tasks[0]","referenceIds":["fabricated"]}]}',refs)).toThrow('未读取');
    expect(()=>decisionReferences('{"referenceIds":["fabricated"]}',refs)).toThrow('未读取');
    const another=await fixture();await expect(executeDiscoveryTool(env,another.projectId,'read_resource',{resourceType:'material',versionId})).rejects.toThrow('不存在');
  });
  it('continues beyond old4/8 limits, bills review purpose and reuses completed checkpoint without a second paid request',async()=>{
    await configureGoFixture();const f=await fixture(),config=(await loadAiConfig(env.DB))!,jobId=newId();
    await reserveAiSlot(env,{projectId:f.projectId,jobId,purpose:'review_run',maxCalls:5});
    await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'review_run','running','{}',?3,?3)").bind(jobId,f.projectId,nowIso()).run();
    let round=0;const fetch=vi.fn(async()=>{const i=round++;return Response.json({choices:[{finish_reason:i<10?'tool_calls':'stop',message:i<10?{tool_calls:[{id:'call'+i,type:'function',function:{name:'list_project_resources',arguments:JSON.stringify({offset:i*20})}}]}:{content:'{"summary":"调查完成"}'}}],usage:{prompt_tokens:10,completion_tokens:5}});});vi.stubGlobal('fetch',fetch);
    const params={context:{projectId:f.projectId,userId:f.owner.userId,jobId},config:config.config.review,configVersionId:config.id,purpose:'review' as const,messages:[{role:'user' as const,content:'调查项目'}],promptVersion:'autonomous-fixture'};
    const out=await projectToolConversation(env,params);expect(out.trace).toHaveLength(10);expect(fetch).toHaveBeenCalledTimes(11);
    const calls=await env.DB.prepare('SELECT purpose FROM ai_calls WHERE job_id=?1').bind(jobId).all<{purpose:string}>();expect(calls.results.every(c=>c.purpose==='review')).toBe(true);
    const resumed=await projectToolConversation(env,params);expect(resumed.content).toBe(out.content);expect(fetch).toHaveBeenCalledTimes(11);
  });
});
