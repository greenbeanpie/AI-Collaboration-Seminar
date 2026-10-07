import type { Env } from '../env';
import { newId, nowIso, sha256Hex } from '../core/db';
import { invalidState, notFound, permissionDenied } from '../core/errors';
import { loadAiConfig } from '../ai/config';
import { discoverableFileSql } from './archive-policy';
import { fileManageSql } from './task-files';
import { createJobAndDispatch } from './jobs';
import { isMediaExtension } from './files';
import { loadActiveSourceVersion } from './source-lifecycle';
import { invalidateResourceIndex } from './resource-index';

export interface FileProcessingView {
 fileId:string;lifecycleVersion:number;sourceId:string|null;sourceVersionId:string|null;jobId:string|null;
 textStatus:string;summaryStatus:string;requirementsStatus:string;error:string|null;materialIds:string[];
 textAvailable:boolean;canProcess:boolean;needsImages:number;textPreview?:string;
}
type FileRow={id:string;project_id:string;lifecycle_version:number;ext:string;original_name:string;uploader_user_id:string;ai_collaboration_enabled:number;can_process:number};
type Binding={source_id:string;source_version_id:string;job_id:string|null;attempted:number;error:string|null};
async function file(env:Env,projectId:string,fileId:string,actorId:string):Promise<FileRow>{
 const row=await env.DB.prepare(`SELECT f.*,p.ai_collaboration_enabled,CASE WHEN ${fileManageSql('?1','?3','f')} THEN 1 ELSE 0 END can_process
 FROM files f JOIN projects p ON p.id=f.project_id WHERE f.id=?2 AND f.project_id=?1 AND f.status='available' AND f.deleted_at IS NULL AND ${discoverableFileSql('f')}
 AND NOT EXISTS(SELECT 1 FROM file_derivations WHERE file_id=f.id)
 AND EXISTS(SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?3)`)
 .bind(projectId,fileId,actorId).first<FileRow>();
 if(!row)throw notFound('文件不可用、已归档或没有项目访问权限');return row;
}
export async function readFileProcessing(env:Env,projectId:string,fileId:string,actorId:string):Promise<FileProcessingView>{
 const f=await file(env,projectId,fileId,actorId);
 const row=await env.DB.prepare(`SELECT b.*,s.purpose,p.text_status,p.summary_status,p.requirements_status,p.summary_error,p.requirements_error,v.parse_error,
 (SELECT COUNT(*) FROM source_pages WHERE source_version_id=b.source_version_id AND text_status='none' AND ocr_status!='ok') needs_images,
 (SELECT GROUP_CONCAT(content,char(10)) FROM (SELECT content FROM source_fragments WHERE source_version_id=b.source_version_id ORDER BY seq LIMIT 5)) preview
 FROM file_processing b LEFT JOIN sources s ON s.id=b.source_id LEFT JOIN source_processing p ON p.source_version_id=b.source_version_id LEFT JOIN source_versions v ON v.id=b.source_version_id WHERE b.file_id=?1 AND b.lifecycle_version=?2`)
 .bind(fileId,f.lifecycle_version).first<Binding & {purpose:string;text_status:string|null;summary_status:string|null;requirements_status:string|null;summary_error:string|null;requirements_error:string|null;parse_error:string|null;needs_images:number;preview:string|null}>();
 const materials=row?await env.DB.prepare('SELECT material_id FROM file_processing_materials WHERE source_version_id=?1').bind(row.source_version_id).all<{material_id:string}>():null;
 return {fileId,lifecycleVersion:f.lifecycle_version,sourceId:row?.source_id??null,sourceVersionId:row?.source_version_id??null,jobId:row?.job_id??null,
 textStatus:row?.text_status??(row?.job_id?'queued':'pending'),summaryStatus:row?.summary_status??'pending',requirementsStatus:row?.purpose==='output'?'skipped':row?.requirements_status??'pending',
 error:row?.error??row?.parse_error??row?.summary_error??row?.requirements_error??null,materialIds:materials?.results.map(m=>m.material_id)??[],
 textAvailable:!!row?.preview?.trim()&&!isMediaExtension(f.ext),canProcess:!!f.can_process,needsImages:row?.needs_images??0,...(row?.preview?{textPreview:row.preview.slice(0,2000)}:{})};
}
export async function ensureFileProcessing(env:Env,projectId:string,fileId:string,actorId:string,options:{expectedLifecycleVersion?:number;retry?:boolean;automatic?:boolean}={}):Promise<FileProcessingView>{
 const f=await file(env,projectId,fileId,actorId);
 if(!f.can_process)throw permissionDenied('需要文件管理权限');
 if(options.expectedLifecycleVersion!==undefined&&options.expectedLifecycleVersion!==f.lifecycle_version)throw invalidState('文件生命周期已变化，请刷新');
 if(!['.pdf','.docx','.xlsx','.pptx','.txt','.md','.png','.jpg','.jpeg','.webp'].includes(f.ext)&&!isMediaExtension(f.ext))throw invalidState('该文件类型暂不支持正文处理');
 const config=await loadAiConfig(env.DB),ai=!!f.ai_collaboration_enabled&&!!config?.enabled;
 if(options.automatic&&!ai)return readFileProcessing(env,projectId,fileId,actorId);
 if(!ai&&(isMediaExtension(f.ext)||['.png','.jpg','.jpeg','.webp'].includes(f.ext)))throw invalidState('图片和音视频识别需要同时启用项目 AI 与模型配置');
 const existing=await env.DB.prepare(`SELECT s.id source_id,v.id source_version_id FROM source_versions v JOIN sources s ON s.id=v.source_id WHERE v.file_id=?1 AND s.deleted_at IS NULL AND s.current_version_id=v.id ORDER BY s.created_at LIMIT 1`).bind(fileId).first<{source_id:string;source_version_id:string}>();
 const sourceId=existing?.source_id??newId(),versionId=existing?.source_version_id??newId(),now=nowIso();
 await env.DB.prepare(`INSERT INTO file_processing(file_id,lifecycle_version,project_id,source_id,source_version_id,updated_at)
 SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM files f WHERE f.id=?1 AND f.lifecycle_version=?2 AND f.deleted_at IS NULL AND ${discoverableFileSql('f')}) ON CONFLICT DO NOTHING`).bind(fileId,f.lifecycle_version,projectId,sourceId,versionId,now).run();
 const b=await env.DB.prepare('SELECT * FROM file_processing WHERE file_id=?1 AND lifecycle_version=?2').bind(fileId,f.lifecycle_version).first<Binding>();
 if(!b)throw invalidState('文件状态已变化');
 await env.DB.batch([
 env.DB.prepare(`INSERT INTO sources(id,project_id,kind,title,current_version_id,created_by,created_at,updated_at,purpose) SELECT ?1,?2,'file',?3,?4,?5,?6,?6,
 CASE WHEN EXISTS(SELECT 1 FROM materials m JOIN material_versions v ON v.id=m.current_version_id,json_each(v.attachments_json) a WHERE m.project_id=?2 AND m.purpose='output' AND json_extract(a.value,'$.fileId')=?7) THEN 'output' ELSE 'reference' END WHERE NOT EXISTS(SELECT 1 FROM sources WHERE id=?1)`).bind(b.source_id,projectId,f.original_name,b.source_version_id,actorId,now,fileId),
 env.DB.prepare(`INSERT INTO source_versions(id,source_id,project_id,revision,origin,file_id,status,created_at) SELECT ?1,?2,?3,1,'file',?4,'pending',?5 WHERE NOT EXISTS(SELECT 1 FROM source_versions WHERE id=?1)`).bind(b.source_version_id,b.source_id,projectId,fileId,now),
 ]);
 await syncFileProcessingText(env,b.source_version_id);
 const active=await env.DB.prepare("SELECT id FROM jobs WHERE json_extract(input_json,'$.sourceVersionId')=?1 AND status IN ('queued','running') LIMIT 1").bind(b.source_version_id).first<{id:string}>();
 if(active)return readFileProcessing(env,projectId,fileId,actorId);
 const state=await env.DB.prepare('SELECT text_status,requirements_status,summary_status FROM source_processing WHERE source_version_id=?1').bind(b.source_version_id).first<{text_status:string;requirements_status:string;summary_status:string}>();
 if(state?.text_status==='ready'&&(!ai||state.requirements_status==='ready'))return readFileProcessing(env,projectId,fileId,actorId);
 const jobId=newId();
 const claim=await env.DB.prepare(`UPDATE file_processing SET attempted=1,job_id=?3,error=NULL,updated_at=?4 WHERE file_id=?1 AND lifecycle_version=?2 AND (attempted=0 OR ?5=1 OR (?6=1 AND EXISTS(SELECT 1 FROM jobs WHERE id=file_processing.job_id AND status='succeeded' AND json_extract(input_json,'$.operation')='source.text'))) AND NOT EXISTS(SELECT 1 FROM jobs WHERE id=file_processing.job_id AND status IN ('queued','running'))`).bind(fileId,f.lifecycle_version,jobId,now,options.retry?1:0,ai?1:0).run();
 if(!claim.meta.changes)return readFileProcessing(env,projectId,fileId,actorId);
 const lifecycle=await loadActiveSourceVersion(env,b.source_version_id);
 const pages=await env.DB.prepare("SELECT COUNT(*) n FROM source_pages WHERE source_version_id=?1 AND image_status='uploaded' AND ocr_status!='ok'").bind(b.source_version_id).first<{n:number}>();
 try{await createJobAndDispatch(env,{projectId,kind:'parse_source',jobId,createdBy:actorId,input:{operation:ai?'file.process':'source.text',sourceId:b.source_id,sourceVersionId:b.source_version_id,sourceLifecycleVersion:lifecycle.lifecycleVersion,phase:pages?.n&&ai?'ocr':state?.text_status==='ready'?'analyze':'extract',fileLifecycleVersion:f.lifecycle_version,configVersionId:config?.id}});}
 catch(error){await env.DB.prepare('UPDATE file_processing SET error=?3 WHERE file_id=?1 AND lifecycle_version=?2 AND job_id=?4').bind(fileId,f.lifecycle_version,error instanceof Error?error.message:'处理任务启动失败',jobId).run();throw error;}
 return readFileProcessing(env,projectId,fileId,actorId);
}

