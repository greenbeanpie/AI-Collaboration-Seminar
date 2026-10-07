import type { Env } from '../env';
import { invalidState } from '../core/errors';
import { type CollaborationTask, type Submission, toSubmission } from './collaboration';
import { readTaskSummaries } from './task-summary';
import { sourceLifecycleGuard } from './source-lifecycle';

/** Project-scoped page hydration: query count is independent of tasks/citations per page. */
export async function readTaskPage(env: Env, tasks: CollaborationTask[]) {
  if (!tasks.length) return new Map();
  const projectId = tasks[0]!.project_id;
  if (tasks.some(task=>task.project_id!==projectId)) throw invalidState('任务必须属于同一项目');
  const ids = JSON.stringify(tasks.map(task=>task.id));
  const citations = tasks.map(task=>JSON.parse(task.source_citations_json || '[]') as Array<{sourceVersionId:string}>);
  const versionIds = JSON.stringify([...new Set(citations.flat().map(cite=>cite.sourceVersionId))]);
  const [dependencies,reviews,sources,summaries] = await Promise.all([
    env.DB.prepare(`SELECT d.task_id,d.depends_on_task_id,t.status FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id AND t.project_id=d.project_id WHERE d.project_id=?1 AND d.task_id IN(SELECT value FROM json_each(?2)) ORDER BY d.depends_on_task_id`).bind(projectId,ids).all<{task_id:string;depends_on_task_id:string;status:string}>(),
    env.DB.prepare(`SELECT t.id FROM tasks t JOIN task_submissions s ON s.id=t.current_submission_id AND s.task_id=t.id AND s.project_id=t.project_id WHERE t.project_id=?1 AND t.id IN(SELECT value FROM json_each(?2)) AND t.status='done' AND t.lifecycle_state='accepted' AND s.status='accept' AND json_extract(s.ai_report_json,'$.humanReview.status')='pending'`).bind(projectId,ids).all<{id:string}>(),
    env.DB.prepare(`SELECT v.id,s.deleted_at,${sourceLifecycleGuard('v.id','NULL')} available FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE v.project_id=?1 AND s.project_id=?1 AND v.id IN(SELECT value FROM json_each(?2))`).bind(projectId,versionIds).all<{id:string;deleted_at:string|null;available:number}>(),
    readTaskSummaries(env,tasks),
  ]);
  const byTask = new Map<string,typeof dependencies.results>();
  for (const row of dependencies.results) {const entries=byTask.get(row.task_id)??[];entries.push(row);byTask.set(row.task_id,entries);}
  const pending = new Set(reviews.results.map(row=>row.id));
  const availability = new Map(sources.results.map(row=>[row.id,row]));
  return new Map(tasks.map((task,index)=> {
    const edges=byTask.get(task.id)??[];
    return [task.id,{...summaries.get(task.id)!,pendingHumanReview:pending.has(task.id),dependsOnTaskIds:edges.map(row=>row.depends_on_task_id),unfinishedDependencyIds:edges.filter(row=>row.status!=='done').map(row=>row.depends_on_task_id),citations:citations[index]!.map(cite=>{
      const source=availability.get(cite.sourceVersionId);
      return {...cite,...(source?.available?{}:{availability:'unavailable' as const,deletedAt:source?.deleted_at??null})};
    })}];
  }));
}

export async function readSubmissionPage(env: Env, projectId: string, rows: Submission[]) {
  const ids=[...new Set(rows.flatMap(row=>JSON.parse(row.material_versions_json) as string[]))];
  const versions=ids.length?await env.DB.prepare(`SELECT v.id AS versionId,m.id AS materialId,m.title,v.revision FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE m.project_id=?1 AND v.id IN(SELECT value FROM json_each(?2)) ORDER BY v.id`).bind(projectId,JSON.stringify(ids)).all<{versionId:string;materialId:string;title:string;revision:number}>():{results:[]};
  const byId=new Map(versions.results.map(version=>[version.versionId,version]));
  return rows.map(row=>({...toSubmission(row),materialVersions:[...new Set(JSON.parse(row.material_versions_json) as string[])].sort().flatMap(id=>{const version=byId.get(id);return version?[version]:[];})}));
}
