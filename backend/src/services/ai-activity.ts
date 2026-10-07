import { z } from 'zod';
import type { Env } from '../env';
import { nowIso } from '../core/db';

export const activityCodes = ['preparing','reading_sources','calling_model','executing_tool','validating','repairing','saving','transcribing','summarizing','ocr','retrying','waiting_retry','waiting_input','completed','failed','cancelled'] as const;
export type ActivityCode = typeof activityCodes[number];
export type ActivityProgress = { completed: number; total?: number; unit?: string };
export const activityProgressSchema = z.object({ completed:z.number().int().min(0),total:z.number().int().min(0).optional(),unit:z.enum(['step','tool_call','page','chunk','window']).optional() });
export const aiActivitySchema = z.object({ code:z.enum(activityCodes),updatedAt:z.string().nullable(),lastResponseAt:z.string().nullable(),progress:activityProgressSchema.nullable(),canResume:z.boolean(),resumeReason:z.string().nullable(),uncertain:z.boolean() });
export type AiActivity = z.infer<typeof aiActivitySchema>;
export const aiActivityEventSchema = z.object({id:z.number().int(),code:z.enum(activityCodes),state:z.enum(['started','completed','failed','resumed']),at:z.string(),progress:activityProgressSchema.nullable()});
export const aiActivityEventsSchema = z.object({items:z.array(aiActivityEventSchema),nextCursor:z.number().int().nullable()});
const validCode = (code:string):ActivityCode => activityCodes.includes(code as ActivityCode) ? code as ActivityCode : 'preparing';

