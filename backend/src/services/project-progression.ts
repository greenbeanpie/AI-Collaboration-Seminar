import { currentProjectFeedback } from './project-feedback';
import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { loadAiConfig } from '../ai/config';
import { reserveAiSlot, settleReservation } from './budget';
import { createJobAndDispatch } from './jobs';
import { projectGoal } from './project-simplification';
import type { CollaborationAiInput } from './collaboration-ai';

export async function projectFeedback(env:Env,projectId:string):Promise<unknown[]>{
 const rows=await env.DB.prepare('SELECT target_type,target_id,feedback,created_at FROM project_admin_feedback WHERE project_id=?1 AND target_type!="project" ORDER BY created_at,id').bind(projectId).all();
 return [...rows.results,{target_type:'project',...(await currentProjectFeedback(env,projectId))}];
}
/** Feedback rows are immutable; this stamp detects insertion/removal without loading all text. */
export async function projectFeedbackStamp(env:Env,projectId:string):Promise<string>{
 const row=await env.DB.prepare('SELECT COUNT(*) count,MAX(created_at) latest_at,MAX(id) latest_id FROM project_admin_feedback WHERE project_id=?1').bind(projectId).first();
 return JSON.stringify({row,current:await currentProjectFeedback(env,projectId)});
}
export async function projectFeedbackPreview(env:Env,projectId:string):Promise<unknown[]>{
 const rows=await env.DB.prepare('SELECT id,target_type,target_id,substr(feedback,1,1000) feedback,length(feedback) total_chars,created_at FROM project_admin_feedback WHERE project_id=?1 AND target_type!="project" ORDER BY created_at DESC,id DESC LIMIT 5').bind(projectId).all();
 return rows.results;
}
interface Cursor {observed_event_at:string;observed_event_id:string;pending_job_id:string|null;pending_event_at:string|null;pending_event_id:string|null;updated_at:string}
/** Durable debounced user-event cursor. AI writes never recursively initiate progression. */
export async function dispatchProjectProgression(env:Env):Promise<void>{
 const config=await loadAiConfig(env.DB);if(!config?.enabled)return;
 const projects=await env.DB.prepare("SELECT id,collaboration_revision FROM projects WHERE status='active' AND ai_collaboration_enabled=1").all<{id:string;collaboration_revision:number}>();
 for(const project of projects.results){try{
  let state=await env.DB.prepare('SELECT * FROM project_progression WHERE project_id=?1').bind(project.id).first<Cursor>();
  if(state?.pending_job_id){
   const job=await env.DB.prepare('SELECT status FROM jobs WHERE id=?1').bind(state.pending_job_id).first<{status:string}>();
   if(job&&['queued','running','waiting_input'].includes(job.status))continue;
   if(job){
    await env.DB.prepare(`UPDATE project_progression SET observed_event_at=COALESCE(pending_event_at,observed_event_at),observed_event_id=COALESCE(pending_event_id,observed_event_id),pending_job_id=NULL,pending_event_at=NULL,pending_event_id=NULL,updated_at=?3 WHERE project_id=?1 AND pending_job_id=?2`).bind(project.id,state.pending_job_id,nowIso()).run();
    state=await env.DB.prepare('SELECT * FROM project_progression WHERE project_id=?1').bind(project.id).first<Cursor>();
   }else if(Date.now()-Date.parse(state.updated_at)<120_000)continue;
   else {
    await settleReservation(env,state.pending_job_id,'released');
    await env.DB.prepare('UPDATE project_progression SET pending_job_id=NULL,pending_event_at=NULL,pending_event_id=NULL WHERE project_id=?1 AND pending_job_id=?2').bind(project.id,state.pending_job_id).run();
    state={...state,pending_job_id:null};
   }
  }
  const event=await env.DB.prepare(`SELECT id,occurred_at FROM events WHERE project_id=?1 AND actor_type='user' AND type!='collaboration.proposal_revised' AND (occurred_at>?2 OR (occurred_at=?2 AND id>?3)) ORDER BY occurred_at DESC,id DESC LIMIT 1`).bind(project.id,state?.observed_event_at??'',state?.observed_event_id??'').first<{id:string;occurred_at:string}>();
  if(!event||Date.now()-Date.parse(event.occurred_at)<15_000)continue;
  // An owner-edited pending draft remains reviewable until explicitly applied/replaced.
  // Other progress must not silently invalidate local edits while the owner is saving.
  if(await env.DB.prepare("SELECT 1 FROM collaboration_proposals proposal WHERE proposal.project_id=?1 AND proposal.status='pending' AND EXISTS(SELECT 1 FROM collaboration_proposal_revisions correction WHERE correction.proposal_id=proposal.id AND length(trim(correction.reason))>0)").bind(project.id).first())continue;
  // Existing review is deliberate: a new explicit redo stales it before reaching here.
  const pending=await env.DB.prepare("SELECT updated_at FROM collaboration_proposals WHERE project_id=?1 AND status='pending' ORDER BY updated_at DESC LIMIT 1").bind(project.id).first<{updated_at:string}>();
  if(pending){
   if(event.occurred_at<=pending.updated_at)continue;
   const oldPlans=await env.DB.prepare("SELECT id FROM collaboration_proposals proposal WHERE project_id=?1 AND status='pending' AND updated_at<?2 AND NOT EXISTS(SELECT 1 FROM collaboration_proposal_revisions correction WHERE correction.proposal_id=proposal.id AND length(trim(correction.reason))>0)").bind(project.id,event.occurred_at).all<{id:string}>();
   const token=newId(),changedAt=nowIso();
   await env.DB.batch([
    env.DB.prepare("UPDATE collaboration_proposals SET status='stale',revision=revision+1,updated_at=?2,mutation_token=?4 WHERE project_id=?1 AND status='pending' AND updated_at<?3 AND NOT EXISTS(SELECT 1 FROM collaboration_proposal_revisions correction WHERE correction.proposal_id=collaboration_proposals.id AND length(trim(correction.reason))>0)").bind(project.id,changedAt,event.occurred_at,token),
    ...oldPlans.results.map(plan=>env.DB.prepare("INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) SELECT ?1,?2,'system','project-progression','collaboration.proposal_staled','collaboration',?3,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM collaboration_proposals WHERE id=?3 AND mutation_token=?7)").bind(newId(),project.id,plan.id,event.id,JSON.stringify({causeEventId:event.id,reason:'newer_user_progress'}),changedAt,token))
   ]);
  }
  if(await env.DB.prepare("SELECT 1 FROM jobs WHERE project_id=?1 AND ((status IN ('queued','running','waiting_input') AND json_extract(input_json,'$.operation') LIKE 'collaboration.%') OR (status IN ('queued','running') AND kind IN ('parse_source','ocr_pages','web_fetch')))").bind(project.id).first())continue;
  const member=await env.DB.prepare("SELECT user_id FROM project_members WHERE project_id=?1 AND role='owner' ORDER BY user_id LIMIT 1").bind(project.id).first<{user_id:string}>();if(!member)continue;
  const jobId=newId(),now=nowIso();
  await env.DB.prepare('INSERT INTO project_progression(project_id,updated_at) VALUES(?1,?2) ON CONFLICT(project_id) DO NOTHING').bind(project.id,now).run();
  const claim=await env.DB.prepare(`UPDATE project_progression SET pending_job_id=?4,pending_event_at=?5,pending_event_id=?6,updated_at=?7 WHERE project_id=?1 AND observed_event_at=?2 AND observed_event_id=?3 AND pending_job_id IS NULL`).bind(project.id,state?.observed_event_at??'',state?.observed_event_id??'',jobId,event.occurred_at,event.id,now).run();if(!claim.meta.changes)continue;
  try{
   const goal=await projectGoal(env,project.id);
   const rows=await env.DB.prepare("SELECT id,title,detail,criteria,effort_hours,revision FROM tasks WHERE project_id=?1 AND (lifecycle_state IN ('open','in_progress','improve','rework') OR (lifecycle_state IS NULL AND status!='done')) ORDER BY created_at,id").bind(project.id).all<{id:string;title:string;detail:string;criteria:string;effort_hours:number;revision:number}>();
   const input:CollaborationAiInput={operation:'collaboration.decompose',projectId:project.id,requestedBy:member.user_id,settingsRevision:project.collaboration_revision,configVersionId:config.id,goalSnapshot:goal,goalRevision:goal.revision,graphRevision:goal.graphRevision,progression:true,causeEventId:event.id,brief:'根据最新用户进度、已完成成果和管理员反馈自主推进项目。主动调查全项目资料与任务，并列出、读取相关待审/人工修订/已应用方案与有效评分报告。待审工作不可重复规划，也不可当作已完成；人工修订是当前依据，原AI报告仅作历史对照。完成状态以任务、实际提交和验收记录为准，资料中的完成陈述需核对。仅在确有未覆盖工作或进度变化时新增/调整；没有新变化返回tasks:[],updates:[]。',taskIds:rows.results.map(r=>r.id),tasks:rows.results.map(r=>({taskId:r.id,title:r.title,detail:r.detail,criteria:r.criteria,effortHours:r.effort_hours,revision:r.revision}))};
   await reserveAiSlot(env,{projectId:project.id,jobId,purpose:'assignment_suggest',configVersionId:config.id,maxCalls:24});
   await createJobAndDispatch(env,{projectId:project.id,kind:'agent_run',createdBy:member.user_id,jobId,input});
  }catch(error){
   if(!await env.DB.prepare('SELECT 1 FROM jobs WHERE id=?1').bind(jobId).first()){
    await settleReservation(env,jobId,'released');
    await env.DB.prepare('UPDATE project_progression SET pending_job_id=NULL,pending_event_at=NULL,pending_event_id=NULL WHERE project_id=?1 AND pending_job_id=?2').bind(project.id,jobId).run();
   }
   throw error;
  }
 }catch(error){console.error('[progression] dispatch failed',project.id,error);}}
}
