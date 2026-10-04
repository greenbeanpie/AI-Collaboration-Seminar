import type { Env } from '../env';
import { newId, nowIso } from '../core/db';
import { invalidState, versionConflict } from '../core/errors';
import { bridgeContextStampSql } from './agent-bridge-context';
import { type BridgeResult, type HandoffRow, refreshBridgeHandoff } from './agent-bridges';
import { submissionStatements, submittedResult, validateSubmission } from './collaboration-submission';
import { markdownToDoc } from './tiptap';
import { toSubmission, type Submission } from './collaboration';

export async function adoptBridgeResult(env:Env,row:HandoffRow,userId:string,expectedTaskRevision:number){
 if(row.adopted_submission_id){const existing=await env.DB.prepare('SELECT * FROM task_submissions WHERE id=?1 AND project_id=?2').bind(row.adopted_submission_id,row.project_id).first<Submission>();if(!existing)throw invalidState('已采纳成果的提交记录缺失');return toSubmission(existing);}
 const r=await refreshBridgeHandoff(env,row);if(r.state!=='ready_for_review'||!r.result_json||r.stale)throw invalidState('成果未完成或依据已过期，请人工核对后使用常规提交');
 if(expectedTaskRevision!==r.task_revision)throw versionConflict(r.task_revision);
 const result=JSON.parse(r.result_json) as BridgeResult,id=newId(),materialId=newId(),versionId=newId(),token=newId(),now=nowIso();
 const input={projectId:r.project_id,taskId:r.task_id,userId,expectedRevision:expectedTaskRevision,body:result.summary,materialVersionIds:[versionId]};await validateSubmission(env,input);
 // Admission, material creation and the normal submission are one D1 transaction.
 const admission=env.DB.prepare(`UPDATE agent_bridge_handoffs SET adoption_token=?2,adopted_submission_id=?3,updated_at=?4 WHERE id=?1 AND requested_by=?5 AND state='ready_for_review' AND stale=0 AND adopted_submission_id IS NULL
 AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=agent_bridge_handoffs.task_id AND t.project_id=agent_bridge_handoffs.project_id AND t.revision=?6 AND t.assignee_id=?5 AND t.archived_at IS NULL AND length(trim(t.criteria))>0 AND (t.lifecycle_state IN ('in_progress','improve','rework') OR (t.lifecycle_state IS NULL AND t.status!='done')) AND ${bridgeContextStampSql}=agent_bridge_handoffs.context_stamp AND (SELECT COUNT(*) FROM task_submissions WHERE task_id=t.id)<20)
 AND EXISTS(SELECT 1 FROM project_members WHERE project_id=agent_bridge_handoffs.project_id AND user_id=?5)
 AND NOT EXISTS(SELECT 1 FROM json_each(agent_bridge_handoffs.result_json,'$.artifacts') a WHERE NOT EXISTS(SELECT 1 FROM files f WHERE f.id=json_extract(a.value,'$.fileId') AND f.project_id=agent_bridge_handoffs.project_id AND f.status='available' AND f.deleted_at IS NULL AND f.sha256=json_extract(a.value,'$.sha256') AND f.size_bytes=json_extract(a.value,'$.sizeBytes')))`)
 .bind(r.id,token,id,now,userId,expectedTaskRevision);
 // Token/id are server UUIDs, used as SQL literals only; no user input interpolation.
 const guard=`EXISTS(SELECT 1 FROM agent_bridge_handoffs WHERE id='${r.id}' AND adoption_token='${token}' AND adopted_submission_id='${id}')`;
 const statements=[admission,
 env.DB.prepare(`INSERT INTO materials(id,project_id,title,kind,purpose,current_version_id,revision,created_by,created_at,updated_at) SELECT ?1,?2,'Agent成果草稿','document','output',?3,1,?4,?5,?5 WHERE ${guard}`).bind(materialId,r.project_id,versionId,userId,now),
 env.DB.prepare(`INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at,attachments_json) SELECT ?1,?2,?3,1,?4,?5,'ai_adoption',?6,?7,?8 WHERE ${guard}`).bind(versionId,materialId,r.project_id,JSON.stringify(markdownToDoc(result.summary)),result.summary,userId,now,JSON.stringify(result.artifacts.map(a=>({fileId:a.fileId,name:a.name})))),
 ...submissionStatements(env,input,id,now,guard)];
 const results=await env.DB.batch(statements);if(!results[0]!.meta.changes){const current=await env.DB.prepare('SELECT adopted_submission_id FROM agent_bridge_handoffs WHERE id=?1').bind(r.id).first<{adopted_submission_id:string|null}>();if(current?.adopted_submission_id){const existing=await env.DB.prepare('SELECT * FROM task_submissions WHERE id=?1').bind(current.adopted_submission_id).first<Submission>();if(existing)return toSubmission(existing);}throw invalidState('任务、标准、输入或提交权限已变化');}
 if(!results[3]!.meta.changes)throw invalidState('成果资料已保存但提交未完成，请核对');
 return submittedResult(env,r.project_id,id,userId);
}
