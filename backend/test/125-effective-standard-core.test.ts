import type { Env } from '../src/env';
import { describe,it,expect } from 'vitest';
import { env } from './helpers/env';
import { seedUser,seedProject } from './helpers/seed';
import { newId,nowIso } from '../src/core/db';
import { saveStandard,standardView,type StandardRow } from '../src/services/project-simplification';
import { effectiveStandard,assertEffectiveStandard,effectiveStandardGuardSql } from '../src/services/effective-standard';
import { snapshotEvaluationRubric,buildAssistiveRubricScoring } from '../src/services/collaboration-ai';
import { assessmentInputs } from '../src/services/assessments';
import { executeDiscoveryTool } from '../src/services/project-context';
import { projectReferenceGuard } from '../src/services/project-reference-guard';
async function fixture(){const user=await seedUser(),projectId=await seedProject(user.userId);return {user,projectId};}
async function save(f:Awaited<ReturnType<typeof fixture>>,title:string,weights=[{key:'quality',label:'质量',weight:100}]){return saveStandard(env,f.projectId,f.user.userId,{title,requirements:[{title,detail:'依据正文'}],weights});}
describe('latest saved project standard',()=>{
 it('does not promote unrelated legacy rubrics into active project standards',async()=>{const f=await fixture();await env.DB.prepare("INSERT INTO rubric_versions(id,project_id,version,source,weights_json,status,created_at) VALUES(?1,?2,1,'custom',?3,'confirmed',?4)").bind(newId(),f.projectId,JSON.stringify([{key:'old',label:'旧维度',weight:100}]),nowIso()).run();expect(await effectiveStandard(env,f.projectId)).toBeNull();expect(await snapshotEvaluationRubric(env,f.projectId)).toBeNull();await expect(assertEffectiveStandard(env,f.projectId)).rejects.toThrow('保存项目标准');});
 it('uses current default, rejects explicit older IDs and preserves frozen history',async()=>{const f=await fixture(),first=await save(f,'旧要求'),original=await effectiveStandard(env,f.projectId),second=await save(f,'最新要求');expect(second).toMatchObject({active:true,version:2,status:'confirmed'});expect((await assessmentInputs(env,f.projectId,undefined,[])).standard.standardsVersionId).toBe(second.standardsVersionId);await expect(assessmentInputs(env,f.projectId,first.standardsVersionId,[])).rejects.toThrow('已更新');const historical=(await env.DB.prepare('SELECT * FROM standards_versions WHERE id=?1').bind(first.standardsVersionId).first<StandardRow>())!;expect(JSON.parse(historical.snapshot_json!)).toEqual(original);expect(await standardView(env,historical)).toMatchObject({active:false,title:'旧要求'});const oldGuard=await env.DB.prepare(`SELECT ${effectiveStandardGuardSql('?1','?2')} valid`).bind(f.projectId,first.standardsVersionId).first<{valid:number}>();expect(oldGuard?.valid).toBe(0);});
 it('reads only effective requirements and rubric, even after unrelated confirmed rubric creation',async()=>{const f=await fixture(),old=await save(f,'旧要求'),current=await save(f,'新要求');await env.DB.prepare("INSERT INTO rubric_versions(id,project_id,version,source,weights_json,status,created_at) VALUES(?1,?2,99,'custom',?3,'confirmed',?4)").bind(newId(),f.projectId,JSON.stringify([{key:'unrelated',label:'无关维度',weight:100}]),nowIso()).run();const read=await executeDiscoveryTool(env,f.projectId,'read_project_standards',{});const standards=read.standards as {items:Array<{id:string}>},requirements=read.requirements as {items:Array<{title:string}>},rubrics=read.rubrics as {items:Array<{id:string}>};expect(standards.items.map(x=>x.id)).toEqual([current.standardsVersionId]);expect(requirements.items.map(x=>x.title)).toEqual(['新要求']);expect(rubrics.items.map(x=>x.id)).toEqual([current.rubricVersionId]);expect(await snapshotEvaluationRubric(env,f.projectId)).toMatchObject({standardsVersionId:current.standardsVersionId,rubricVersionId:current.rubricVersionId});const refs=JSON.stringify([{resourceType:'standard',resourceId:old.standardsVersionId}]);expect((await env.DB.prepare(`SELECT ${projectReferenceGuard('?1','?2')} valid`).bind(refs,f.projectId).first<{valid:number}>())?.valid).toBe(0);});
 it('empty current scoring dimensions override an older scoring rubric',async()=>{const f=await fixture();await save(f,'旧评分');const current=await save(f,'仅要求',[]),rubric=await snapshotEvaluationRubric(env,f.projectId);expect(rubric).toMatchObject({standardsVersionId:current.standardsVersionId,weights:[]});expect(buildAssistiveRubricScoring({decision:'accept',feedback:'通过',evidence:[],limitations:[],coverage:'complete'},rubric)).toMatchObject({status:'unavailable'});});
 it('freezes existing saved drafts without changing IDs or historical snapshot bodies',async()=>{
  const f=await fixture(),old=await save(f,'历史版本'),current=await save(f,'旧草稿');
  const original=(await env.DB.prepare('SELECT snapshot_json FROM standards_versions WHERE id=?1').bind(old.standardsVersionId).first<{snapshot_json:string}>())!.snapshot_json;
  await env.DB.batch([env.DB.prepare("UPDATE standards_versions SET status='draft',snapshot_json=NULL,confirmed_at=NULL WHERE id=?1").bind(current.standardsVersionId),env.DB.prepare("UPDATE requirement_sets SET status='draft' WHERE id=?1").bind(current.requirementSetIds[0]),env.DB.prepare("UPDATE rubric_versions SET status='draft' WHERE id=?1").bind(current.rubricVersionId)]);
  const files=import.meta.glob('../migrations/0044_saved_standard_activation.sql',{query:'?raw',import:'default',eager:true});const raw=Object.values(files)[0] as string;
  await env.DB.batch(raw.replace(/^--.*$/gm,'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>env.DB.prepare(x)));
  expect((await effectiveStandard(env,f.projectId))?.standardsVersionId).toBe(current.standardsVersionId);
  expect((await env.DB.prepare('SELECT snapshot_json FROM standards_versions WHERE id=?1').bind(old.standardsVersionId).first<{snapshot_json:string}>())!.snapshot_json).toBe(original);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM standards_versions WHERE project_id=?1').bind(f.projectId).first<{n:number}>())!.n).toBe(2);
  expect(await env.DB.prepare('SELECT status FROM rubric_versions WHERE id=?1').bind(current.rubricVersionId).first()).toEqual({status:'confirmed'});
 });
 it('rejects concurrent stale saves without orphan components or historical overwrites',async()=>{
  const f=await fixture(),first=await save(f,'初版');
  const db=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{await save(f,'竞争保存');return target.batch(statements);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  await expect(saveStandard({...env,DB:db} as Env,f.projectId,f.user.userId,{title:'过期保存',requirements:[{title:'不得残留',detail:''}],weights:[{key:'quality',label:'质量',weight:100}]},first.standardsVersionId,first.revision)).rejects.toThrow('已变化');
  expect((await effectiveStandard(env,f.projectId))?.title).toBe('竞争保存');
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM requirement_sets WHERE project_id=?1').bind(f.projectId).first<{n:number}>())!.n).toBe(2);
  expect((await env.DB.prepare('SELECT COUNT(*) n FROM rubric_versions WHERE project_id=?1').bind(f.projectId).first<{n:number}>())!.n).toBe(2);
 });

});
