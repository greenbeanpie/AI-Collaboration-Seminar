import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { versionConflict } from '../core/errors';
import { projectAdministratorSql, requireProjectAdministrator } from './project-permissions';
export interface FeedbackSnapshot { versionId: string | null; version: number; feedback: string; actorId: string | null; createdAt: string | null }
interface Row { id:string; version:number; feedback:string; actor_id:string|null; created_at:string }
const snapshot=(r:Row|null):FeedbackSnapshot=>r?{versionId:r.id,version:r.version,feedback:r.feedback,actorId:r.actor_id,createdAt:r.created_at}:{versionId:null,version:0,feedback:'',actorId:null,createdAt:null};
export async function currentProjectFeedback(env:Pick<Env,'DB'>,projectId:string):Promise<FeedbackSnapshot>{
 const exists=await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_feedback_versions'").first();
 if(!exists)return {versionId:null,version:0,feedback:'',actorId:null,createdAt:null};
 return snapshot(await env.DB.prepare('SELECT * FROM project_feedback_versions WHERE project_id=?1 ORDER BY version DESC LIMIT 1').bind(projectId).first<Row>());
}
export async function projectFeedbackHistory(env:Env,projectId:string){
 const rows=await env.DB.prepare('SELECT * FROM project_feedback_versions WHERE project_id=?1 ORDER BY version DESC').bind(projectId).all<Row>();return rows.results.map(snapshot);
}
export async function saveProjectFeedback(env:Env,projectId:string,actorId:string,feedback:string,expectedVersion:number){
 // 项目级 AI 协作反馈属于项目管理员动作（owner 或本项目内的平台管理员），不是 owner-only 也不是 teamManage。
 await requireProjectAdministrator(env,projectId,actorId);
 const id=newId();
 const now=nowIso();
 const results=await env.DB.batch([
  env.DB.prepare(`INSERT INTO project_feedback_versions(id,project_id,version,feedback,actor_id,created_at) SELECT ?1,?2,?3+1,?4,?5,?6 WHERE COALESCE((SELECT MAX(version) FROM project_feedback_versions WHERE project_id=?2),0)=?3 AND ${projectAdministratorSql('?2','?5')}`).bind(id,projectId,expectedVersion,feedback,actorId,now),
  env.DB.prepare("INSERT INTO events(id,project_id,actor_type,actor_id,type,entity_type,entity_id,dedup_key,payload_json,occurred_at) SELECT ?1,?2,'user',?3,'collaboration.feedback_saved','project',?2,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM project_feedback_versions WHERE id=?4)").bind(newId(),projectId,actorId,id,JSON.stringify({feedbackVersion:expectedVersion+1,feedbackVersionId:id}),now),
 ]);
 if(!results[0]!.meta.changes)throw versionConflict((await currentProjectFeedback(env,projectId)).version);
 return currentProjectFeedback(env,projectId);
}
export async function feedbackForJob(env:Pick<Env,'DB'>,projectId:string,jobId?:string):Promise<FeedbackSnapshot>{
 if(!jobId)return currentProjectFeedback(env,projectId);
 const job=await env.DB.prepare('SELECT input_json FROM jobs WHERE id=?1 AND project_id=?2').bind(jobId,projectId).first<{input_json:string}>();
 if(!job)return currentProjectFeedback(env,projectId);
 const input=JSON.parse(job.input_json) as {feedbackSnapshot?:FeedbackSnapshot};
 if(input.feedbackSnapshot)return input.feedbackSnapshot;
 const frozen=await currentProjectFeedback(env,projectId);
 await env.DB.prepare("UPDATE jobs SET input_json=json_set(input_json,'$.feedbackSnapshot',json(?3)) WHERE id=?1 AND project_id=?2 AND json_type(input_json,'$.feedbackSnapshot') IS NULL").bind(jobId,projectId,JSON.stringify(frozen)).run();
 const latest=await env.DB.prepare('SELECT input_json FROM jobs WHERE id=?1 AND project_id=?2').bind(jobId,projectId).first<{input_json:string}>();
 return JSON.parse(latest!.input_json).feedbackSnapshot as FeedbackSnapshot;
}
