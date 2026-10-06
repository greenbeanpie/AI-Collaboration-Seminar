import { invalidateResourceIndex } from './resource-index';
import type { Env } from '../env';
import { nowIso,sha256Hex } from '../core/db';
import { invalidState,notFound } from '../core/errors';
import { loadActiveSourceVersion,sourceLifecycleGuard } from './source-lifecycle';
import { setSourceStage } from './source-summary';
import { createJobAndDispatch } from './jobs';

export interface ImportBlock { seq:number;pageNumber:number|null;text:string;headingPath?:string[];warnings?:string[] }
interface Session { id:string;source_version_id:string;project_id:string;actor_id:string;lifecycle_version:number;method:string;status:string;next_batch:number;next_seq:number;total_pages:number|null;processed_pages:number;warnings_json:string }
async function load(env:Env,project:string,user:string,id:string) {
 const s=await env.DB.prepare('SELECT * FROM document_parse_sessions WHERE id=?1 AND project_id=?2 AND actor_id=?3').bind(id,project,user).first<Session>();
 if(!s)throw notFound('解析会话不存在');const member=await env.DB.prepare('SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2').bind(project,user).first();if(!member)throw notFound('项目成员权限已变化');await loadActiveSourceVersion(env,s.source_version_id,s.lifecycle_version);return s;
}
export async function startDocumentImport(env:Env,project:string,user:string,version:string,method:'browser-pdf'|'browser-docx'|'browser-xlsx'|'browser-pptx') {
 const active=await loadActiveSourceVersion(env,version);if(active.projectId!==project)throw notFound('来源不存在');
 const file=await env.DB.prepare('SELECT f.ext FROM files f JOIN source_versions v ON v.file_id=f.id WHERE v.id=?1 AND f.project_id=?2').bind(version,project).first<{ext:string}>();
 if(!file || file.ext!==('.'+method.slice('browser-'.length)))throw invalidState('解析方式与来源文件不符');
 const running=await env.DB.prepare("SELECT 1 FROM jobs WHERE project_id=?1 AND json_extract(input_json,'$.sourceVersionId')=?2 AND status IN ('queued','running')").bind(project,version).first();if(running)throw invalidState('请等待或取消现有解析任务再回退');
 const old=await env.DB.prepare("SELECT id,actor_id,method FROM document_parse_sessions WHERE source_version_id=?1 AND lifecycle_version=?2 AND status IN ('processing','finalizing','partial','complete')").bind(version,active.lifecycleVersion).first<{id:string;actor_id:string;method:string}>();
 if(old){if(old.actor_id!==user||old.method!==method)throw invalidState('此资料有其他解析会话');await env.DB.prepare("UPDATE document_parse_sessions SET status='processing' WHERE id=?1 AND status='partial'").bind(old.id).run();return {sessionId:old.id};}
 const stage=await env.DB.prepare('SELECT text_status FROM source_processing WHERE source_version_id=?1').bind(version).first<{text_status:string}>();if(stage?.text_status==='ready')throw invalidState('已完成正文不能在同一固定版本重写，请保留原版本或创建新来源');
 const id=crypto.randomUUID();await env.DB.prepare('INSERT INTO document_parse_sessions(id,source_version_id,project_id,actor_id,lifecycle_version,method,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)').bind(id,version,project,user,active.lifecycleVersion,method,nowIso()).run();
 await setSourceStage(env,version,'text','processing',null,active.lifecycleVersion);return {sessionId:id};
}
export async function documentImportStatus(env:Env,project:string,user:string,id:string) {const s=await load(env,project,user,id);const stage=await env.DB.prepare('SELECT text_status FROM source_processing WHERE source_version_id=?1').bind(s.source_version_id).first<{text_status:string}>();const missing=await env.DB.prepare("SELECT COUNT(*) n FROM source_pages WHERE source_version_id=?1 AND text_status='none' AND ocr_status!='ok'").bind(s.source_version_id).first<{n:number}>();return {sessionId:s.id,status:s.status,nextBatch:s.next_batch,processedPages:s.processed_pages,warnings:JSON.parse(s.warnings_json),textReady:stage?.text_status==='ready',needsImages:missing?.n??0};}
export async function appendDocumentBatch(env:Env,project:string,user:string,id:string,batch:number,blocks:ImportBlock[]) {
 const s=await load(env,project,user,id);if(s.status!=='processing')throw invalidState('解析会话已结束');
 const digest=await sha256Hex(JSON.stringify(blocks));
 const replay=await env.DB.prepare('SELECT digest FROM document_parse_batches WHERE session_id=?1 AND batch_number=?2').bind(id,batch).first<{digest:string}>();
 if(replay){if(replay.digest!==digest)throw invalidState('同一解析批次内容发生变化');return documentImportStatus(env,project,user,id);}
 if(batch!==s.next_batch)throw invalidState('解析批次乱序，请读取会话进度后继续');
 const statements:D1PreparedStatement[]=[];let seq=s.next_seq;
 for(const block of blocks){
  if(s.method==='browser-pdf' && block.pageNumber===null)throw invalidState('PDF 段落缺少真实页码');
  if(s.method!=='browser-pdf' && block.pageNumber!==null)throw invalidState('Office 文档不提供真实页码');
  if(block.pageNumber!==null)statements.push(env.DB.prepare(`INSERT INTO source_pages(id,source_version_id,project_id,page_number,text_status,updated_at) SELECT ?1,?2,?3,?4,?5,?6 WHERE ${sourceLifecycleGuard('?2','?7')} AND EXISTS(SELECT 1 FROM document_parse_sessions WHERE id=?8 AND next_batch=?9 AND status='processing' AND EXISTS(SELECT 1 FROM project_members WHERE project_id=document_parse_sessions.project_id AND user_id=document_parse_sessions.actor_id)) ON CONFLICT(source_version_id,page_number) DO UPDATE SET text_status=CASE WHEN source_pages.text_status='extracted' THEN 'extracted' ELSE excluded.text_status END,updated_at=excluded.updated_at`).bind(crypto.randomUUID(),s.source_version_id,project,block.pageNumber,block.text.trim()?'extracted':'none',nowIso(),s.lifecycle_version,id,batch));
  if(block.pageNumber!==null)statements.push(env.DB.prepare("INSERT OR IGNORE INTO document_parse_pages(session_id,page_number) SELECT ?1,?2 WHERE EXISTS(SELECT 1 FROM document_parse_sessions WHERE id=?1 AND next_batch=?3 AND status='processing' AND EXISTS(SELECT 1 FROM project_members WHERE project_id=document_parse_sessions.project_id AND user_id=document_parse_sessions.actor_id))").bind(id,block.pageNumber,batch));
  const chars=Array.from(block.text);
  for(let offset=0;offset<chars.length;offset+=600){const text=chars.slice(offset,offset+600).join('');if(!text.trim())continue;
   statements.push(env.DB.prepare(`INSERT INTO source_fragments(id,source_version_id,project_id,page_number,seq,kind,content,created_at,heading_path,extraction_session_id) SELECT ?1,?2,?3,?4,(SELECT COALESCE(MAX(seq),0)+1 FROM source_fragments WHERE source_version_id=?2),'text',?6,?7,?8,?9 WHERE ${sourceLifecycleGuard('?2','?10')} AND EXISTS(SELECT 1 FROM document_parse_sessions WHERE id=?9 AND next_batch=?11 AND status='processing' AND EXISTS(SELECT 1 FROM project_members WHERE project_id=document_parse_sessions.project_id AND user_id=document_parse_sessions.actor_id))`).bind(crypto.randomUUID(),s.source_version_id,project,block.pageNumber,seq++,text,nowIso(),JSON.stringify(block.headingPath??[]),id,s.lifecycle_version,batch));
  }
 }
 const warnings=[...new Set([...JSON.parse(s.warnings_json) as string[],...blocks.flatMap(b=>b.warnings??[])])];
 statements.push(env.DB.prepare(`UPDATE document_parse_sessions SET next_batch=next_batch+1,next_seq=?2,processed_pages=MAX(processed_pages,?3),warnings_json=?4,updated_at=?5 WHERE id=?1 AND next_batch=?6 AND status='processing' AND ${sourceLifecycleGuard('?7','?8')} AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?9 AND user_id=?10)`).bind(id,seq,Math.max(0,...blocks.map(b=>b.pageNumber??0)),JSON.stringify(warnings),nowIso(),batch,s.source_version_id,s.lifecycle_version,project,user));
 statements.push(env.DB.prepare('INSERT INTO document_parse_batches(session_id,batch_number,digest) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM document_parse_sessions WHERE id=?1 AND next_batch=?2+1 AND status=\'processing\')').bind(id,batch,digest));
 try {await env.DB.batch(statements);}catch(error){const replay=await env.DB.prepare('SELECT digest FROM document_parse_batches WHERE session_id=?1 AND batch_number=?2').bind(id,batch).first<{digest:string}>();if(replay?.digest!==digest)throw error;}await invalidateResourceIndex(env,project,{resourceType:'source',versionId:s.source_version_id});return documentImportStatus(env,project,user,id);
}
export async function finishDocumentImport(env:Env,project:string,user:string,id:string,totalPages:number|null,warnings:string[],partial:boolean,interrupted=false) {
 const s=await load(env,project,user,id);if(s.method!=='browser-pdf'&&totalPages!==null)throw invalidState('Office 文档不提供真实页数');if(['complete','partial'].includes(s.status))return documentImportStatus(env,project,user,id);
 if(s.status==='processing'){const claimed=await env.DB.prepare("UPDATE document_parse_sessions SET status='finalizing' WHERE id=?1 AND status='processing' AND next_batch=?2").bind(id,s.next_batch).run();if(!claimed.meta.changes)throw invalidState('解析批次仍在更新，请重新读取进度');}else if(s.status!=='finalizing')throw invalidState('解析会话不可完成');
 const pages=await env.DB.prepare('SELECT COUNT(*) n,MIN(page_number) first,MAX(page_number) last FROM document_parse_pages WHERE session_id=?1').bind(id).first<{n:number;first:number;last:number}>();
 if(s.method==='browser-pdf'&&!interrupted&&(totalPages!==pages?.n||pages?.first!==1||pages?.last!==totalPages)){await env.DB.prepare("UPDATE document_parse_sessions SET status='processing' WHERE id=?1 AND status='finalizing'").bind(id).run();throw invalidState('PDF 页覆盖范围不完整');}
 const merged=[...new Set([...JSON.parse(s.warnings_json) as string[],...warnings, ...(interrupted?['本机解析中断，正文仅部分完成']:[])])];
 const missing=await env.DB.prepare("SELECT COUNT(*) n FROM source_pages WHERE source_version_id=?1 AND text_status='none' AND ocr_status!='ok'").bind(s.source_version_id).first<{n:number}>();
 const size=await env.DB.prepare('SELECT COALESCE(SUM(length(content)),0) n FROM source_fragments WHERE source_version_id=?1').bind(s.source_version_id).first<{n:number}>();
 const emptyOffice=s.method!=='browser-pdf'&&!(size?.n);
 const incomplete=interrupted||!!missing?.n||emptyOffice;
 if(emptyOffice)merged.push('未提取到可读取正文，原文件已保留');
 await env.DB.batch([
  env.DB.prepare(`UPDATE document_parse_sessions SET status=?2,total_pages=?3,warnings_json=?4,updated_at=?5 WHERE id=?1 AND status='finalizing' AND next_batch=?8 AND ${sourceLifecycleGuard('?6','?7')}`).bind(id,partial||incomplete?'partial':'complete',totalPages,JSON.stringify(merged),nowIso(),s.source_version_id,s.lifecycle_version,s.next_batch),
  env.DB.prepare(`UPDATE source_versions SET status=?8,char_count=?2,page_count=?3,extraction_method=?4,extraction_warnings_json=?5,extraction_coverage=?7,parse_error=NULL WHERE id=?1 AND ${sourceLifecycleGuard('?1','?6')}`).bind(s.source_version_id,size?.n??0,totalPages,s.method,JSON.stringify(merged),s.lifecycle_version,partial||incomplete?'partial':'complete',incomplete?'processing':'ready')
 ]);
 await load(env,project,user,id);
 await setSourceStage(env,s.source_version_id,'text',incomplete?'waiting_input':'ready',incomplete?'本机解析未完成，请补充正文':partial?'本机解析仅部分完成':null,s.lifecycle_version);
 return {...await documentImportStatus(env,project,user,id),textReady:!incomplete,needsImages:missing?.n??0};
}
export async function analyzeImportedSource(env:Env,project:string,user:string,version:string) {
 const active=await loadActiveSourceVersion(env,version);if(active.projectId!==project)throw notFound('来源不存在');
 const stage=await env.DB.prepare("SELECT 1 FROM source_processing WHERE source_version_id=?1 AND text_status='ready'").bind(version).first();if(!stage)throw invalidState('正文未完整就绪');
 const jobId=await createJobAndDispatch(env,{projectId:project,createdBy:user,kind:'parse_source',input:{sourceId:active.sourceId,sourceVersionId:version,sourceLifecycleVersion:active.lifecycleVersion,phase:'analyze'}});return {jobId,status:'queued'};
}
