import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, validationFailed, versionConflict } from '../core/errors';
import { owner } from './collaboration';

export type Goal = { projectId: string; title: string; detail: string; revision: number; graphRevision: number };
export async function projectGoal(env: Env, projectId: string): Promise<Goal> {
  await env.DB.prepare(`INSERT OR IGNORE INTO project_goals(project_id,title,detail,created_at,updated_at) SELECT id,name,description,created_at,updated_at FROM projects WHERE id=?1`).bind(projectId).run();
  const row = await env.DB.prepare('SELECT project_id,title,detail,revision,graph_revision FROM project_goals WHERE project_id=?1').bind(projectId).first<{project_id:string;title:string;detail:string;revision:number;graph_revision:number}>();
  if (!row) throw notFound('项目目标不存在');
  return {projectId:row.project_id,title:row.title,detail:row.detail,revision:row.revision,graphRevision:row.graph_revision};
}
export async function updateGoal(env: Env, projectId:string, actorId:string, input:{expectedRevision:number;title?:string;detail?:string}) {
  await owner(env,projectId,actorId); await projectGoal(env,projectId);
  const changed=await env.DB.prepare(`UPDATE project_goals SET title=COALESCE(?3,title),detail=COALESCE(?4,detail),revision=revision+1,updated_at=?5 WHERE project_id=?1 AND revision=?2 AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?6 AND role='owner')`).bind(projectId,input.expectedRevision,input.title??null,input.detail??null,nowIso(),actorId).run();
  if(!changed.meta.changes) throw invalidState('主目标或权限已变化，请刷新');
  return projectGoal(env,projectId);
}
export type DependencyEdge={taskId:string;dependsOnTaskId:string};
export function validateTaskGraph(taskIds:string[],edges:DependencyEdge[]) {
  const nodes=new Set(taskIds), adjacency=new Map<string,string[]>();
  for(const edge of edges) {
    if(!nodes.has(edge.taskId)||!nodes.has(edge.dependsOnTaskId)||edge.taskId===edge.dependsOnTaskId) throw validationFailed('依赖必须指向本项目其他子任务');
    const list=adjacency.get(edge.taskId)??[];
    if(list.includes(edge.dependsOnTaskId)) throw validationFailed('依赖不可重复');
    list.push(edge.dependsOnTaskId); adjacency.set(edge.taskId,list);
  }
  const degree=new Map(taskIds.map(id=>[id,0])), dependents=new Map<string,string[]>();
  for(const edge of edges){ degree.set(edge.taskId,degree.get(edge.taskId)!+1); const list=dependents.get(edge.dependsOnTaskId)??[];list.push(edge.taskId);dependents.set(edge.dependsOnTaskId,list); }
  const queue=taskIds.filter(id=>degree.get(id)===0); let count=0;
  for(let i=0;i<queue.length;i++){const id=queue[i]!;count++;for(const dependent of dependents.get(id)??[]){const n=degree.get(dependent)!-1;degree.set(dependent,n);if(n===0)queue.push(dependent);}}
  if(count!==nodes.size)throw validationFailed('子任务依赖不能形成循环');
}
export async function graphSnapshot(env:Env,projectId:string){
  const [tasks,edges]=await Promise.all([env.DB.prepare('SELECT id FROM tasks WHERE project_id=?1').bind(projectId).all<{id:string}>(),env.DB.prepare('SELECT task_id,depends_on_task_id FROM task_dependencies WHERE project_id=?1').bind(projectId).all<{task_id:string;depends_on_task_id:string}>()]);
  return {taskIds:tasks.results.map(t=>t.id),edges:edges.results.map(e=>({taskId:e.task_id,dependsOnTaskId:e.depends_on_task_id}))};
}
export async function taskDependencies(env:Env,projectId:string,taskId:string){
  const rows=await env.DB.prepare('SELECT d.depends_on_task_id,t.status FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id AND t.project_id=d.project_id WHERE d.project_id=?1 AND d.task_id=?2 ORDER BY d.depends_on_task_id').bind(projectId,taskId).all<{depends_on_task_id:string;status:string}>();
  return {dependsOnTaskIds:rows.results.map(r=>r.depends_on_task_id),unfinishedDependencyIds:rows.results.filter(r=>r.status!=='done').map(r=>r.depends_on_task_id)};
}
export async function replaceTaskDependencies(env:Env,projectId:string,actorId:string,taskId:string,expectedGraphRevision:number,dependsOnTaskIds:string[]){
  await owner(env,projectId,actorId);const goal=await projectGoal(env,projectId);
  if(goal.graphRevision!==expectedGraphRevision)throw versionConflict(goal.graphRevision);
  const graph=await graphSnapshot(env,projectId);if(!graph.taskIds.includes(taskId))throw notFound('子任务不存在');
  const edges=[...graph.edges.filter(e=>e.taskId!==taskId),...dependsOnTaskIds.map(id=>({taskId,dependsOnTaskId:id}))];validateTaskGraph(graph.taskIds,edges);
  const token=newId(),now=nowIso(),guard='EXISTS(SELECT 1 FROM project_goals WHERE project_id=?1 AND graph_token=?2)';
  const batch=[env.DB.prepare(`UPDATE project_goals SET graph_revision=graph_revision+1,graph_token=?3 WHERE project_id=?1 AND graph_revision=?2 AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?4 AND role='owner')`).bind(projectId,expectedGraphRevision,token,actorId),env.DB.prepare(`DELETE FROM task_dependencies WHERE project_id=?1 AND task_id=?3 AND ${guard}`).bind(projectId,token,taskId)];
  for(const dependency of dependsOnTaskIds)batch.push(env.DB.prepare(`INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,created_at) SELECT ?1,?3,?4,?5 WHERE ${guard}`).bind(projectId,token,taskId,dependency,now));
  const results=await env.DB.batch(batch);if(!results[0]?.meta.changes)throw versionConflict((await projectGoal(env,projectId)).graphRevision);
  return {taskId,...await taskDependencies(env,projectId,taskId),graphRevision:expectedGraphRevision+1};
}

