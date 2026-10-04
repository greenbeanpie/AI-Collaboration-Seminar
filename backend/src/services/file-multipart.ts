import type { Env } from '../env';
import { AppError, invalidState, notFound, validationFailed, unsupportedMediaType } from '../core/errors';
import { nowIso } from '../core/db';
import { LIMITS } from '../core/limits';
import { validateUploadBytes } from './files';
import { validateDocx } from './docx-validation';

interface Upload { id:string;file_id:string;project_id:string;actor_id:string;lifecycle_version:number;upload_id:string;r2_key:string;size_bytes:number;part_bytes:number;status:string;operation_token:string|null;operation_expires_at:string|null }
const LEASE_MS=15*60*1000;
// Current deployment uses Cloudflare Free's 100 MB request body ceiling; this is a transport limit.
const CF_REQUEST_BYTES=100_000_000, R2_OBJECT_BYTES=5*1024**4, R2_PARTS=10000;
function liveGuard(file:string,project:string,user:string,lifecycle:string,pending=false) {
 return `EXISTS(SELECT 1 FROM files live_f JOIN project_members live_m ON live_m.project_id=live_f.project_id AND live_m.user_id=${user} WHERE live_f.id=${file} AND live_f.project_id=${project} AND live_f.uploader_user_id=${user} AND live_f.lifecycle_version=${lifecycle} AND live_f.deleted_at IS NULL AND live_f.status ${pending?"= 'pending'":"IN ('pending','available')"})`;
}
async function activeFile(env:Env,project:string,file:string,user:string) {
 const row=await env.DB.prepare("SELECT f.ext,f.lifecycle_version,f.r2_key FROM files f JOIN project_members m ON m.project_id=f.project_id AND m.user_id=?3 WHERE f.id=?1 AND f.project_id=?2 AND f.uploader_user_id=?3 AND f.status='pending' AND f.deleted_at IS NULL").bind(file,project,user).first<{ext:string;lifecycle_version:number;r2_key:string}>();
 if(!row)throw notFound('待上传文件不存在或不属于当前项目成员');return row;
}
async function load(env:Env,project:string,file:string,user:string,id:string) {
 const row=await env.DB.prepare('SELECT * FROM file_upload_sessions WHERE id=?1 AND project_id=?2 AND file_id=?3 AND actor_id=?4').bind(id,project,file,user).first<Upload>();
 if(!row)throw notFound('上传会话不存在');
 const live=await env.DB.prepare(`SELECT 1 WHERE ${liveGuard('?1','?2','?3','?4')}`).bind(file,project,user,row.lifecycle_version).first();
 if(!live)throw invalidState('文件生命周期或项目成员身份已变化');return row;
}
export async function beginMultipart(env:Env,project:string,file:string,user:string,size:number) {
 if(!Number.isSafeInteger(size)||size<1)throw validationFailed('文件大小无效');
 if(size>R2_OBJECT_BYTES)throw new AppError('FILE_TOO_LARGE','文件超过 R2 单对象 5 TiB 平台限制',413,false,{platform:'R2',maxBytes:R2_OBJECT_BYTES});
 const partBytes=Math.max(LIMITS.uploadPartBytes,Math.ceil(size/R2_PARTS/1048576)*1048576);
 if(partBytes>CF_REQUEST_BYTES)throw new AppError('FILE_TOO_LARGE','当前 CF Free 上传通道无法同时满足每请求100 MB与R2最多10000分片限制；需更高请求额度或R2直传通道',413,false,{platform:'Cloudflare Free request/R2 multipart',requestMaxBytes:CF_REQUEST_BYTES,maxParts:R2_PARTS});
 const f=await activeFile(env,project,file,user);
 const existing=()=>env.DB.prepare("SELECT * FROM file_upload_sessions WHERE file_id=?1 AND lifecycle_version=?2 AND status IN ('uploading','completing','aborting')").bind(file,f.lifecycle_version).first<Upload>();
 const old=await existing();if(old){if(old.size_bytes!==size)throw invalidState('同一文件上传大小已变化');return {sessionId:old.id,partBytes:old.part_bytes};}
 const id=crypto.randomUUID(),key=`${project}/${file}.l${f.lifecycle_version}.${id}${f.ext}`;
 const upload=await env.FILES.createMultipartUpload(key);
 try {
  const inserted=await env.DB.prepare(`INSERT INTO file_upload_sessions(id,file_id,project_id,actor_id,lifecycle_version,upload_id,r2_key,size_bytes,part_bytes,created_at,updated_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10 WHERE ${liveGuard('?2','?3','?4','?5',true)}`).bind(id,file,project,user,f.lifecycle_version,upload.uploadId,key,size,partBytes,nowIso()).run();
  if(!inserted.meta.changes)throw invalidState('文件或成员身份已变化');
 } catch(error) {
  try {await upload.abort();} catch { /* Orphan upload can be reconciled by storage lifecycle cleanup. */ }
  const winner=await existing();if(winner&&winner.size_bytes===size&&winner.actor_id===user)return {sessionId:winner.id,partBytes:winner.part_bytes};throw error;
 }
 return {sessionId:id,partBytes};
}
export async function multipartStatus(env:Env,project:string,file:string,user:string,id:string) {
 const s=await load(env,project,file,user,id);
 const parts=await env.DB.prepare('SELECT part_number partNumber,etag,size_bytes sizeBytes FROM file_upload_parts WHERE session_id=?1 ORDER BY part_number').bind(id).all();
 return {sessionId:id,status:s.status,partBytes:s.part_bytes,sizeBytes:s.size_bytes,parts:parts.results};
}
export async function putMultipartPart(env:Env,project:string,file:string,user:string,id:string,part:number,body:ReadableStream<Uint8Array>,declaredSize:number) {
 const s=await load(env,project,file,user,id);if(s.status!=='uploading')throw invalidState('上传已结束或正在完成');
 const expected=Math.min(s.part_bytes,s.size_bytes-(part-1)*s.part_bytes);
 if(!Number.isSafeInteger(part)||part<1||part>Math.ceil(s.size_bytes/s.part_bytes)||declaredSize!==expected)throw validationFailed('分片编号或大小不符');
 const owner=crypto.randomUUID(),now=nowIso(),expiry=new Date(Date.now()+LEASE_MS).toISOString();
 const claim=await env.DB.prepare(`INSERT INTO file_upload_part_leases(session_id,part_number,lease_owner,expires_at) SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM file_upload_sessions WHERE id=?1 AND status='uploading') AND ${liveGuard('?5','?6','?7','?8',true)} ON CONFLICT(session_id,part_number) DO UPDATE SET lease_owner=excluded.lease_owner,expires_at=excluded.expires_at WHERE file_upload_part_leases.expires_at<=?9`).bind(id,part,owner,expiry,file,project,user,s.lifecycle_version,now).run();
 if(!claim.meta.changes)throw invalidState('同一分片已有上传，请等待或在租约过期后重试');
 // An in-flight replacement must not leave an older ETag eligible for completion after lease expiry.
 await env.DB.prepare('DELETE FROM file_upload_parts WHERE session_id=?1 AND part_number=?2 AND EXISTS(SELECT 1 FROM file_upload_part_leases WHERE session_id=?1 AND part_number=?2 AND lease_owner=?3)').bind(id,part,owner).run();
 try {
  const fixed=new FixedLengthStream(expected),controller=new AbortController();
  const transfer=body.pipeTo(fixed.writable,{signal:controller.signal});
  const upload=env.FILES.resumeMultipartUpload(s.r2_key,s.upload_id).uploadPart(part,fixed.readable);
  let p:R2UploadedPart;
  try {[p]=await Promise.all([upload,transfer]);}catch(error){controller.abort(error);await Promise.allSettled([upload,transfer]);throw error;}
  const written=await env.DB.prepare(`INSERT INTO file_upload_parts(session_id,part_number,etag,size_bytes) SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM file_upload_sessions WHERE id=?1 AND status='uploading') AND EXISTS(SELECT 1 FROM file_upload_part_leases WHERE session_id=?1 AND part_number=?2 AND lease_owner=?5) AND ${liveGuard('?6','?7','?8','?9',true)} ON CONFLICT(session_id,part_number) DO UPDATE SET etag=excluded.etag,size_bytes=excluded.size_bytes`).bind(id,part,p.etag,expected,owner,file,project,user,s.lifecycle_version).run();
  if(!written.meta.changes)throw invalidState('上传已取消，文件/成员身份已变化或分片租约已被替换');
  return {partNumber:part,etag:p.etag,sizeBytes:expected};
 } finally {await env.DB.prepare('DELETE FROM file_upload_part_leases WHERE session_id=?1 AND part_number=?2 AND lease_owner=?3').bind(id,part,owner).run();}
}
async function claimOperation(env:Env,s:Upload,operation:'completing'|'aborting') {
 const token=crypto.randomUUID(),now=nowIso(),expiry=new Date(Date.now()+LEASE_MS).toISOString();
 const claim=await env.DB.prepare(`UPDATE file_upload_sessions SET status=?2,operation_token=?3,operation_expires_at=?4,updated_at=?5 WHERE id=?1 AND status IN ${operation==='completing'?"('uploading','completing')":"('uploading','completing','aborting')"} AND (operation_token IS NULL OR operation_expires_at<=?5) ${operation==='completing'?"AND NOT EXISTS(SELECT 1 FROM file_upload_part_leases WHERE session_id=?1 AND expires_at>?5)":''} AND ${liveGuard('?6','?7','?8','?9',true)}`).bind(s.id,operation,token,expiry,now,s.file_id,s.project_id,s.actor_id,s.lifecycle_version).run();
 if(!claim.meta.changes)throw invalidState('上传有进行中的分片、完成/取消操作，或身份已变化；请读取状态后重试');return token;
}
async function releaseOperation(env:Env,id:string,token:string,status?:'uploading') {
 await env.DB.prepare(`UPDATE file_upload_sessions SET operation_token=NULL,operation_expires_at=NULL${status?",status='uploading'":''},updated_at=?3 WHERE id=?1 AND operation_token=?2 AND status IN ('completing','aborting')`).bind(id,token,nowIso()).run();
}
export async function completeMultipart(env:Env,project:string,file:string,user:string,id:string) {
 const s=await load(env,project,file,user,id);
 if(s.status==='complete')return {fileId:file,status:'available'};
 if(!['uploading','completing'].includes(s.status))throw invalidState('上传已取消');
 // Recover pre-atomic implementations which published the file but not the session.
 const published=await env.DB.prepare("SELECT 1 FROM files WHERE id=?1 AND r2_key=?2 AND status='available' AND lifecycle_version=?3").bind(file,s.r2_key,s.lifecycle_version).first();
 if(published){const repaired=await env.DB.prepare(`UPDATE file_upload_sessions SET status='complete',operation_token=NULL,operation_expires_at=NULL WHERE id=?1 AND status IN ('uploading','completing') AND ${liveGuard('?2','?3','?4','?5')}`).bind(id,file,project,user,s.lifecycle_version).run();if(!repaired.meta.changes)throw invalidState('文件或成员身份已变化');return {fileId:file,status:'available'};}
 const token=await claimOperation(env,s,'completing');let completed=false;
 try {
  const parts=await env.DB.prepare('SELECT part_number partNumber,etag,size_bytes sizeBytes FROM file_upload_parts WHERE session_id=?1 ORDER BY part_number').bind(id).all<{partNumber:number;etag:string;sizeBytes:number}>();
  if(parts.results.length!==Math.ceil(s.size_bytes/s.part_bytes)||parts.results.some((p,i)=>p.partNumber!==i+1||p.sizeBytes!==Math.min(s.part_bytes,s.size_bytes-i*s.part_bytes))){await releaseOperation(env,id,token,'uploading');throw invalidState('存在未完成或尺寸错误的分片');}
  let object=await env.FILES.head(s.r2_key);
  if(!object)object=await env.FILES.resumeMultipartUpload(s.r2_key,s.upload_id).complete(parts.results.map(({partNumber,etag})=>({partNumber,etag})));
  completed=true;if(object.size!==s.size_bytes)throw unsupportedMediaType('上传对象大小与登记大小不符');
  const read=async(offset:number,length:number)=>{const o=await env.FILES.get(s.r2_key,{range:{offset,length}});if(!o)throw notFound('文件内容缺失');return new Uint8Array(await o.arrayBuffer());};
  const f=await activeFile(env,project,file,user);let mime:string;
  if(f.ext==='.docx')mime=await validateDocx(object.size,read);
  else if(f.ext==='.txt'||f.ext==='.md') {
   const obj=await env.FILES.get(s.r2_key);if(!obj)throw notFound('文件内容缺失');
   const reader=obj.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});
   try {while(true){const {done,value}=await reader.read();if(done)break;decoder.decode(value,{stream:true});}decoder.decode();}catch{throw unsupportedMediaType('文本不是有效 UTF-8');}finally{reader.releaseLock();}
   mime=f.ext==='.md'?'text/markdown; charset=utf-8':'text/plain; charset=utf-8';
  } else mime=validateUploadBytes(f.ext,await read(0,Math.min(16,object.size)));
  const result=await env.DB.batch([
   env.DB.prepare(`UPDATE files SET status='available',mime_detected=?2,size_bytes=?3,r2_key=?4 WHERE id=?1 AND ${liveGuard('?1','?5','?6','?7',true)} AND EXISTS(SELECT 1 FROM file_upload_sessions WHERE id=?8 AND status='completing' AND operation_token=?9)`).bind(file,mime,object.size,s.r2_key,project,user,s.lifecycle_version,id,token),
   env.DB.prepare(`UPDATE file_upload_sessions SET status='complete',operation_token=NULL,operation_expires_at=NULL,updated_at=?3 WHERE id=?1 AND status='completing' AND operation_token=?2 AND ${liveGuard('?4','?5','?6','?7')} AND EXISTS(SELECT 1 FROM files WHERE id=?4 AND status='available' AND r2_key=?8)`).bind(id,token,nowIso(),file,project,user,s.lifecycle_version,s.r2_key)
  ]);
  if(!result[0]?.meta.changes||!result[1]?.meta.changes)throw invalidState('文件生命周期、项目成员或完成租约已变化');
  return {fileId:file,status:'available'};
 } catch(error) {
  if(completed&&error instanceof AppError&&error.code==='UNSUPPORTED_MEDIA_TYPE') {
   await env.DB.batch([
    env.DB.prepare(`UPDATE files SET status='quarantined',r2_key=?2,gc_after=?3 WHERE id=?1 AND ${liveGuard('?1','?4','?5','?6',true)} AND EXISTS(SELECT 1 FROM file_upload_sessions WHERE id=?7 AND operation_token=?8)`).bind(file,s.r2_key,new Date(Date.now()+48*3600000).toISOString(),project,user,s.lifecycle_version,id,token),
    env.DB.prepare("UPDATE file_upload_sessions SET status='aborted',operation_token=NULL,operation_expires_at=NULL,updated_at=?3 WHERE id=?1 AND operation_token=?2").bind(id,token,nowIso())]);
  } else await releaseOperation(env,id,token,completed?undefined:'uploading');
  throw error;
 }
}
export async function abortMultipart(env:Env,project:string,file:string,user:string,id:string) {
 const s=await load(env,project,file,user,id);if(s.status==='complete')throw invalidState('文件已上传完成');if(s.status==='aborted')return {status:'aborted'};
 const token=await claimOperation(env,s,'aborting');
 try {
  const object=await env.FILES.head(s.r2_key);
  if(object)await env.FILES.delete(s.r2_key);else await env.FILES.resumeMultipartUpload(s.r2_key,s.upload_id).abort();
  const update=await env.DB.prepare(`UPDATE file_upload_sessions SET status='aborted',operation_token=NULL,operation_expires_at=NULL,updated_at=?3 WHERE id=?1 AND status='aborting' AND operation_token=?2 AND ${liveGuard('?4','?5','?6','?7',true)}`).bind(id,token,nowIso(),file,project,user,s.lifecycle_version).run();
  if(!update.meta.changes)throw invalidState('取消时文件生命周期或成员身份已变化');return {status:'aborted'};
 } catch(error){await releaseOperation(env,id,token);throw error;}
}
