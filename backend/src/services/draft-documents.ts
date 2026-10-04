import { enqueueDraftMedia } from './media-summary';
import { validateDocx } from './docx-validation';
import { z } from 'zod';
import type { Env } from '../env';
import { getDraft,draftView,type DraftFile } from './creation-drafts';
import { newId,nowIso } from '../core/db';
import { invalidState,notFound,validationFailed,versionConflict } from '../core/errors';
import { extOf,validateUploadBytes,isMediaExtension,uploadLimit } from './files';
export const DRAFT_PART_BYTES=8*1024*1024;
export const draftBlockSchema=z.object({seq:z.number().int().nonnegative(),pageNumber:z.number().int().positive().nullable(),text:z.string().max(24000),headingPath:z.array(z.string().max(200)).max(6).optional(),warnings:z.array(z.string().max(1000)).max(20).optional()}).strict();
type Upload={file_id:string;draft_id:string;upload_id:string;r2_key:string;name:string;ext:string;size_bytes:number;revision:number;status:string;operation_token:string|null;operation_expires_at:string|null};
async function active(env:Env,draftId:string,userId:string,revision?:number) {
 const draft=await getDraft(env,draftId,userId);
 if(draft.status!=='active'||draft.preview_state==='running')throw invalidState('草稿不可修改或预览仍在进行');
 if(revision!==undefined&&draft.revision!==revision)throw versionConflict(draft.revision);
 return draft;
}
async function upload(env:Env,draftId:string,fileId:string,userId:string) {
 const draft=await active(env,draftId,userId);
 const row=await env.DB.prepare('SELECT * FROM draft_document_uploads WHERE file_id=?1 AND draft_id=?2').bind(fileId,draftId).first<Upload>();
 if(!row)throw notFound('上传会话不存在或已取消');
 return {draft,row};
}
export async function beginDraftUpload(env:Env,draftId:string,userId:string,fileId:string,name:string,size:number,revision:number) {
 await active(env,draftId,userId,revision);
 const existing=await env.DB.prepare('SELECT * FROM draft_document_uploads WHERE file_id=?1 AND draft_id=?2').bind(fileId,draftId).first<Upload>();
 if(existing){if(existing.name!==name||existing.size_bytes!==size||existing.status==='cancelled')throw invalidState('上传标识不能复用于其他文件或已取消的会话');return draftUploadStatus(env,draftId,userId,fileId);}
 const ext=extOf(name);
 if(!['.pdf','.docx','.txt','.md','.png','.jpg','.jpeg','.webp','.mp3','.wav','.m4a','.mp4','.webm'].includes(ext)||name.length>255||!Number.isSafeInteger(size)||size<1)throw validationFailed('文件类型、名称或大小不合法');
 const limit=uploadLimit(ext);if(limit!==null&&size>limit)throw validationFailed('文件超过该类型的上传限制');
 const count=await env.DB.prepare('SELECT COUNT(*) n FROM creation_draft_files WHERE draft_id=?1 AND removed=0').bind(draftId).first<{n:number}>();if((count?.n??0)>=10)throw validationFailed('每份草稿最多10个文件');
 const key=`creation-drafts/${draftId}/${fileId}${ext}`,multipart=await env.FILES.createMultipartUpload(key,{httpMetadata:{contentType:'application/octet-stream'}});
 try{await env.DB.prepare('INSERT INTO draft_document_uploads(file_id,draft_id,upload_id,r2_key,name,ext,size_bytes,revision) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)').bind(fileId,draftId,multipart.uploadId,key,name,ext,size,revision).run();}
 catch(error){await multipart.abort();const winner=await env.DB.prepare('SELECT name,size_bytes,status FROM draft_document_uploads WHERE file_id=?1 AND draft_id=?2').bind(fileId,draftId).first<{name:string;size_bytes:number;status:string}>();if(!winner||winner.name!==name||winner.size_bytes!==size||winner.status==='cancelled')throw error;}
 return draftUploadStatus(env,draftId,userId,fileId);
}
export async function draftUploadStatus(env:Env,draftId:string,userId:string,fileId:string) {
 const {row}=await upload(env,draftId,fileId,userId);
 const parts=await env.DB.prepare('SELECT part_number partNumber,etag,size_bytes sizeBytes FROM draft_document_parts WHERE file_id=?1 ORDER BY part_number').bind(fileId).all<{partNumber:number;etag:string;sizeBytes:number}>();
 return {fileId,status:row.status,partBytes:DRAFT_PART_BYTES,sizeBytes:row.size_bytes,parts:parts.results};
}
export async function uploadDraftPart(env:Env,draftId:string,userId:string,fileId:string,partNumber:number,body:ReadableStream<Uint8Array>|null,length:number) {
 const {row}=await upload(env,draftId,fileId,userId);await active(env,draftId,userId,row.revision);
 const number=Math.ceil(row.size_bytes/DRAFT_PART_BYTES),expected=Math.min(DRAFT_PART_BYTES,row.size_bytes-(partNumber-1)*DRAFT_PART_BYTES);
 if(row.status!=='uploading'||!body||partNumber<1||partNumber>number||length!==expected)throw validationFailed('分片序号或长度不合法');
 const token=newId(),now=nowIso(),expires=new Date(Date.now()+300000).toISOString();
 const claimed=await env.DB.prepare(`INSERT INTO draft_document_part_leases(file_id,part_number,lease_owner,expires_at) SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM draft_document_uploads WHERE file_id=?1 AND status='uploading') ON CONFLICT(file_id,part_number) DO UPDATE SET lease_owner=excluded.lease_owner,expires_at=excluded.expires_at WHERE draft_document_part_leases.expires_at<=?5`).bind(fileId,partNumber,token,expires,now).run();
 if(!claimed.meta.changes)throw invalidState('分片正在上传或会话状态已变化');
 let actual=0;
 try{
  const fixed=new FixedLengthStream(expected),counted=body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){actual+=chunk.byteLength;controller.enqueue(chunk);}})),transfer=counted.pipeTo(fixed.writable);
  const [part]=await Promise.all([env.FILES.resumeMultipartUpload(row.r2_key,row.upload_id).uploadPart(partNumber,fixed.readable),transfer]);
  await active(env,draftId,userId,row.revision);
  const saved=await env.DB.prepare(`INSERT INTO draft_document_parts(file_id,part_number,etag,size_bytes) SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM draft_document_uploads u JOIN draft_document_part_leases l ON l.file_id=u.file_id WHERE u.file_id=?1 AND u.status='uploading' AND l.part_number=?2 AND l.lease_owner=?5) ON CONFLICT(file_id,part_number) DO UPDATE SET etag=excluded.etag,size_bytes=excluded.size_bytes`).bind(fileId,partNumber,part.etag,expected,token).run();
  if(!saved.meta.changes)throw invalidState('分片会话已变化');
 }catch(error){if(actual!==expected)throw validationFailed('分片实际长度不符或传输中断，请重新上传此分片');throw error;}
 finally{await env.DB.prepare('DELETE FROM draft_document_part_leases WHERE file_id=?1 AND part_number=?2 AND lease_owner=?3').bind(fileId,partNumber,token).run();}
 return draftUploadStatus(env,draftId,userId,fileId);
}
export async function completeDraftUpload(env:Env,draftId:string,userId:string,fileId:string) {
 const {row,draft}=await upload(env,draftId,fileId,userId);
 if(row.status==='complete')return draftView(env,draft);
 await active(env,draftId,userId,row.revision);
 if(!['uploading','completing'].includes(row.status))throw invalidState('上传不能完成');
 const parts=await env.DB.prepare('SELECT part_number partNumber,etag,size_bytes sizeBytes FROM draft_document_parts WHERE file_id=?1 ORDER BY part_number').bind(fileId).all<{partNumber:number;etag:string;sizeBytes:number}>();
 if(parts.results.length!==Math.ceil(row.size_bytes/DRAFT_PART_BYTES)||parts.results.some((p,i)=>p.partNumber!==i+1)||parts.results.reduce((n,p)=>n+p.sizeBytes,0)!==row.size_bytes)throw invalidState('分片尚未上传完整');
 const token=newId(),expires=new Date(Date.now()+300000).toISOString();
 const claimed=await env.DB.prepare(`UPDATE draft_document_uploads SET status='completing',operation_token=?2,operation_expires_at=?3 WHERE file_id=?1 AND (status='uploading' OR (status='completing' AND operation_expires_at<=?4)) AND NOT EXISTS(SELECT 1 FROM draft_document_part_leases WHERE file_id=?1 AND expires_at>?4)`).bind(fileId,token,expires,nowIso()).run();
 if(!claimed.meta.changes)throw invalidState('上传正在完成或仍有分片写入，请稍后查询状态');
 // Reconcile an R2 completion whose response was lost instead of creating another paid upload.
 let stored=await env.FILES.head(row.r2_key);
 if(!stored)stored=await env.FILES.resumeMultipartUpload(row.r2_key,row.upload_id).complete(parts.results.map(({partNumber,etag})=>({partNumber,etag})));
 if(stored.size!==row.size_bytes)throw invalidState('原文件长度校验失败');
 const first=await env.FILES.get(row.r2_key,{range:{offset:0,length:16}}),head=new Uint8Array(await first!.arrayBuffer());
 try {
  if(row.ext==='.docx')await validateDocx(stored.size,async(offset,length)=>{const object=await env.FILES.get(row.r2_key,{range:{offset,length}});if(!object)throw notFound('DOCX对象不存在');return new Uint8Array(await object.arrayBuffer());});
  else if(row.ext==='.txt'||row.ext==='.md'){
   const object=await env.FILES.get(row.r2_key);if(!object)throw notFound('原文件不存在');
   const reader=object.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});
   try {for(;;){const chunk=await reader.read();if(chunk.done)break;decoder.decode(chunk.value,{stream:true});}decoder.decode();}catch{throw validationFailed('文本文件不是有效UTF-8');}finally{reader.releaseLock();}
  }else validateUploadBytes(row.ext,head);
 } catch(error){
  await env.DB.prepare("UPDATE draft_document_uploads SET status='cancelled',operation_token=NULL,operation_expires_at=NULL WHERE file_id=?1 AND status='completing' AND operation_token=?2").bind(fileId,token).run();
  throw error;
 }
 const mime=({'.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.txt':'text/plain','.md':'text/markdown','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.mp4':'video/mp4','.webm':'video/webm'} as Record<string,string>)[row.ext]!;
 const time=nowIso();
 const result=await env.DB.batch([
  env.DB.prepare("UPDATE project_creation_drafts SET revision=revision+1,preview_state='none',updated_at=?4,preview_attempt_id=?5 WHERE id=?1 AND owner_id=?2 AND revision=?3 AND status='active' AND preview_state!='running' AND (SELECT count(*) FROM creation_draft_files WHERE draft_id=?1 AND removed=0)<10 AND EXISTS(SELECT 1 FROM draft_document_uploads WHERE file_id=?5 AND status='completing' AND operation_token=?6)").bind(draftId,userId,row.revision,time,fileId,token),
  env.DB.prepare("INSERT OR IGNORE INTO creation_draft_files(id,draft_id,name,ext,r2_key,sha256,size_bytes,mime,pages_json,text_error,created_at) SELECT ?1,?2,?3,?4,?5,'',?6,?7,'[]',?11,?8 WHERE EXISTS(SELECT 1 FROM project_creation_drafts WHERE id=?2 AND owner_id=?9 AND revision=?10 AND preview_attempt_id=?1 AND status='active')").bind(fileId,draftId,row.name,row.ext,row.r2_key,row.size_bytes,mime,time,userId,row.revision+1,isMediaExtension(row.ext)?'音视频摘要正在排队；处理完成后可用于预览':'原文件已上传，等待浏览器正文解析'),
  env.DB.prepare("UPDATE draft_document_uploads SET status='complete',operation_token=NULL,operation_expires_at=NULL WHERE file_id=?1 AND operation_token=?2 AND EXISTS(SELECT 1 FROM creation_draft_files WHERE id=?1)").bind(fileId,token),
 ]);
 if(!result[0]!.meta.changes)throw versionConflict((await getDraft(env,draftId,userId)).revision);
 if(isMediaExtension(row.ext))await enqueueDraftMedia(env,draftId,fileId,userId);
 return draftView(env,await getDraft(env,draftId,userId));
}
export async function cancelDraftUpload(env:Env,draftId:string,userId:string,fileId:string) {
 const {row}=await upload(env,draftId,fileId,userId);if(row.status==='complete')throw invalidState('已完成原文件请使用移除文件操作');
 if(row.status==='cancelled')return {fileId,status:'cancelled' as const};
 const token=newId(),now=nowIso(),expires=new Date(Date.now()+300000).toISOString();
 const claimed=await env.DB.prepare(`UPDATE draft_document_uploads SET status='aborting',operation_token=?2,operation_expires_at=?3 WHERE file_id=?1 AND (status='uploading' OR (status='aborting' AND operation_expires_at<=?4)) AND NOT EXISTS(SELECT 1 FROM draft_document_part_leases WHERE file_id=?1 AND expires_at>?4)`).bind(fileId,token,expires,now).run();if(!claimed.meta.changes)throw invalidState('上传正在完成或分片正在写入，不能并发取消');
 await env.FILES.resumeMultipartUpload(row.r2_key,row.upload_id).abort();await env.DB.prepare("UPDATE draft_document_uploads SET status='cancelled',operation_token=NULL,operation_expires_at=NULL WHERE file_id=?1 AND operation_token=?2").bind(fileId,token).run();return {fileId,status:'cancelled' as const};
}
async function importAccess(env:Env,draftId:string,userId:string,fileId:string) {
 const draft=await active(env,draftId,userId);const file=await env.DB.prepare('SELECT * FROM creation_draft_files WHERE id=?1 AND draft_id=?2 AND removed=0').bind(fileId,draftId).first<DraftFile>();if(!file)throw notFound('草稿文件不存在或已移除');return {draft,file};
}
export async function importDraftBlocks(env:Env,draftId:string,userId:string,fileId:string,revision:number,blocks:z.infer<typeof draftBlockSchema>[]) {
 const {draft}=await importAccess(env,draftId,userId,fileId);if(draft.revision!==revision)throw versionConflict(draft.revision);
 if(blocks.length<1||blocks.length>10||blocks.reduce((n,b)=>n+b.text.length,0)>24000)throw validationFailed('每批正文最多24000字符和10个文本块');
 const existing=await env.DB.prepare('SELECT revision,status FROM draft_document_imports WHERE file_id=?1').bind(fileId).first<{revision:number;status:string;operation_token:string|null;operation_expires_at:string|null}>();
 if(existing&&(existing.revision!==revision||existing.status!=='importing'))throw invalidState('导入会话已变化或完成');
 await env.DB.prepare('INSERT OR IGNORE INTO draft_document_imports(file_id,draft_id,revision) VALUES(?1,?2,?3)').bind(fileId,draftId,revision).run();
 for(const b of blocks){const old=await env.DB.prepare('SELECT content,page_number,heading_json FROM draft_document_blocks WHERE file_id=?1 AND seq=?2').bind(fileId,b.seq).first<{content:string;page_number:number|null;heading_json:string}>();if(old&&(old.content!==b.text||old.page_number!==b.pageNumber||old.heading_json!==JSON.stringify(b.headingPath??[])))throw invalidState('同一导入批次不能改变正文');}
 await env.DB.batch(blocks.map(b=>env.DB.prepare('INSERT OR IGNORE INTO draft_document_blocks(id,draft_id,file_id,seq,page_number,content,heading_json) SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM project_creation_drafts d JOIN creation_draft_files f ON f.draft_id=d.id WHERE d.id=?2 AND d.owner_id=?8 AND d.revision=?9 AND d.status=\'active\' AND d.preview_state!=\'running\' AND f.id=?3 AND f.removed=0)').bind(newId(),draftId,fileId,b.seq,b.pageNumber,b.text,JSON.stringify(b.headingPath??[]),userId,revision)));
 await importAccess(env,draftId,userId,fileId);return {fileId,accepted:blocks.length};
}
export async function finishDraftImport(env:Env,draftId:string,userId:string,fileId:string,revision:number,total:number,status:'complete'|'partial',warnings:string[],interrupted=false) {
 const {draft}=await importAccess(env,draftId,userId,fileId);
 const previous=await env.DB.prepare('SELECT revision,status FROM draft_document_imports WHERE file_id=?1 AND draft_id=?2').bind(fileId,draftId).first<{revision:number;status:string;operation_token:string|null;operation_expires_at:string|null}>();
 if(previous&&previous.revision===revision&&previous.status===status&&draft.revision===revision+1)return draftView(env,draft);
 if(draft.revision!==revision)throw versionConflict(draft.revision);
 const count=await env.DB.prepare('SELECT count(*) n,min(seq) first,max(seq) last FROM draft_document_blocks WHERE file_id=?1').bind(fileId).first<{n:number;first:number|null;last:number|null}>();
 if(count!.n!==total||(total>0&&(count!.first!==0||count!.last!==total-1)))throw invalidState('正文块不完整');
 const error=status==='partial'?(warnings.join('；')||'浏览器仅完成部分正文，未读取内容需要补充'):warnings.length?warnings.join('；'):null;
 const result=await env.DB.batch([
  env.DB.prepare("UPDATE project_creation_drafts SET revision=revision+1,preview_state='none',updated_at=?4,preview_attempt_id=?5 WHERE id=?1 AND owner_id=?2 AND revision=?3 AND status='active' AND preview_state!='running'").bind(draftId,userId,revision,nowIso(),fileId),
  env.DB.prepare("UPDATE creation_draft_files SET text_error=?3 WHERE id=?1 AND draft_id=?2 AND removed=0 AND EXISTS(SELECT 1 FROM project_creation_drafts WHERE id=?2 AND revision=?4 AND preview_attempt_id=?1)").bind(fileId,draftId,error,revision+1),
  env.DB.prepare("UPDATE draft_document_imports SET status=?2,warnings_json=?3,interrupted=?5 WHERE file_id=?1 AND EXISTS(SELECT 1 FROM project_creation_drafts d WHERE d.id=draft_document_imports.draft_id AND d.revision=?4 AND d.preview_attempt_id=?1 AND d.status='active')").bind(fileId,status,JSON.stringify(warnings),revision+1,interrupted?1:0),
 ]);if(!result[0]!.meta.changes)throw versionConflict((await getDraft(env,draftId,userId)).revision);return draftView(env,await getDraft(env,draftId,userId));
}
export async function readDraftDocument(env:Env,draftId:string,userId:string,fileId:string,offset:number,charOffset=0) {
 const assertRead=async()=>{const draft=await getDraft(env,draftId,userId);if(draft.status!=='active'||!await env.DB.prepare('SELECT 1 FROM creation_draft_files WHERE id=?1 AND draft_id=?2 AND removed=0').bind(fileId,draftId).first())throw notFound('草稿正文不可用');};
 await assertRead();
 const rows=await env.DB.prepare('SELECT seq,page_number pageNumber,content text,heading_json heading FROM draft_document_blocks WHERE draft_id=?1 AND file_id=?2 ORDER BY seq LIMIT 2 OFFSET ?3').bind(draftId,fileId,offset).all<{seq:number;pageNumber:number|null;text:string;heading:string}>();
 await assertRead();
 const block=rows.results[0],chars=Array.from(block?.text??''),more=chars.length>charOffset+6000;
 return {untrustedData:true,fileId,blocks:block?[{...block,text:chars.slice(charOffset,charOffset+6000).join(''),locator:`block:${block.seq}`,headingPath:JSON.parse(block.heading) as string[]}]:[],nextOffset:more?offset:rows.results.length>1?offset+1:null,nextCharOffset:more?charOffset+6000:0};
}