/** Bounded and non-retrying discovery. A failed attempt requires an explicit user retry. */
export async function backfillFileProcessing(env:Env,projectId?:string,limit=20):Promise<void>{
 const rows=await env.DB.prepare(`SELECT f.id,f.project_id,COALESCE((SELECT user_id FROM project_members WHERE project_id=p.id AND role='owner' LIMIT 1),f.uploader_user_id) uploader_user_id FROM files f JOIN projects p ON p.id=f.project_id
 WHERE p.ai_collaboration_enabled=1 AND (?1 IS NULL OR p.id=?1) AND f.status='available' AND f.deleted_at IS NULL AND ${discoverableFileSql('f')}
 AND f.ext IN ('.pdf','.docx','.xlsx','.pptx','.txt','.md','.png','.jpg','.jpeg','.webp','.mp3','.wav','.m4a','.mp4','.webm')
 AND NOT EXISTS(SELECT 1 FROM file_derivations WHERE file_id=f.id)
 AND NOT EXISTS(SELECT 1 FROM source_pages WHERE image_file_id=f.id)
 AND NOT EXISTS(SELECT 1 FROM file_processing b WHERE b.file_id=f.id AND b.lifecycle_version=f.lifecycle_version AND b.attempted=1 AND NOT EXISTS(SELECT 1 FROM jobs j JOIN source_processing sp ON sp.source_version_id=b.source_version_id WHERE j.id=b.job_id AND j.status='succeeded' AND json_extract(j.input_json,'$.operation')='source.text' AND sp.requirements_status='pending'))
 ORDER BY f.created_at LIMIT ?2`).bind(projectId??null,Math.min(100,Math.max(1,limit))).all<{id:string;project_id:string;uploader_user_id:string}>();
 for(const f of rows.results){try{await ensureFileProcessing(env,f.project_id,f.id,f.uploader_user_id,{automatic:true});}catch{/* Unsupported or inaccessible files stay available for manual handling. */}}
 const ready=await env.DB.prepare(`SELECT b.source_version_id FROM file_processing b JOIN source_processing p ON p.source_version_id=b.source_version_id WHERE p.text_status='ready' AND (?1 IS NULL OR b.project_id=?1) ORDER BY b.updated_at,b.file_id LIMIT ?2`).bind(projectId??null,Math.min(100,Math.max(1,limit))).all<{source_version_id:string}>();
 for(const b of ready.results){try{await syncFileProcessingText(env,b.source_version_id);}catch{/* A concurrent lifecycle change must not publish stale text. */}finally{await env.DB.prepare('UPDATE file_processing SET updated_at=?2 WHERE source_version_id=?1').bind(b.source_version_id,nowIso()).run();}}
}