export type RequirementSnapshot={requirementId:string;requirementSetId:string;title:string;detail:string;category:string;dueDate:string|null;duePrecision:string;citations:unknown[]};
export type StandardSnapshot={standardsVersionId:string;projectId:string;version:number;title:string;requirementSetIds:string[];rubricVersionId:string;mappings:Array<{requirementId:string;dimensionKey:string}>;requirements:RequirementSnapshot[];rubric:{rubricVersionId:string;version:number;weights:Array<{key:string;label:string;weight:number}>;notes:string|null}};
export type StandardRow={id:string;project_id:string;version:number;title:string;status:'draft'|'confirmed';requirement_set_ids_json:string;rubric_version_id:string;mappings_json:string;snapshot_json:string|null;revision:number;confirmed_at:string|null;created_at:string;updated_at:string};
export async function buildStandardsSnapshot(env:Env,row:StandardRow):Promise<StandardSnapshot>{
  const ids=JSON.parse(row.requirement_set_ids_json) as string[];
  const sets=await env.DB.prepare('SELECT id FROM requirement_sets WHERE project_id=?1 AND id IN(SELECT value FROM json_each(?2))').bind(row.project_id,JSON.stringify(ids)).all<{id:string}>();
  if(new Set(ids).size!==ids.length||sets.results.length!==ids.length)throw validationFailed('要求集必须属于当前项目且不可重复');
  const requirements=await env.DB.prepare('SELECT id,requirement_set_id,title,detail,category,due_date,due_precision,citations_json FROM requirements WHERE project_id=?1 AND requirement_set_id IN(SELECT value FROM json_each(?2)) ORDER BY requirement_set_id,seq').bind(row.project_id,JSON.stringify(ids)).all<{id:string;requirement_set_id:string;title:string;detail:string;category:string;due_date:string|null;due_precision:string;citations_json:string}>();
  const rubric=await env.DB.prepare('SELECT id,version,weights_json,notes FROM rubric_versions WHERE project_id=?1 AND id=?2').bind(row.project_id,row.rubric_version_id).first<{id:string;version:number;weights_json:string;notes:string|null}>();
  if(!rubric)throw validationFailed('评分维度版本必须属于当前项目');
  const weights=JSON.parse(rubric.weights_json) as StandardSnapshot['rubric']['weights'];
  if(new Set(weights.map(w=>w.key)).size!==weights.length||weights.some(w=>!Number.isFinite(w.weight)||w.weight<0||w.weight>100)||(weights.length>0&&weights.reduce((n,w)=>n+w.weight,0)<=0))throw validationFailed('评分维度不可重复且总权重必须大于零');
  const mappings=JSON.parse(row.mappings_json) as StandardSnapshot['mappings'];
  if(new Set(mappings.map(m=>m.requirementId)).size!==mappings.length||mappings.some(m=>!requirements.results.some(r=>r.id===m.requirementId)||!weights.some(w=>w.key===m.dimensionKey)))throw validationFailed('要求与评分维度关联无效');
  return {standardsVersionId:row.id,projectId:row.project_id,version:row.version,title:row.title,requirementSetIds:ids,rubricVersionId:rubric.id,mappings,requirements:requirements.results.map(r=>({requirementId:r.id,requirementSetId:r.requirement_set_id,title:r.title,detail:r.detail,category:r.category,dueDate:r.due_date,duePrecision:r.due_precision,citations:JSON.parse(r.citations_json)})),rubric:{rubricVersionId:rubric.id,version:rubric.version,weights,notes:rubric.notes}};
}
export async function standardView(env:Env,row:StandardRow){return {...(row.status==='confirmed'&&row.snapshot_json?JSON.parse(row.snapshot_json) as StandardSnapshot:await buildStandardsSnapshot(env,row)),status:row.status,revision:row.revision,confirmedAt:row.confirmed_at,createdAt:row.created_at};}
export async function confirmedStandard(env:Env,projectId:string,id:string){const row=await env.DB.prepare("SELECT * FROM standards_versions WHERE id=?1 AND project_id=?2 AND status='confirmed'").bind(id,projectId).first<StandardRow>();if(!row?.snapshot_json)throw invalidState('请先发布本项目要求与评分标准');return JSON.parse(row.snapshot_json) as StandardSnapshot;}
export type StandardsInput={title?:string;requirementSetIds?:string[];rubricVersionId?:string;mappings?:StandardSnapshot['mappings'];requirements?:Array<{title:string;detail:string;category?:string;dimensionKey?:string;dueDate?:string|null;duePrecision?:string;citations?:Array<{sourceVersionId:string;fragmentId:string;pageNumber:number|null;quote:string}>}>;weights?:StandardSnapshot['rubric']['weights'];notes?:string|null};
export async function saveStandard(env:Env,projectId:string,actorId:string,input:StandardsInput,id?:string,expectedRevision?:number){
  await owner(env,projectId,actorId);const now=nowIso(),newStandardId=id??newId(),batch:D1PreparedStatement[]=[];
  let setIds=input.requirementSetIds,rubricId=input.rubricVersionId,mappings=input.mappings??[];
  const current=id?await env.DB.prepare('SELECT * FROM standards_versions WHERE id=?1 AND project_id=?2').bind(id,projectId).first<StandardRow>():null;
  if(id&&(!current||current.status!=='draft'||current.revision!==expectedRevision))throw invalidState('标准已发布或草稿版本已变化');
  // A full combined edit creates new draft components; confirmed historical components stay immutable.
  const gate=id?`EXISTS(SELECT 1 FROM standards_versions WHERE id=?1 AND project_id=?2 AND status='draft' AND revision=?3) AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id='${actorId.replace(/'/g,"''")}' AND role='owner')`:"EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?3 AND role='owner')";
  const gateArgs=id?[id,projectId,expectedRevision!]:[newStandardId,projectId,actorId];
  if(input.requirements!==undefined&&input.weights!==undefined){
    const setId=newId();rubricId=newId();setIds=[setId];mappings=[];
    batch.push(env.DB.prepare(`INSERT INTO requirement_sets(id,project_id,status,revision,created_at,updated_at) SELECT ?4,?2,'draft',1,?5,?5 WHERE ${gate}`).bind(...gateArgs,setId,now));
    if(new Set(input.weights.map(w=>w.key)).size!==input.weights.length||(input.weights.length>0&&input.weights.reduce((n,w)=>n+w.weight,0)<=0))throw validationFailed('评分维度不可重复且总权重必须大于零');
    for(let i=0;i<input.requirements.length;i++){
      const req=input.requirements[i]!,reqId=newId();
      if(req.dimensionKey){if(!input.weights.some(w=>w.key===req.dimensionKey))throw validationFailed('要求关联的评分维度不存在');mappings.push({requirementId:reqId,dimensionKey:req.dimensionKey});}
      for(const citation of req.citations??[]){const fragment=await env.DB.prepare(`SELECT f.content,f.page_number FROM source_fragments f JOIN source_versions v ON v.id=f.source_version_id JOIN sources s ON s.id=v.source_id WHERE f.id=?1 AND f.source_version_id=?2 AND f.project_id=?3 AND s.deleted_at IS NULL`).bind(citation.fragmentId,citation.sourceVersionId,projectId).first<{content:string;page_number:number|null}>();if(!fragment||fragment.page_number!==citation.pageNumber||!fragment.content.includes(citation.quote))throw validationFailed('要求引文必须来自本项目可用的来源正文');}
      batch.push(env.DB.prepare(`INSERT INTO requirements(id,requirement_set_id,project_id,seq,category,title,detail,due_date,due_precision,citations_json,field_state,updated_at) SELECT ?4,?5,?2,?6,?7,?8,?9,?10,?11,?12,'edited',?13 WHERE ${gate}`).bind(...gateArgs,reqId,setId,i+1,req.category??'deliverable',req.title,req.detail,req.dueDate??null,req.duePrecision??'unknown',JSON.stringify(req.citations??[]),now));
    }
    batch.push(env.DB.prepare(`INSERT INTO rubric_versions(id,project_id,version,source,weights_json,notes,status,created_at) SELECT ?4,?2,1+COALESCE((SELECT MAX(version) FROM rubric_versions WHERE project_id=?2),0),'custom',?5,?6,'draft',?7 WHERE ${gate}`).bind(...gateArgs,rubricId,JSON.stringify(input.weights),input.notes??null,now));
  }
  setIds??=current?JSON.parse(current.requirement_set_ids_json):[];rubricId??=current?.rubric_version_id;
  if(!rubricId)throw validationFailed('请填写评分维度或选择评分版本');
  if(input.requirements===undefined){const fake={...current,id:newStandardId,project_id:projectId,version:current?.version??1,title:input.title??current?.title??'',requirement_set_ids_json:JSON.stringify(setIds),rubric_version_id:rubricId,mappings_json:JSON.stringify(mappings)} as StandardRow;await buildStandardsSnapshot(env,fake);}
  if(id)batch.push(env.DB.prepare(`UPDATE standards_versions SET title=COALESCE(?4,title),requirement_set_ids_json=?5,rubric_version_id=?6,mappings_json=?7,revision=revision+1,updated_at=?8 WHERE id=?1 AND project_id=?2 AND revision=?3 AND status='draft' AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?9 AND role='owner')`).bind(id,projectId,expectedRevision!,input.title??null,JSON.stringify(setIds),rubricId,JSON.stringify(mappings),now,actorId));
  else batch.push(env.DB.prepare(`INSERT INTO standards_versions(id,project_id,version,title,requirement_set_ids_json,rubric_version_id,mappings_json,created_at,updated_at) SELECT ?1,?2,1+COALESCE((SELECT MAX(version) FROM standards_versions WHERE project_id=?2),0),?4,?5,?6,?7,?8,?8 WHERE EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?3 AND role='owner')`).bind(newStandardId,projectId,actorId,input.title??'',JSON.stringify(setIds),rubricId,JSON.stringify(mappings),now));
  const results=await env.DB.batch(batch);if(!results.at(-1)?.meta.changes)throw invalidState('标准草稿或权限已变化');
  return standardView(env,(await env.DB.prepare('SELECT * FROM standards_versions WHERE id=?1').bind(newStandardId).first<StandardRow>())!);
}
export async function confirmStandard(env:Env,projectId:string,actorId:string,id:string,expectedRevision:number){
  await owner(env,projectId,actorId);const row=await env.DB.prepare('SELECT * FROM standards_versions WHERE id=?1 AND project_id=?2').bind(id,projectId).first<StandardRow>();if(!row||row.status!=='draft'||row.revision!==expectedRevision)throw invalidState('标准已发布或草稿版本已变化');
  const snapshot=await buildStandardsSnapshot(env,row),now=nowIso(),raw=JSON.stringify(snapshot);
  const result=await env.DB.batch([
    env.DB.prepare(`UPDATE standards_versions SET status='confirmed',snapshot_json=?4,confirmed_by=?5,confirmed_at=?6,revision=revision+1,updated_at=?6 WHERE id=?1 AND project_id=?2 AND revision=?3 AND status='draft' AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?5 AND role='owner') AND EXISTS(SELECT 1 FROM rubric_versions WHERE id=?7 AND project_id=?2 AND weights_json=?8 AND notes IS ?9) AND NOT EXISTS(SELECT 1 FROM json_each(?4,'$.requirements') r WHERE NOT EXISTS(SELECT 1 FROM requirements q WHERE q.id=json_extract(r.value,'$.requirementId') AND q.project_id=?2 AND q.title=json_extract(r.value,'$.title') AND q.detail=json_extract(r.value,'$.detail') AND q.category=json_extract(r.value,'$.category') AND q.due_date IS json_extract(r.value,'$.dueDate') AND q.due_precision=json_extract(r.value,'$.duePrecision') AND q.citations_json=json_extract(r.value,'$.citations'))) AND (SELECT COUNT(*) FROM requirements WHERE project_id=?2 AND requirement_set_id IN(SELECT value FROM json_each(?4,'$.requirementSetIds')))=json_array_length(?4,'$.requirements')`).bind(id,projectId,expectedRevision,raw,actorId,now,snapshot.rubricVersionId,JSON.stringify(snapshot.rubric.weights),snapshot.rubric.notes),
    env.DB.prepare(`UPDATE requirement_sets SET status='confirmed',confirmed_by=?3,confirmed_at=COALESCE(confirmed_at,?4),revision=revision+1 WHERE project_id=?1 AND status='draft' AND id IN(SELECT value FROM json_each(?2)) AND EXISTS(SELECT 1 FROM standards_versions WHERE id=?5 AND status='confirmed' AND snapshot_json=?6)`).bind(projectId,JSON.stringify(snapshot.requirementSetIds),actorId,now,id,raw),
    env.DB.prepare(`UPDATE requirements SET field_state='confirmed' WHERE project_id=?1 AND requirement_set_id IN(SELECT value FROM json_each(?2)) AND EXISTS(SELECT 1 FROM standards_versions WHERE id=?3 AND status='confirmed' AND snapshot_json=?4)`).bind(projectId,JSON.stringify(snapshot.requirementSetIds),id,raw),
    env.DB.prepare(`UPDATE rubric_versions SET status='confirmed',confirmed_by=?3,confirmed_at=COALESCE(confirmed_at,?4) WHERE project_id=?1 AND id=?2 AND status='draft' AND EXISTS(SELECT 1 FROM standards_versions WHERE id=?5 AND status='confirmed' AND snapshot_json=?6)`).bind(projectId,snapshot.rubricVersionId,actorId,now,id,raw),
  ]);if(!result[0]?.meta.changes)throw invalidState('标准内容或权限已变化，请重新核对');return standardView(env,(await env.DB.prepare('SELECT * FROM standards_versions WHERE id=?1').bind(id).first<StandardRow>())!);
}
