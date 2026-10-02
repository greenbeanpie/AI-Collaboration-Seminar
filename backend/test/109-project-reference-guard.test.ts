import { describe,it,expect } from 'vitest';
import type { Env } from '../src/env';
import { env } from './helpers/env';
import { seedProject,seedUser } from './helpers/seed';
import { configureGoFixture } from './helpers/provider-config';
import { newId,nowIso } from '../src/core/db';
import { applyProposal,reviseProposal } from '../src/services/collaboration';
import { referencesFromRead,uniqueReadReferences,decisionReferences,extractDecisionReferences,validateReadReferences,type ProjectReference } from '../src/services/project-evidence';
import { dispatchProjectProgression } from '../src/services/project-progression';
import { executeDiscoveryTool } from '../src/services/project-context';
await configureGoFixture();
async function fixture(){const owner=await seedUser(),projectId=await seedProject(owner.userId);await env.DB.prepare("UPDATE projects SET ai_collaboration_enabled=1,planning_mode='automatic' WHERE id=?1").bind(projectId).run();return {owner,projectId};}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function source(f:Fixture){const fileId=newId(),sourceId=newId(),versionId=newId(),fragmentId=newId(),now=nowIso(),quote='真实验收原文';await env.DB.batch([
 env.DB.prepare("INSERT INTO files(id,project_id,uploader_user_id,r2_key,ext,status,created_at) VALUES(?1,?2,?3,'test/guard.pdf','pdf','available',?4)").bind(fileId,f.projectId,f.owner.userId,now),
 env.DB.prepare("INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'file','自主读取资料',?3,?4,?5,?5)").bind(sourceId,f.projectId,versionId,f.owner.userId,now),
 env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,char_count,status,created_at) VALUES(?1,?2,?3,1,'file',?4,6,'ready',?5)").bind(versionId,sourceId,f.projectId,fileId,now),
 env.DB.prepare("INSERT INTO source_fragments(id,source_version_id,project_id,page_number,seq,kind,content,created_at) VALUES(?1,?2,?3,1,1,'text',?4,?5)").bind(fragmentId,versionId,f.projectId,quote,now)
]);const reference:ProjectReference={id:'read-'+fragmentId,resourceType:'source',resourceId:sourceId,versionId,fragmentId,pageNumber:1,revision:1,quote,usage:'decision'};return {fileId,sourceId,versionId,reference};}
async function proposal(f:Fixture,refs:ProjectReference[]){const id=newId(),jobId=newId(),now=nowIso();const payload={tasks:[{key:'new',title:'新任务',detail:'实际项目工作',criteria:'可验证成果',effortHours:1}],references:refs};await env.DB.batch([
 env.DB.prepare("INSERT INTO jobs(id,project_id,kind,status,input_json,attempts,created_at,updated_at) VALUES(?1,?2,'agent_run','queued','{}',0,?3,?3)").bind(jobId,f.projectId,now),
 env.DB.prepare("INSERT INTO collaboration_proposals(id,project_id,kind,job_id,payload_json,settings_revision,created_at,updated_at) VALUES(?1,?2,'decompose',?3,?4,1,?5,?5)").bind(id,f.projectId,jobId,JSON.stringify(payload),now)
]);return {id,payload};}
function race(before:()=>Promise<unknown>):Env{const db=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{await before();return target.batch(statements);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});return {...env,DB:db};}
async function untouched(f:Fixture,p:string){expect((await env.DB.prepare('SELECT COUNT(*) count FROM tasks WHERE project_id=?1').bind(f.projectId).first<{count:number}>())!.count).toBe(0);expect((await env.DB.prepare('SELECT status FROM collaboration_proposals WHERE id=?1').bind(p).first<{status:string}>())!.status).toBe('pending');}
describe('atomic autonomous proposal references',()=>{
 it('uses the same resource-type prefix for source and material read identifiers',()=>{
  const versionId=newId(),fragmentId=newId(),resourceId=newId();
  const sourceRef=referencesFromRead({resourceType:'source',resourceId,versionId,revision:1,offset:0,fragments:[{fragmentId,pageNumber:3,quote:'尾页修订'}]})[0]!;
  const materialRef=referencesFromRead({resourceType:'material',resourceId,versionId,revision:1,offset:0,text:'结构稿'})[0]!;
  expect(sourceRef.id).toBe(`source:${versionId}:${fragmentId}:0`);expect(materialRef.id).toBe(`material:${versionId}:0`);
  expect(extractDecisionReferences(JSON.stringify({decisionReferences:[{decisionPath:'summary',referenceIds:[sourceRef.id]}]}),[sourceRef])).toHaveLength(1);
 });
 it('retains different quotes and marks decision-only references against all reads',()=>{
   const ref:ProjectReference={id:'read-1',resourceType:'material',resourceId:'m',versionId:'v',quote:'原文一',usage:'read'};
   const refs=uniqueReadReferences([ref,{...ref},{...ref,quote:'原文二'},{...ref,id:'read-2'}]);
   expect(refs).toHaveLength(3);
   const content=JSON.stringify({referenceIds:[],decisionReferences:[{decisionPath:'tasks[0]',referenceIds:['read-1']}]});
   const marked=decisionReferences(content,refs);
   expect(marked.map(r=>r.usage)).toEqual(['decision','decision','read']);
   expect(extractDecisionReferences(content,marked)[0]!.referenceIds).toEqual(['read-1']);
   expect(()=>decisionReferences(JSON.stringify({referenceIds:[],decisionReferences:[{decisionPath:'tasks[0]',referenceIds:['unknown']}]}),refs)).toThrow('未读取');
   expect(()=>decisionReferences(JSON.stringify({referenceIds:['unknown'],decisionReferences:[]}),refs)).toThrow('未读取');
 });
 it('deduplicates repeated row reads into bounded batches while checking every captured revision',async()=>{
   const f=await fixture(),now=nowIso();
   const refs:ProjectReference[]=Array.from({length:51},()=>({id:newId(),resourceType:'task',resourceId:newId(),revision:1,quote:JSON.stringify({title:'批量参考任务',revision:1}),usage:'read'}));
   await env.DB.batch(refs.map(ref=>env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria) VALUES(?1,?2,'批量参考任务','原工作','todo',1,?3,?4,?4,'open','标准')").bind(ref.resourceId,f.projectId,f.owner.userId,now)));
   const batches:number[]=[];
   const db=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{batches.push(statements.length);return target.batch(statements);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
   const counted={...env,DB:db};
   await validateReadReferences(counted,f.projectId,refs.flatMap(ref=>Array.from({length:8},()=>({...ref}))));
   expect(batches).toEqual([50,1]);
   await env.DB.prepare('UPDATE tasks SET revision=2 WHERE id=?1').bind(refs[50]!.resourceId).run();
   await expect(validateReadReferences(counted,f.projectId,refs)).rejects.toThrow('已变化');
 });
 it('never discards a different quote with the same reference ID and rechecks lifecycle on every validation',async()=>{
   const f=await fixture(),s=await source(f);
   await validateReadReferences(env,f.projectId,[s.reference,{...s.reference,quote:'验收原文'}]);
   await expect(validateReadReferences(env,f.projectId,[s.reference,{...s.reference,quote:'伪造的原文'}])).rejects.toThrow('引用不符');
   await env.DB.prepare('UPDATE sources SET deleted_at=?2,lifecycle_version=lifecycle_version+1 WHERE id=?1').bind(s.sourceId,nowIso()).run();
   await expect(validateReadReferences(env,f.projectId,[s.reference,s.reference])).rejects.toThrow('已变化');
 });
 it.each([undefined,'undefined',''])('rejects incomplete source metadata %s before any query',async versionId=>{
   const f=await fixture(),s=await source(f);
   let batches=0;
   const db=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{batches++;return target.batch(statements);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
   await expect(validateReadReferences({...env,DB:db},f.projectId,[{...s.reference,versionId}])).rejects.toThrow('版本信息不完整');
   expect(batches).toBe(0);
 });
 it.each([false,true])('rejects recycled dynamically-read file for automatic=%s with no selected snapshot',async automatic=>{const f=await fixture(),s=await source(f),p=await proposal(f,[s.reference]);await env.DB.prepare("UPDATE files SET deleted_at=?2 WHERE id=?1").bind(s.fileId,nowIso()).run();await expect(applyProposal(env,f.projectId,p.id,1,f.owner.userId,automatic,'cfg-seed-v1')).rejects.toThrow();await untouched(f,p.id);});
 it('applies unchanged source evidence and preserves intentional fixed-version reads',async()=>{const f=await fixture(),s=await source(f);const newerVersionId=newId();await env.DB.batch([env.DB.prepare("INSERT INTO source_versions(id,source_id,project_id,revision,origin,status,created_at) VALUES(?1,?2,?3,2,'paste','ready',?4)").bind(newerVersionId,s.sourceId,f.projectId,nowIso()),env.DB.prepare('UPDATE sources SET current_version_id=?2 WHERE id=?1').bind(s.sourceId,newerVersionId)]);const p=await proposal(f,[s.reference]);expect((await applyProposal(env,f.projectId,p.id,1,f.owner.userId,true,'cfg-seed-v1')).taskIds).toHaveLength(1);});
 it('closes lifecycle deletion race after preflight before batch',async()=>{const f=await fixture(),s=await source(f),p=await proposal(f,[s.reference]);await expect(applyProposal(race(()=>env.DB.prepare('UPDATE sources SET deleted_at=?2,lifecycle_version=lifecycle_version+1 WHERE id=?1').bind(s.sourceId,nowIso()).run()),f.projectId,p.id,1,f.owner.userId,true,'cfg-seed-v1')).rejects.toThrow();await untouched(f,p.id);});
 it('rejects cross-project source and overview references',async()=>{const f=await fixture(),other=await fixture(),s=await source(other),p=await proposal(f,[s.reference]);await expect(applyProposal(env,f.projectId,p.id,1,f.owner.userId)).rejects.toThrow();await expect(validateReadReferences(env,f.projectId,[{id:'foreign-project',resourceType:'project',resourceId:other.projectId,usage:'read'}])).rejects.toThrow('当前项目');await untouched(f,p.id);});
 it('allows explicit owner revision despite obsolete AI evidence, never automatic bypass',async()=>{const f=await fixture(),s=await source(f),p=await proposal(f,[s.reference]);await reviseProposal(env,f.projectId,p.id,1,p.payload,'管理员确认采用人工修正',f.owner.userId);await env.DB.prepare('UPDATE sources SET deleted_at=?2,lifecycle_version=lifecycle_version+1 WHERE id=?1').bind(s.sourceId,nowIso()).run();await expect(applyProposal(env,f.projectId,p.id,2,f.owner.userId,true,'cfg-seed-v1')).rejects.toThrow();const applied=await applyProposal(env,f.projectId,p.id,2,f.owner.userId);expect(applied.taskIds).toHaveLength(1);});
 it('rejects referenced task revision race even when plan does not update that task',async()=>{const f=await fixture(),taskId=newId(),now=nowIso();await env.DB.prepare("INSERT INTO tasks(id,project_id,title,detail,status,revision,created_by,created_at,updated_at,lifecycle_state,criteria) VALUES(?1,?2,'参考任务','原工作','todo',1,?3,?4,?4,'open','标准')").bind(taskId,f.projectId,f.owner.userId,now).run();const refs=referencesFromRead(await executeDiscoveryTool(env,f.projectId,'read_task',{id:taskId})),p=await proposal(f,refs);await expect(applyProposal(race(()=>env.DB.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?1').bind(taskId).run()),f.projectId,p.id,1,f.owner.userId,true,'cfg-seed-v1')).rejects.toThrow();expect((await env.DB.prepare('SELECT COUNT(*) count FROM tasks WHERE project_id=?1').bind(f.projectId).first<{count:number}>())!.count).toBe(1);});
 it('rejects immutable material quote tampering in the preflight-to-commit interval',async()=>{const f=await fixture(),materialId=newId(),versionId=newId(),now=nowIso();await env.DB.batch([
 env.DB.prepare("INSERT INTO materials(id,project_id,title,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,'成果',?3,?4,?5,?5)").bind(materialId,f.projectId,versionId,f.owner.userId,now),
 env.DB.prepare("INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES(?1,?2,?3,1,'{}','可核对证据','manual',?4,?5)").bind(versionId,materialId,f.projectId,f.owner.userId,now)
 ]);const refs=referencesFromRead(await executeDiscoveryTool(env,f.projectId,'read_resource',{resourceType:'material',versionId})),p=await proposal(f,refs);await expect(applyProposal(race(()=>env.DB.prepare("UPDATE material_versions SET markdown='不再包含原引文' WHERE id=?1").bind(versionId).run()),f.projectId,p.id,1,f.owner.userId,true,'cfg-seed-v1')).rejects.toThrow();await untouched(f,p.id);});
 it('revives stale proposals only after owner acknowledges current revision, retaining draft data',async()=>{const f=await fixture(),p=await proposal(f,[]);await env.DB.prepare("UPDATE collaboration_proposals SET status='stale',revision=2 WHERE id=?1").bind(p.id).run();const draft={...p.payload,tasks:p.payload.tasks.map(t=>({...t,effortHours:6,detail:'管理员增加假设与复核条件'}))};await expect(reviseProposal(env,f.projectId,p.id,1,draft,'确认人工修正',f.owner.userId)).rejects.toMatchObject({code:'VERSION_CONFLICT',details:{currentRevision:2}});const revised=await reviseProposal(env,f.projectId,p.id,2,draft,'确认人工修正',f.owner.userId);expect(revised.status).toBe('pending');expect(revised.revision).toBe(3);expect(JSON.parse(revised.payload_json).tasks[0].effortHours).toBe(6);expect((await applyProposal(env,f.projectId,p.id,3,f.owner.userId)).taskIds).toHaveLength(1);});
 it('unrelated manual score events do not stale owner-edited pending drafts',async()=>{const f=await fixture(),p=await proposal(f,[]);await reviseProposal(env,f.projectId,p.id,1,p.payload,'管理员待确认修订',f.owner.userId);await env.DB.prepare("UPDATE jobs SET status='succeeded' WHERE project_id=?1").bind(f.projectId).run();await env.DB.prepare('UPDATE collaboration_proposals SET updated_at=?2 WHERE id=?1').bind(p.id,new Date(Date.now()-60000).toISOString()).run();await env.DB.prepare("INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) VALUES(?1,?2,'user',?3,'assessment.corrected','assessment',?1,?1,'{}',?4)").bind(newId(),f.projectId,f.owner.userId,new Date(Date.now()-30000).toISOString()).run();const offline={...env,AGENT_WORKFLOW:{create:async()=>{throw new Error('offline fixture');}}} as unknown as Env;await dispatchProjectProgression(offline);expect((await env.DB.prepare('SELECT status,revision FROM collaboration_proposals WHERE id=?1').bind(p.id).first())).toEqual({status:'pending',revision:2});expect((await env.DB.prepare('SELECT COUNT(*) count FROM jobs WHERE project_id=?1').bind(f.projectId).first<{count:number}>())!.count).toBe(1);});
 it('accepts paginated admin_feedback references and applies while unchanged',async()=>{const f=await fixture(),id=newId();await env.DB.prepare("INSERT INTO project_admin_feedback(id,project_id,actor_id,target_type,feedback,created_at) VALUES(?1,?2,?3,'project','先补验证',?4)").bind(id,f.projectId,f.owner.userId,nowIso()).run();const refs=referencesFromRead(await executeDiscoveryTool(env,f.projectId,'read_admin_feedback',{}));expect(refs[0]!.resourceType).toBe('admin_feedback');await validateReadReferences(env,f.projectId,refs);const p=await proposal(f,refs);expect((await applyProposal(env,f.projectId,p.id,1,f.owner.userId)).taskIds).toHaveLength(1);});
});
