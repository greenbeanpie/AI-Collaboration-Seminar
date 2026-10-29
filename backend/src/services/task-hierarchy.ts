import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { notFound, validationFailed, versionConflict } from '../core/errors';
import { projectPermissionSql, requireProjectPermission } from './project-permissions';
import { graphSnapshot, projectGoal, validateTaskGraph, type DependencyEdge } from './project-simplification';
import { readinessStatements } from './task-readiness';

export function uniqueEdges(edges: DependencyEdge[]): DependencyEdge[] {
  return [...new Map(edges.map(edge => [edge.taskId + ':' + edge.dependsOnTaskId, edge])).values()];
}
export async function changeTaskParent(env: Env, projectId: string, actorId: string, taskId: string, parentTaskId: string | null, expectedGraphRevision: number) {
  await requireProjectPermission(env, projectId, actorId, 'taskManage');
  const goal = await projectGoal(env, projectId);
  if (goal.graphRevision !== expectedGraphRevision) throw versionConflict(goal.graphRevision);
  const graph = await graphSnapshot(env, projectId);
  if (!graph.taskIds.includes(taskId)) throw notFound('任务不存在');
  if (parentTaskId && (!graph.taskIds.includes(parentTaskId) || parentTaskId === taskId)) throw validationFailed('父任务必须是本项目其他有效任务');
  const old = await env.DB.prepare('SELECT parent_task_id FROM tasks WHERE id=?1 AND project_id=?2').bind(taskId, projectId).first<{parent_task_id:string|null}>();
  const manual = await env.DB.prepare('SELECT 1 FROM task_dependencies WHERE task_id=?1 AND depends_on_task_id=?2 AND manual_origin=1').bind(old?.parent_task_id??'', taskId).first();
  const edges = graph.edges.filter(edge => manual || edge.taskId !== old?.parent_task_id || edge.dependsOnTaskId !== taskId);
  if (parentTaskId) edges.push({taskId:parentTaskId,dependsOnTaskId:taskId});
  validateTaskGraph(graph.taskIds, uniqueEdges(edges));
  const token = newId();
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE project_goals SET graph_revision=graph_revision+1,graph_token=?3 WHERE project_id=?1 AND graph_revision=?2 AND ${projectPermissionSql('?1','?4','taskManage')}`).bind(projectId,expectedGraphRevision,token,actorId),
    env.DB.prepare('UPDATE tasks SET parent_task_id=?3,revision=revision+1,updated_at=?4 WHERE project_id=?1 AND id=?2 AND archived_at IS NULL AND EXISTS(SELECT 1 FROM project_goals WHERE project_id=?1 AND graph_token=?5)').bind(projectId,taskId,parentTaskId,nowIso(),token),
    ...readinessStatements(env, projectId, [], [taskId,...(old?.parent_task_id?[old.parent_task_id]:[]),...(parentTaskId?[parentTaskId]:[])]),
  ]);
  if (!result[0]?.meta.changes) throw versionConflict((await projectGoal(env,projectId)).graphRevision);
  return {taskId,parentTaskId,graphRevision:expectedGraphRevision+1};
}

export type FocusCandidate = {taskId:string;assigneeId:string|null;status:string;lifecycleState:string|null;dueDate:string|null;duePrecision?:string;pendingHumanReview?:boolean;dependsOnTaskIds:string[]};
export function focusTasks<T extends FocusCandidate>(tasks:T[], userId:string, pins:Set<string>, canReview:boolean, now=new Date()) {
  const downstream=new Map<string,number>();
  for(const task of tasks.filter(task=>task.status!=='done')) for(const id of task.dependsOnTaskIds) downstream.set(id,(downstream.get(id)??0)+1);
  // Project date-only deadlines use the application's Asia/Singapore calendar.
  const today=new Date(now.getTime()+8*3600000).toISOString().slice(0,10);
  const soon=new Date(now.getTime()+8*3600000+3*86400000).toISOString().slice(0,10);
  const overdue=(task:T)=>Boolean(task.dueDate&&(task.duePrecision==='datetime'?Date.parse(task.dueDate)<now.getTime():task.dueDate.slice(0,10)<today));
  const dueSoon=(task:T)=>Boolean(task.dueDate&&(task.duePrecision==='datetime'?Date.parse(task.dueDate)<=now.getTime()+3*86400000:task.dueDate.slice(0,10)<=soon));
  const rank=(task:T)=>overdue(task)?0:['improve','rework'].includes(task.lifecycleState??'')?1:dueSoon(task)?2:3;
  const decorate=(task:T)=>({...task,pinned:pins.has(task.taskId),focusReasons:[...(pins.has(task.taskId)?[task.assigneeId===userId?'已置顶':'我关注']:[]),...(task.assigneeId===userId?['由你负责']:[]),...(rank(task)===0?['已逾期']:[]),...(['improve','rework'].includes(task.lifecycleState??'')?[task.lifecycleState==='rework'?'需重做':'需改进']:[]),...(rank(task)===2?['三天内到期']:[]),...((downstream.get(task.taskId)??0)>0?[`${downstream.get(task.taskId)} 项后续任务依赖此项`]:[])]});
  const deadline=(task:T)=>{const value=task.dueDate?Date.parse(task.duePrecision==='datetime'?task.dueDate:task.dueDate.slice(0,10)+'T23:59:59+08:00'):NaN;return Number.isFinite(value)?value:Number.MAX_SAFE_INTEGER;};
  const compare=(a:T,b:T)=>Number(pins.has(b.taskId))-Number(pins.has(a.taskId)) || rank(a)-rank(b) || deadline(a)-deadline(b) || (downstream.get(b.taskId)??0)-(downstream.get(a.taskId)??0) || a.taskId.localeCompare(b.taskId);
  const open=tasks.filter(task=>task.status!=='done'&&task.lifecycleState!=='accepted');
  return {
    items:open.filter(task=>task.lifecycleState!=='submitted'&&(pins.has(task.taskId)||task.assigneeId===userId)).sort(compare).map(decorate),
    waitingReview:tasks.filter(task=>(task.lifecycleState==='submitted'||task.pendingHumanReview)&&task.assigneeId===userId).sort(compare).map(decorate),
    reviewRequired:canReview?tasks.filter(task=>task.lifecycleState==='submitted'||task.pendingHumanReview).sort(compare).map(decorate):[],
  };
}
