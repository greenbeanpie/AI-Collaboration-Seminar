import type { Env } from '../env';
import { invalidState, notFound, validationFailed, unsupportedMediaType } from '../core/errors';
import { nowIso } from '../core/db';
import { LIMITS } from '../core/limits';
import { validateUploadBytes } from './files';
import { validateDocx } from './docx-validation';

interface Upload { id:string; file_id:string; project_id:string; actor_id:string; lifecycle_version:number; upload_id:string; r2_key:string; size_bytes:number; part_bytes:number; status:string }
async function activeFile(env:Env,project:string,file:string,user:string) {
  const row=await env.DB.prepare("SELECT ext,lifecycle_version,r2_key FROM files WHERE id=?1 AND project_id=?2 AND uploader_user_id=?3 AND status='pending' AND deleted_at IS NULL").bind(file,project,user).first<{ext:string;lifecycle_version:number;r2_key:string}>();
  if(!row)throw notFound('待上传文件不存在或不属于当前用户');return row;
}
async function load(env:Env,project:string,file:string,user:string,id:string) {
  const row=await env.DB.prepare('SELECT * FROM file_upload_sessions WHERE id=?1 AND project_id=?2 AND file_id=?3 AND actor_id=?4').bind(id,project,file,user).first<Upload>();
  if(!row)throw notFound('上传会话不存在');
  const live=await env.DB.prepare("SELECT 1 FROM files WHERE id=?1 AND project_id=?2 AND deleted_at IS NULL AND lifecycle_version=?3 AND uploader_user_id=?4").bind(file,project,row.lifecycle_version,user).first();
  if(!live)throw invalidState('文件生命周期已变化');return row;
}
export async function beginMultipart(env:Env,project:string,file:string,user:string,size:number) {
  if(!Number.isSafeInteger(size)||size<1)throw validationFailed('文件大小无效');
  const f=await activeFile(env,project,file,user);
  const old=await env.DB.prepare("SELECT * FROM file_upload_sessions WHERE file_id=?1 AND lifecycle_version=?2 AND status IN ('uploading','completing')").bind(file,f.lifecycle_version).first<Upload>();
  if(old){if(old.size_bytes!==size)throw invalidState('同一文件上传大小已变化');return {sessionId:old.id,partBytes:old.part_bytes};}
  const key=`${project}/${file}.l${f.lifecycle_version}${f.ext}`, upload=await env.FILES.createMultipartUpload(key), id=crypto.randomUUID();
  const partBytes=Math.max(LIMITS.uploadPartBytes,Math.ceil(size/9999/1048576)*1048576);
  await env.DB.prepare('INSERT INTO file_upload_sessions(id,file_id,project_id,actor_id,lifecycle_version,upload_id,r2_key,size_bytes,part_bytes,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)').bind(id,file,project,user,f.lifecycle_version,upload.uploadId,key,size,partBytes,nowIso()).run();
  return {sessionId:id,partBytes};
}
export async function multipartStatus(env:Env,project:string,file:string,user:string,id:string) {
  const s=await load(env,project,file,user,id);
  const parts=await env.DB.prepare('SELECT part_number partNumber,etag,size_bytes sizeBytes FROM file_upload_parts WHERE session_id=?1 ORDER BY part_number').bind(id).all();
  return {sessionId:id,status:s.status,partBytes:s.part_bytes,sizeBytes:s.size_bytes,parts:parts.results};
}
export async function putMultipartPart(env:Env,project:string,file:string,user:string,id:string,part:number,body:ReadableStream<Uint8Array>,declaredSize:number) {
  const s=await load(env,project,file,user,id);if(s.status!=='uploading')throw invalidState('上传已结束');
  const expected=Math.min(s.part_bytes,s.size_bytes-(part-1)*s.part_bytes);
  if(part<1||part>Math.ceil(s.size_bytes/s.part_bytes)||declaredSize!==expected)throw validationFailed('分片编号或大小不符');
  const fixed=new FixedLengthStream(expected);
  const transfer=body.pipeTo(fixed.writable);
  const [p]=await Promise.all([env.FILES.resumeMultipartUpload(s.r2_key,s.upload_id).uploadPart(part,fixed.readable),transfer]);
  const actual=expected;
  await load(env,project,file,user,id);
  await env.DB.prepare(`INSERT INTO file_upload_parts(session_id,part_number,etag,size_bytes) SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM file_upload_sessions WHERE id=?1 AND status='uploading') ON CONFLICT(session_id,part_number) DO UPDATE SET etag=excluded.etag,size_bytes=excluded.size_bytes`).bind(id,part,p.etag,actual).run();
  return {partNumber:part,etag:p.etag,sizeBytes:actual};
}
export async function completeMultipart(env:Env,project:string,file:string,user:string,id:string) {
  const s=await load(env,project,file,user,id);
  if(s.status==='complete')return {fileId:file,status:'available'};
  if(!['uploading','completing'].includes(s.status))throw invalidState('上传已取消');
  const parts=await env.DB.prepare('SELECT part_number partNumber,etag,size_bytes sizeBytes FROM file_upload_parts WHERE session_id=?1 ORDER BY part_number').bind(id).all<{partNumber:number;etag:string;sizeBytes:number}>();
  if(parts.results.length!==Math.ceil(s.size_bytes/s.part_bytes)||parts.results.some((p,i)=>p.partNumber!==i+1)||parts.results.reduce((n,p)=>n+p.sizeBytes,0)!==s.size_bytes)throw invalidState('存在未完成分片');
  await env.DB.prepare("UPDATE file_upload_sessions SET status='completing',updated_at=?2 WHERE id=?1 AND status='uploading'").bind(id,nowIso()).run();
  let object=await env.FILES.head(s.r2_key);
  if(!object)object=await env.FILES.resumeMultipartUpload(s.r2_key,s.upload_id).complete(parts.results.map(({partNumber,etag})=>({partNumber,etag})));
  if(object.size!==s.size_bytes)throw invalidState('文件总大小不符');
  const read=async(offset:number,length:number)=>{const o=await env.FILES.get(s.r2_key,{range:{offset,length}});if(!o)throw notFound('文件内容缺失');return new Uint8Array(await o.arrayBuffer());};
  const f=await activeFile(env,project,file,user);
  let mime:string;
  try {
    if(f.ext==='.docx')mime=await validateDocx(object.size,read);
    else if(f.ext==='.txt'||f.ext==='.md') {
      const obj=await env.FILES.get(s.r2_key);if(!obj)throw notFound('文件内容缺失');
      const reader=obj.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});
      try {while(true){const {done,value}=await reader.read();if(done)break;decoder.decode(value,{stream:true});}decoder.decode();}catch{throw unsupportedMediaType('文本不是有效 UTF-8');}finally{reader.releaseLock();}
      mime=f.ext==='.md'?'text/markdown; charset=utf-8':'text/plain; charset=utf-8';
    } else mime=validateUploadBytes(f.ext,await read(0,Math.min(16,object.size)));
  } catch(e){await env.DB.prepare("UPDATE files SET status='quarantined',r2_key=?2,gc_after=?3 WHERE id=?1 AND lifecycle_version=?4 AND deleted_at IS NULL").bind(file,s.r2_key,new Date(Date.now()+48*3600000).toISOString(),s.lifecycle_version).run();await env.DB.prepare("UPDATE file_upload_sessions SET status='aborted' WHERE id=?1").bind(id).run();throw e;}
  const result=await env.DB.prepare("UPDATE files SET status='available',mime_detected=?2,size_bytes=?3,r2_key=?4 WHERE id=?1 AND status='pending' AND lifecycle_version=?5 AND deleted_at IS NULL").bind(file,mime,object.size,s.r2_key,s.lifecycle_version).run();
  if(!result.meta.changes)throw invalidState('文件生命周期已变化');
  await env.DB.prepare("UPDATE file_upload_sessions SET status='complete',updated_at=?2 WHERE id=?1").bind(id,nowIso()).run();
  return {fileId:file,status:'available'};
}
export async function abortMultipart(env:Env,project:string,file:string,user:string,id:string) {
  const s=await load(env,project,file,user,id);if(s.status==='complete')throw invalidState('文件已上传完成');
  if(s.status!=='aborted') {await env.FILES.resumeMultipartUpload(s.r2_key,s.upload_id).abort();await env.DB.prepare("UPDATE file_upload_sessions SET status='aborted',updated_at=?2 WHERE id=?1").bind(id,nowIso()).run();}
  return {status:'aborted'};
}
