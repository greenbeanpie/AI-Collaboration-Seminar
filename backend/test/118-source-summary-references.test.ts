import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from './helpers/env';
import { seedProject, seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { newId, nowIso } from '../src/core/db';
import { loadAiConfig } from '../src/ai/config';
import { executeFileTool, projectToolConversation } from '../src/services/project-ai-tools';
import { decisionReferences, referencesFromRead, validateReadReferences, type ProjectReference } from '../src/services/project-evidence';
import { projectReferenceGuard } from '../src/services/project-reference-guard';
import { reserveAiSlot } from '../src/services/ai-reservations';
import { InvestigationContinuation } from '../src/services/project-investigation';
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
 const owner=await seedUser(),projectId=await seedProject(owner.userId),fileId=newId(),sourceId=newId(),versionId=newId(),now=nowIso();
 const summary=JSON.stringify({summary:'派生总结'.repeat(1800)+'SUMMARY-TAIL',limitations:['必须另读原文核对']});
 await env.DB.batch([
  env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,created_at) VALUES(?1,?2,?3,'test/summary.pdf','pdf','available',?4)").bind(fileId,projectId,owner.userId,now),
  env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'file','总结验收',?3,?4,?5,?5)").bind(sourceId,projectId,versionId,owner.userId,now),
  env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,status,created_at) VALUES(?1,?2,?3,1,'file',?4,'ready',?5)").bind(versionId,sourceId,projectId,fileId,now),
  env.DB.prepare("INSERT INTO source_processing(source_version_id,project_id,text_status,summary_status,summary_json,summary_revision,updated_at) VALUES(?1,?2,'ready','ready',?3,1,?4)").bind(versionId,projectId,summary,now),
 ]);
 return {context:{projectId,userId:owner.userId},fileId,sourceId,versionId,summary};
}
async function read(f:Awaited<ReturnType<typeof fixture>>,offset=6000) {
 const output=await executeFileTool(env,f.context,'read_project_file',{fileId:f.fileId,mode:'summary',offset}) as Record<string,unknown>;
 return {output,refs:referencesFromRead({...output,resourceId:output.sourceId,versionId:output.sourceVersionId,revision:output.sourceLifecycleVersion})};
}
async function atomic(projectId:string,refs:ProjectReference[]) {
 return (await env.DB.prepare(`SELECT ${projectReferenceGuard('?1','?2')} valid`).bind(JSON.stringify(refs),projectId).first<{valid:number}>())!.valid;
}
describe('derived source-summary evidence',()=>{
 it('returns paged derived summary with lifecycle and offset instead of invalid source fragments, without new model calls',async()=>{
  const f=await fixture(),before=await env.DB.prepare('SELECT COUNT(*) count FROM ai_calls').first<{count:number}>();
  const {output,refs}=await read(f);
  expect(output.derived).toBe(true);expect(output.note).toContain('不能作为来源原文');expect(output.text).toBe(f.summary.slice(6000,12000));expect(output.nextOffset).toBeNull();
  expect(refs[0]).toMatchObject({id:`source_summary:${f.versionId}:1:6000`,resourceType:'source_summary',resourceId:f.sourceId,versionId:f.versionId,revision:1,summaryRevision:1,offset:6000});expect(refs[0]!.fragmentId).toBeUndefined();
  await validateReadReferences(env,f.context.projectId,refs);expect(await atomic(f.context.projectId,refs)).toBe(1);
  expect((await env.DB.prepare('SELECT COUNT(*) count FROM ai_calls').first<{count:number}>())!.count).toBe(before!.count);
  await expect(validateReadReferences(env,f.context.projectId,[{...refs[0]!,resourceType:'source'}])).rejects.toThrow('来源引用版本信息不完整');
  for(const property of ['summaryRevision','offset'] as const) {
   const incomplete={...refs[0]!};delete incomplete[property];
   await expect(validateReadReferences(env,f.context.projectId,[incomplete])).rejects.toThrow('总结引用版本信息不完整');
   expect(await atomic(f.context.projectId,[incomplete])).toBe(0);
  }
  await expect(validateReadReferences(env,f.context.projectId,[{...refs[0]!,resourceType:'unknown'}])).rejects.toThrow('未知引用类型');
  expect(await atomic(f.context.projectId,[{...refs[0]!,resourceType:'unknown'}])).toBe(0);
  expect(()=>decisionReferences('{"referenceIds":["invented"]}',refs)).toThrow('未读取');
 });
 it.each(['status','rewrite','null','summary-revision','recycle','lifecycle','file','project'] as const)('rejects %s changes in preflight and atomic application',async(change)=>{
  const f=await fixture(),{refs}=await read(f);
  if(change==='summary-revision') await env.DB.prepare('UPDATE source_processing SET summary_revision=2 WHERE source_version_id=?1').bind(f.versionId).run();
  if(change==='status') await env.DB.prepare("UPDATE source_processing SET summary_status='running' WHERE source_version_id=?1").bind(f.versionId).run();
  if(change==='rewrite') await env.DB.prepare("UPDATE source_processing SET summary_json='新总结' WHERE source_version_id=?1").bind(f.versionId).run();
  if(change==='null') await env.DB.prepare('UPDATE source_processing SET summary_json=NULL WHERE source_version_id=?1').bind(f.versionId).run();
  if(change==='recycle') await env.DB.prepare('UPDATE sources SET deleted_at=?2 WHERE id=?1').bind(f.sourceId,nowIso()).run();
  if(change==='lifecycle') await env.DB.prepare('UPDATE sources SET lifecycle_version=2 WHERE id=?1').bind(f.sourceId).run();
  if(change==='file') await env.DB.prepare("UPDATE files SET status='discarded',deleted_at=?2 WHERE id=?1").bind(f.fileId,nowIso()).run();
  const projectId=change==='project'?(await fixture()).context.projectId:f.context.projectId;
  await expect(validateReadReferences(env,projectId,refs)).rejects.toThrow();expect(await atomic(projectId,refs)).toBe(0);
 });
 it('reads summaries through real tool protocol across slices, uses legal decision references and resumes without a duplicate paid call',async()=>{
  await configureGoFixture();const f=await fixture(),config=(await loadAiConfig(env.DB))!,jobId=newId();
  await reserveAiSlot(env,{projectId:f.context.projectId,jobId,purpose:'agent_run',maxCalls:5});
  await env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,created_at,updated_at) VALUES(?1,?2,'agent_run','running','{}',?3,?3)").bind(jobId,f.context.projectId,nowIso()).run();
  let round=0;const fetch=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
   if(round++===0)return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'summary',type:'function',function:{name:'read_project_file',arguments:JSON.stringify({fileId:f.fileId,mode:'summary',offset:6000})}}]}}],usage:{prompt_tokens:10,completion_tokens:5}});
   expect(String(init?.body)).toContain('source_summary');
   return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:'仅按已保存总结提出建议，需原文复核',referenceIds:[`source_summary:${f.versionId}:1:6000`]})}}],usage:{prompt_tokens:10,completion_tokens:5}});
  });vi.stubGlobal('fetch',fetch);
  const params={context:{...f.context,jobId},config:config.config.textEconomy,configVersionId:config.id,messages:[{role:'user' as const,content:'读取已保存总结'}],promptVersion:'summary-read-test'},sliced={...env,AI_EXECUTION_SLICE:true as const};
  let result:Awaited<ReturnType<typeof projectToolConversation>>|undefined;
  for(let attempt=0;attempt<6&&!result;attempt++){try{result=await projectToolConversation(sliced,params);}catch(error){if(!(error instanceof InvestigationContinuation))throw error;}}
  expect(result).toBeDefined();expect(result!.references.some(ref=>ref.resourceType==='source_summary'&&ref.usage==='decision')).toBe(true);expect(fetch).toHaveBeenCalledTimes(2);
  expect((await projectToolConversation(sliced,params)).content).toBe(result!.content);expect(fetch).toHaveBeenCalledTimes(2);
 });
});