/** Publish extracted original text only; summaries are never assessment evidence. */
export async function syncFileProcessingText(env:Env,sourceVersionId:string,jobId?:string):Promise<void>{
 const row=await env.DB.prepare(`SELECT b.file_id,b.lifecycle_version,s.id source_id,s.purpose,s.project_id,s.title,s.created_by,f.ext FROM file_processing b JOIN sources s ON s.id=b.source_id JOIN files f ON f.id=b.file_id WHERE b.source_version_id=?1 AND f.lifecycle_version=b.lifecycle_version AND f.deleted_at IS NULL AND s.deleted_at IS NULL AND ${discoverableFileSql('f')}`).bind(sourceVersionId).first<{file_id:string;lifecycle_version:number;source_id:string;purpose:string;project_id:string;title:string;created_by:string;ext:string}>();
 if(!row||isMediaExtension(row.ext))return;
 if(jobId&&!await env.DB.prepare("SELECT 1 FROM jobs WHERE id=?1 AND status IN ('queued','running')").bind(jobId).first())return;
 const now=nowIso();
 await env.DB.prepare(`UPDATE materials SET purpose=COALESCE((SELECT parent.purpose FROM file_processing_materials link JOIN materials parent ON parent.id=link.parent_material_id WHERE link.source_version_id=?1 AND link.material_id=materials.id),?2),
 archived_at=CASE WHEN EXISTS(SELECT 1 FROM file_processing_materials link WHERE link.source_version_id=?1 AND link.material_id=materials.id AND link.parent_material_id IS NOT NULL) THEN (SELECT parent.archived_at FROM file_processing_materials link JOIN materials parent ON parent.id=link.parent_material_id WHERE link.source_version_id=?1 AND link.material_id=materials.id) ELSE archived_at END,updated_at=?3 WHERE kind='file-extracted' AND id IN (SELECT material_id FROM file_processing_materials WHERE source_version_id=?1)`).bind(sourceVersionId,row.purpose,now).run();
 const fragments=await env.DB.prepare('SELECT content FROM source_fragments WHERE source_version_id=?1 ORDER BY seq').bind(sourceVersionId).all<{content:string}>();
 const text=fragments.results.map(f=>f.content).join('\n\n').trim();if(!text)return;
 const hash=await sha256Hex(text),doc=JSON.stringify({type:'doc',content:text.split('\n\n').map(t=>({type:'paragraph',content:[{type:'text',text:t}]}))});
 const attachments=await env.DB.prepare(`SELECT m.id,m.kind,m.revision,m.current_version_id,v.markdown,v.attachments_json,link.text_hash last_hash FROM materials m JOIN material_versions v ON v.id=m.current_version_id LEFT JOIN file_processing_materials link ON link.material_id=m.id AND link.source_version_id=?3,json_each(v.attachments_json) a WHERE m.project_id=?1 AND m.purpose='output' AND m.archived_at IS NULL AND json_extract(a.value,'$.fileId')=?2`).bind(row.project_id,row.file_id,sourceVersionId).all<{id:string;kind:string;revision:number;current_version_id:string;markdown:string;attachments_json:string;last_hash:string|null}>();
 const targets:typeof attachments.results=[];
 for(const material of attachments.results){if(material.kind!=='file-extracted'&&(!material.markdown.trim()||(material.last_hash&&material.last_hash===await sha256Hex(material.markdown))))targets.push(material);}
 if(!targets.length&&(row.purpose==='output'||attachments.results.some(m=>m.kind!=='file-extracted'))){
  const linked=await env.DB.prepare('SELECT m.id,m.kind,m.revision,m.current_version_id,v.markdown,v.attachments_json,b.text_hash last_hash FROM file_processing_materials b JOIN materials m ON m.id=b.material_id JOIN material_versions v ON v.id=m.current_version_id WHERE b.source_version_id=?1 AND m.kind=\'file-extracted\'').bind(sourceVersionId).first<typeof targets[number]>();
  if(linked){if(linked.last_hash===await sha256Hex(linked.markdown))targets.push(linked);}else {
   const materialId=newId(),versionId=newId();
   const writes=await env.DB.batch([
    env.DB.prepare(`INSERT INTO materials(id,project_id,title,kind,purpose,current_version_id,created_by,created_at,updated_at) SELECT ?1,?2,?3,'file-extracted','output',?4,?5,?6,?6 WHERE NOT EXISTS(SELECT 1 FROM file_processing_materials WHERE source_version_id=?7) AND EXISTS(SELECT 1 FROM file_processing b JOIN files f ON f.id=b.file_id JOIN sources s ON s.id=b.source_id WHERE b.source_version_id=?7 AND f.lifecycle_version=b.lifecycle_version AND f.status='available' AND f.deleted_at IS NULL AND f.archived_at IS NULL AND s.deleted_at IS NULL)`).bind(materialId,row.project_id,row.title,versionId,row.created_by,now,sourceVersionId),
    env.DB.prepare(`INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at,attachments_json) SELECT ?1,?2,?3,1,?4,?5,'manual',?6,?7,?8 WHERE EXISTS(SELECT 1 FROM materials WHERE id=?2 AND current_version_id=?1)`).bind(versionId,materialId,row.project_id,doc,text,row.created_by,now,JSON.stringify([{fileId:row.file_id}])),
    env.DB.prepare('INSERT INTO file_processing_materials(source_version_id,material_id,text_hash,parent_material_id) SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM material_versions WHERE material_id=?2) ON CONFLICT DO NOTHING').bind(sourceVersionId,materialId,hash,attachments.results.find(m=>m.kind!=='file-extracted')?.id??null),
   ]);if(writes[0]?.meta.changes)await invalidateResourceIndex(env,row.project_id,{resourceType:'material',versionId});
  }
 }
 for(const m of targets){
  if(await env.DB.prepare('SELECT 1 FROM file_processing_materials WHERE source_version_id=?1 AND material_id=?2 AND text_hash=?3').bind(sourceVersionId,m.id,hash).first())continue;
  const versionId=newId();
  await env.DB.batch([
   env.DB.prepare(`INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at,attachments_json) SELECT ?1,id,project_id,(SELECT MAX(revision)+1 FROM material_versions WHERE material_id=?2),?3,?4,'manual',?5,?6,?7 FROM materials WHERE id=?2 AND current_version_id=?8 AND archived_at IS NULL AND EXISTS(SELECT 1 FROM files WHERE id=?9 AND lifecycle_version=?10 AND deleted_at IS NULL AND archived_at IS NULL)`).bind(versionId,m.id,doc,text,row.created_by,now,m.attachments_json,m.current_version_id,row.file_id,row.lifecycle_version),
   env.DB.prepare('UPDATE materials SET current_version_id=?2,revision=revision+1,updated_at=?3 WHERE id=?1 AND current_version_id=?4 AND EXISTS(SELECT 1 FROM material_versions WHERE id=?2)').bind(m.id,versionId,now,m.current_version_id),
   env.DB.prepare('INSERT INTO file_processing_materials(source_version_id,material_id,text_hash) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM materials WHERE id=?2 AND current_version_id=?4) ON CONFLICT(source_version_id,material_id) DO UPDATE SET text_hash=excluded.text_hash').bind(sourceVersionId,m.id,hash,versionId),
  ]);await invalidateResourceIndex(env,row.project_id,{resourceType:'material',versionId});
 }
}