/** Only the current live attempt may publish progress or model response metadata. */
const activeGuard = `EXISTS(SELECT 1 FROM jobs WHERE id=?1 AND status IN ('queued','running','waiting_input') AND NOT EXISTS(SELECT 1 FROM admin_ai_retry_links WHERE parent_job_id=?1)) OR EXISTS(SELECT 1 FROM project_creation_drafts WHERE 'draft:'||preview_attempt_id=?1 AND status='active' AND preview_state IN ('queued','running','waiting_input'))`;
export async function recordActivity(env:Pick<Env,'DB'>,targetId:string|undefined,code:string,state:'started'|'completed'|'failed'|'resumed'='started',progress?:ActivityProgress):Promise<void> {
 if(!targetId)return;
 const guard=(state==='failed'||code==='completed')?activeGuard.replace("preview_state IN ('queued','running','waiting_input')","preview_state IN ('queued','running','waiting_input','ready','failed')"):activeGuard;
 const safeCode=validCode(code),now=nowIso(),safeProgress=progress?activityProgressSchema.parse(progress):null,encoded=safeProgress?JSON.stringify(safeProgress):null;
 await env.DB.batch([
  env.DB.prepare(`INSERT OR IGNORE INTO ai_task_activities(target_id,code,updated_at) SELECT ?1,?2,?3 WHERE ${guard}`).bind(targetId,safeCode,now),
  // Tool attempts belong to the tool stage, never to a subsequent model/read stage.
  env.DB.prepare(`UPDATE ai_task_activities SET code=?2,updated_at=?3,progress_json=CASE WHEN ?4 IS NOT NULL THEN ?4 WHEN ?2!='executing_tool' AND (json_extract(progress_json,'$.unit')='tool_call' OR (code='executing_tool' AND json_extract(progress_json,'$.unit')='step')) THEN NULL ELSE progress_json END WHERE target_id=?1 AND (${guard})`).bind(targetId,safeCode,now,encoded),
  env.DB.prepare(`INSERT INTO ai_activity_events(target_id,code,state,created_at,progress_json) SELECT ?1,?2,?3,?4,COALESCE(?5,progress_json) FROM ai_task_activities WHERE target_id=?1 AND updated_at=?4 AND (${guard})`).bind(targetId,safeCode,state,now,encoded),
 ]);
}
export async function markModelDispatch(env:Pick<Env,'DB'>,targetId:string|undefined):Promise<void> {
 if(!targetId)return;
 await recordActivity(env,targetId,'calling_model');
 await env.DB.prepare(`UPDATE ai_task_activities SET uncertain=1 WHERE target_id=?1 AND (${activeGuard})`).bind(targetId).run();
}
/** Called after a complete provider body arrives, even if business validation subsequently fails. */
export async function recordModelResponse(env:Pick<Env,'DB'>,targetId:string|undefined):Promise<void> {
 if(!targetId)return;
 const now=nowIso();
 await env.DB.batch([
  env.DB.prepare(`INSERT OR IGNORE INTO ai_task_activities(target_id,code,updated_at) SELECT ?1,'validating',?2 WHERE ${activeGuard}`).bind(targetId,now),
  env.DB.prepare(`UPDATE ai_task_activities SET last_response_at=?2,updated_at=?2,uncertain=0,code='validating' WHERE target_id=?1 AND (${activeGuard})`).bind(targetId,now),
  env.DB.prepare(`INSERT INTO ai_activity_events(target_id,code,state,created_at) SELECT ?1,'calling_model','completed',?2 FROM ai_task_activities WHERE target_id=?1 AND last_response_at=?2 AND (${activeGuard})`).bind(targetId,now),
 ]);
}
export async function clearUncertainDispatch(env:Pick<Env,'DB'>,targetId:string|undefined):Promise<void>{
 if(targetId)await env.DB.prepare(`UPDATE ai_task_activities SET uncertain=0 WHERE target_id=?1 AND (${activeGuard})`).bind(targetId).run();
}
// Include previous attempts without exposing any request payload or private model output.
const chainSql = `WITH RECURSIVE ancestors(id,depth) AS (SELECT ?1,0 UNION ALL SELECT l.parent_job_id,ancestors.depth+1 FROM admin_ai_retry_links l JOIN ancestors ON l.retry_job_id=ancestors.id WHERE ancestors.depth<128)`;
export async function readActivity(env:Pick<Env,'DB'>,targetId:string,status:string):Promise<AiActivity> {
 const current=await env.DB.prepare('SELECT * FROM ai_task_activities WHERE target_id=?1').bind(targetId).first<{code:string;updated_at:string;last_response_at:string|null;progress_json:string|null;uncertain:number}>();
 const previous=await env.DB.prepare(`${chainSql} SELECT MAX(a.last_response_at) AS last_response_at,MAX(a.uncertain) AS uncertain FROM ai_task_activities a JOIN ancestors x ON x.id=a.target_id`).bind(targetId).first<{last_response_at:string|null;uncertain:number|null}>();
 const code=status==='succeeded'||status==='ready'?'completed':status==='waiting_input'?'waiting_input':status==='cancelled'?'cancelled':current?.code??'preparing';
 const canResume=status==='failed';
 return {code:validCode(code),updatedAt:current?.updated_at??null,lastResponseAt:previous?.last_response_at??null,progress:current?.progress_json?activityProgressSchema.parse(JSON.parse(current.progress_json)):null,canResume,resumeReason:canResume?null:status==='waiting_input'?'请先回答待补充问题':null,uncertain:!!current?.uncertain};
}
export async function readActivityEvents(env:Pick<Env,'DB'>,targetId:string,cursor=0,limit=20,order:'asc'|'desc'='asc'){
 const size=Math.min(100,Math.max(1,Math.floor(limit)));
 const descending=order==='desc';
 const rows=await env.DB.prepare(`${chainSql} SELECT e.* FROM ai_activity_events e JOIN ancestors x ON x.id=e.target_id WHERE ${descending?'(?2=0 OR e.id<?2)':'e.id>?2'} ORDER BY e.id ${descending?'DESC':'ASC'} LIMIT ?3`).bind(targetId,cursor,size+1).all<{id:number;code:string;state:'started'|'completed'|'failed'|'resumed';created_at:string;progress_json:string|null}>();
 const items=rows.results.slice(0,size).map(row=>({id:row.id,code:validCode(row.code),state:row.state,at:row.created_at,progress:row.progress_json?activityProgressSchema.parse(JSON.parse(row.progress_json)):null}));
 return {items,nextCursor:rows.results.length>size?items.at(-1)!.id:null};
}
