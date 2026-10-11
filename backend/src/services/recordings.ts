import type { Env } from '../env';
import type { CreateRecordingSession,RecordingSession,RecordingSegment,RegisterRecordingSegment,CompleteRecordingSession } from '../../../shared/recordings';
import {newId,nowIso} from '../core/db';
import {invalidState,notFound,permissionDenied,validationFailed} from '../core/errors';
import {ensureFileProcessing} from './file-processing';
import {fileManageSql} from './task-files';
import {loadAiConfig} from '../ai/config';
import {createJobAndDispatch} from './jobs';
import {parsePaging,nextCursor} from '../core/pagination';

type Row={id:string;project_id:string;created_by:string;client_session_id:string;material_id:string;title:string;kind:RecordingSession['kind'];status:RecordingSession['status'];processing_status:RecordingSession['processingStatus'];segment_count:number;summary_revision:number;summary_job_id:string|null;created_at:string;updated_at:string;interruptions_json:string;contributor_ids_json:string;archived_at:string|null;revision:number};
export const sessionView=(r:Row):RecordingSession=>({sessionId:r.id,clientSessionId:r.client_session_id,materialId:r.material_id,title:r.title,kind:r.kind,status:r.status,processingStatus:r.processing_status,segmentCount:r.segment_count,summaryRevision:r.summary_revision,createdAt:r.created_at,updatedAt:r.updated_at});
export async function recordingRow(env:Env,projectId:string,id:string,actorId?:string):Promise<Row>{
 const r=await env.DB.prepare(`SELECT r.*,m.archived_at,m.revision FROM recording_sessions r JOIN materials m ON m.id=r.material_id WHERE r.id=?1 AND r.project_id=?2`).bind(id,projectId).first<Row>();
 if(!r)throw notFound('录制会话不存在');
 if(actorId&&r.created_by!==actorId)throw permissionDenied('仅录制创建者可以上传或重试');
 return r;
}
export async function createRecording(env:Env,projectId:string,actorId:string,b:CreateRecordingSession):Promise<RecordingSession>{
 const ids=[...new Set(b.contributorIds??[actorId])];
 if(ids.length&&!await env.DB.prepare(`SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM json_each(?1) wanted WHERE NOT EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=wanted.value))`).bind(JSON.stringify(ids),projectId).first())throw validationFailed('贡献人必须属于本项目');
 const existing=await env.DB.prepare(`SELECT id FROM recording_sessions WHERE project_id=?1 AND created_by=?2 AND client_session_id=?3`).bind(projectId,actorId,b.clientSessionId).first<{id:string}>();
 if(existing){const r=await recordingRow(env,projectId,existing.id);if(r.title!==b.title||r.kind!==b.kind||r.contributor_ids_json!==JSON.stringify(ids))throw invalidState('本地会话标识已用于其他录制');return sessionView(r);}
 const id=newId(),material=newId(),version=newId(),now=nowIso(),doc={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'录制资料：尚未完成上传与处理。'}]}]};
 try { await env.DB.batch([
 env.DB.prepare(`INSERT INTO materials(id,project_id,title,kind,purpose,current_version_id,created_by,created_at,updated_at) VALUES(?1,?2,?3,'recording',?4,?5,?6,?7,?7)`).bind(material,projectId,b.title,b.purpose??'reference',version,actorId,now),
 env.DB.prepare(`INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) VALUES(?1,?2,?3,1,?4,?5,'manual',?6,?7)`).bind(version,material,projectId,JSON.stringify(doc),'录制资料：尚未完成上传与处理。',actorId,now),
 env.DB.prepare(`INSERT INTO recording_sessions(id,project_id,created_by,client_session_id,material_id,title,kind,contributor_ids_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)`).bind(id,projectId,actorId,b.clientSessionId,material,b.title,b.kind,JSON.stringify(ids),now)]); } catch (error) {
 const raced=await env.DB.prepare('SELECT id FROM recording_sessions WHERE project_id=?1 AND created_by=?2 AND client_session_id=?3').bind(projectId,actorId,b.clientSessionId).first<{id:string}>();
 if(raced)return createRecording(env,projectId,actorId,b);
 throw error;
 }
 return sessionView(await recordingRow(env,projectId,id));
}
export async function recordingSegments(env:Env,id:string,after=-1,limit=50):Promise<RecordingSegment[]>{
 const rows=await env.DB.prepare(`SELECT g.*,CASE WHEN f.deleted_at IS NOT NULL OR s.deleted_at IS NOT NULL THEN 'unavailable' WHEN f.archived_at IS NOT NULL OR m.archived_at IS NOT NULL THEN 'archived' ELSE COALESCE(p.summary_status,'pending') END status,COALESCE(p.summary_error,v.parse_error) error FROM recording_segments g JOIN recording_sessions r ON r.id=g.session_id JOIN materials m ON m.id=r.material_id JOIN sources s ON s.id=g.source_id JOIN files f ON f.id=g.file_id JOIN source_versions v ON v.id=g.source_version_id LEFT JOIN source_processing p ON p.source_version_id=g.source_version_id WHERE g.session_id=?1 AND g.sequence>?2 ORDER BY g.sequence LIMIT ?3`).bind(id,after,Math.min(101,limit)).all<{sequence:number;file_id:string;source_id:string;source_version_id:string;start_ms:number;end_ms:number;sha256:string;status:string;error:string|null;interruptions_json:string}>();
 return rows.results.map(r=>({sequence:r.sequence,fileId:r.file_id,sourceId:r.source_id,sourceVersionId:r.source_version_id,startMs:r.start_ms,endMs:r.end_ms,sha256:r.sha256,status:r.status,error:r.error,interruptions:JSON.parse(r.interruptions_json)}));
}
export async function registerSegment(env:Env,projectId:string,id:string,actorId:string,sequence:number,b:RegisterRecordingSegment){
 const r=await recordingRow(env,projectId,id,actorId);
 const existing=(await recordingSegments(env,id,sequence-1,1))[0];
 if(existing?.sequence===sequence){if(existing.fileId!==b.fileId||existing.startMs!==b.startMs||existing.endMs!==b.endMs||existing.sha256!==b.sha256||JSON.stringify(existing.interruptions)!==JSON.stringify(b.interruptions??[]))throw invalidState('片段序号已经登记其他内容');return existing;}
 if(r.status!=='uploading'||r.archived_at)throw invalidState('录制已冻结或归档');
 if(b.endMs<b.startMs||b.endMs-b.startMs>305_000)throw validationFailed('片段时间范围无效或超过五分钟');
 const f=await env.DB.prepare(`SELECT f.*,m.purpose FROM files f JOIN materials m ON m.id=?4 WHERE f.id=?1 AND f.project_id=?2 AND f.status='available' AND f.deleted_at IS NULL AND f.archived_at IS NULL AND ${fileManageSql('?2','?3','f')}`).bind(b.fileId,projectId,actorId,r.material_id).first<{id:string;ext:string;sha256:string;size_bytes:number;lifecycle_version:number;purpose:string}>();
 if(!f||f.sha256!==b.sha256||!f.size_bytes||f.size_bytes>50*1024*1024)throw invalidState('原文件不可用或校验值不匹配');
 const allowed=r.kind==='photo'?['.jpg','.jpeg','.png','.webp']:r.kind==='audio'?['.wav','.m4a','.mp3']:['.mp4','.webm'];
 if(!allowed.includes(f.ext))throw validationFailed('片段格式与录制类型不匹配');
 await env.DB.prepare('UPDATE files SET processing_purpose=?2 WHERE id=?1').bind(b.fileId,f.purpose).run();
 // Create a source even without a model; the original remains a valid saved recording.
 const bound=await env.DB.prepare(`SELECT s.id source_id,v.id source_version_id FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE v.file_id=?1 AND s.deleted_at IS NULL AND s.current_version_id=v.id ORDER BY s.created_at LIMIT 1`).bind(b.fileId).first<{source_id:string;source_version_id:string}>();
 const sid=bound?.source_id??newId(),vid=bound?.source_version_id??newId(),now=nowIso();
 const guard=`EXISTS(SELECT 1 FROM recording_sessions r JOIN materials m ON m.id=r.material_id WHERE r.id=?1 AND r.status='uploading' AND m.archived_at IS NULL) AND EXISTS(SELECT 1 FROM files WHERE id=?3 AND lifecycle_version=?10 AND deleted_at IS NULL AND archived_at IS NULL) AND NOT EXISTS(SELECT 1 FROM recording_segments WHERE session_id=?1 AND (sequence=?2 OR file_id=?3 OR (start_ms<?6 AND end_ms>?5)))`;
 const binds=[id,sequence,b.fileId,sid,b.startMs,b.endMs,vid,b.sha256,JSON.stringify(b.interruptions??[]),f.lifecycle_version];
 const result=await env.DB.batch([
 env.DB.prepare(`INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at,purpose) SELECT ?4,?11,'file',?12,?7,?13,?14,?14,?15 WHERE ${guard} ON CONFLICT DO NOTHING`).bind(...binds,projectId,`${r.title} · ${sequence}`,actorId,now,f.purpose),
 env.DB.prepare(`INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,status,created_at) SELECT ?7,?4,?11,1,'file',?3,'pending',?12 WHERE ${guard} ON CONFLICT DO NOTHING`).bind(...binds,projectId,now),
 env.DB.prepare(`INSERT INTO recording_segments(session_id,sequence,file_id,source_id,start_ms,end_ms,source_version_id,sha256,interruptions_json,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?11 WHERE ${guard}`).bind(...binds,now),
 ]);
 if(!result[2]?.meta.changes)throw invalidState('片段冲突或会话/文件状态已变化');
 await env.DB.prepare(`UPDATE recording_sessions SET segment_count=(SELECT COUNT(*) FROM recording_segments WHERE session_id=?1),updated_at=?2 WHERE id=?1`).bind(id,now).run();
 return (await recordingSegments(env,id,sequence-1,1))[0]!;
}
export async function completeRecording(env:Env,projectId:string,id:string,actorId:string,b:CompleteRecordingSession){
 const r=await recordingRow(env,projectId,id,actorId);
 if(r.archived_at)throw invalidState('录制已归档');
 if(r.status==='complete'){if(r.segment_count!==b.segmentCount||r.interruptions_json!==JSON.stringify(b.interruptions??[]))throw invalidState('已完成会话不可修改');return sessionView(r);}
 const changed=await env.DB.prepare(`UPDATE recording_sessions SET status='complete',interruptions_json=?3,segment_count=?2,updated_at=?4 WHERE id=?1 AND status='uploading' AND EXISTS(SELECT 1 FROM materials WHERE id=material_id AND archived_at IS NULL) AND (SELECT COUNT(*) FROM recording_segments WHERE session_id=?1)=?2 AND (SELECT MAX(sequence) FROM recording_segments WHERE session_id=?1)=?2 AND (SELECT MIN(sequence) FROM recording_segments WHERE session_id=?1)=1`).bind(id,b.segmentCount,JSON.stringify(b.interruptions??[]),nowIso()).run();
 if(!changed.meta.changes)throw invalidState('片段缺失或会话已变化');
 const version=newId(),now=nowIso(),markdown=`录制资料已保存，共 ${b.segmentCount} 个片段。识别或汇总状态请查看会议详情；此处不包含逐字转写。`,doc={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:markdown}]}]};
 await env.DB.batch([
 env.DB.prepare(`INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at) SELECT ?1,m.id,m.project_id,2,?2,?3,'manual',?4,?5 FROM materials m WHERE m.id=?6 AND m.revision=1 AND m.archived_at IS NULL AND EXISTS(SELECT 1 FROM recording_sessions WHERE id=?7 AND status='complete')`).bind(version,JSON.stringify(doc),markdown,actorId,now,r.material_id,id),
 env.DB.prepare(`UPDATE materials SET revision=2,current_version_id=?1,updated_at=?2 WHERE id=?3 AND revision=1 AND EXISTS(SELECT 1 FROM material_versions WHERE id=?1)`).bind(version,now,r.material_id)
 ]);
 await processRecording(env,id,false);
 return sessionView(await recordingRow(env,projectId,id));
}
export async function listRecordings(env:Env,projectId:string,q:{cursor?:string;limit?:string;materialId?:string}){
 const p=parsePaging(q),rows=await env.DB.prepare(`SELECT r.*,m.archived_at,m.revision FROM recording_sessions r JOIN materials m ON m.id=r.material_id WHERE r.project_id=?1 AND (?2 IS NULL OR material_id=?2) AND (?3 IS NULL OR r.created_at<?3 OR (r.created_at=?3 AND r.id<?4)) ORDER BY r.created_at DESC,r.id DESC LIMIT ?5`).bind(projectId,q.materialId??null,p.cursor?.createdAt??null,p.cursor?.id??null,p.limit+1).all<Row>();
 const items=rows.results.slice(0,p.limit),last=items.at(-1);return {items:items.map(sessionView),nextCursor:nextCursor(rows.results.length>p.limit,last?{createdAt:last.created_at,id:last.id}:undefined)??null};
}
export async function processRecording(env:Env,id:string,retry:boolean){
 const raw=await env.DB.prepare('SELECT project_id FROM recording_sessions WHERE id=?1').bind(id).first<{project_id:string}>();if(!raw)return;
 const r=await recordingRow(env,raw.project_id,id);if(r.archived_at||r.status!=='complete')return;
 const config=await loadAiConfig(env.DB),project=await env.DB.prepare(`SELECT ai_collaboration_enabled,status FROM projects WHERE id=?1`).bind(r.project_id).first<{ai_collaboration_enabled:number;status:string}>();
 if(!config?.enabled||!project?.ai_collaboration_enabled||project.status!=='active'){await env.DB.prepare(`UPDATE recording_sessions SET processing_status='unconfigured' WHERE id=?1`).bind(id).run();return;}
 // Bound work per scheduled tick; unattempted sources are continued by the next tick.
 const pending=await env.DB.prepare(`SELECT g.file_id FROM recording_segments g LEFT JOIN file_processing b ON b.file_id=g.file_id LEFT JOIN source_processing sp ON sp.source_version_id=g.source_version_id JOIN files f ON f.id=g.file_id WHERE g.session_id=?1 AND f.deleted_at IS NULL AND f.archived_at IS NULL AND (b.attempted IS NULL OR b.attempted=0 OR (?2=1 AND (b.error IS NOT NULL OR sp.summary_status IN ('failed','cancelled')))) ORDER BY g.sequence LIMIT 5`).bind(id,retry?1:0).all<{file_id:string}>();
 for(const g of pending.results){try{await ensureFileProcessing(env,r.project_id,g.file_id,r.created_by,{automatic:!retry,retry});}catch{/* File/source processing reports its own error without losing the original. */}}
 const progress=await env.DB.prepare(`SELECT COUNT(*) n,SUM(CASE WHEN p.summary_status='ready' AND v.status!='failed' AND f.deleted_at IS NULL AND f.archived_at IS NULL AND s.deleted_at IS NULL THEN 1 ELSE 0 END) ready,SUM(CASE WHEN p.summary_status IN ('failed','cancelled') OR v.status='failed' OR f.deleted_at IS NOT NULL OR f.archived_at IS NOT NULL OR s.deleted_at IS NOT NULL THEN 1 ELSE 0 END) failed FROM recording_segments g JOIN sources s ON s.id=g.source_id JOIN files f ON f.id=g.file_id JOIN source_versions v ON v.id=g.source_version_id LEFT JOIN source_processing p ON p.source_version_id=g.source_version_id WHERE g.session_id=?1`).bind(id).first<{n:number;ready:number;failed:number}>();
 if(!progress||progress.n!==progress.ready+progress.failed){await env.DB.prepare(`UPDATE recording_sessions SET processing_status='running' WHERE id=?1`).bind(id).run();return;}
 if(r.summary_job_id&&!retry)return;
 const job=newId(),revision=r.summary_revision+1;
 const claim=await env.DB.prepare(`UPDATE recording_sessions SET summary_revision=?2,summary_job_id=?3,processing_status='running',updated_at=?4 WHERE id=?1 AND summary_revision=?5 AND (summary_job_id IS NULL OR (?6=1 AND NOT EXISTS(SELECT 1 FROM jobs WHERE id=summary_job_id AND status IN ('queued','running','waiting_input'))))`).bind(id,revision,job,nowIso(),r.summary_revision,retry?1:0).run();
 if(!claim.meta.changes)return;
 await createJobAndDispatch(env,{projectId:r.project_id,kind:'agent_run',jobId:job,createdBy:r.created_by,input:{operation:'recording.summary',recordingSessionId:id,summaryRevision:revision,materialRevision:r.revision,configVersionId:config.id}});
}
export async function backfillRecordings(env:Env){const rows=await env.DB.prepare(`SELECT id FROM recording_sessions WHERE status='complete' AND processing_status IN ('pending','running','unconfigured') ORDER BY updated_at LIMIT 5`).all<{id:string}>();for(const r of rows.results)await processRecording(env,r.id,false);}
