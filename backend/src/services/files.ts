import { validateOfficePackage, isOfficeExtension, OFFICE_PACKAGES } from './docx-validation';
import { nowIso, newId, sha256Hex } from '../core/db';
import { fileTooLarge, invalidState, notFound, unsupportedMediaType, validationFailed } from '../core/errors';
import { ALLOWED_UPLOAD_EXTENSIONS, LIMITS } from '../core/limits';
import type { Env } from '../env';

export type FileStatus = 'pending' | 'available' | 'quarantined' | 'discarded';

export interface FileRow {
  id: string;
  project_id: string;
  r2_key: string;
  ext: string;
  status: FileStatus;
  deleted_at: string | null;
  lifecycle_version: number;
}

interface MagicSpec {
  exts: readonly string[];
  mime: string;
  detect: (b: Uint8Array) => boolean;
}

const startsWith = (b: Uint8Array, bytes: number[]): boolean =>
  bytes.every((v, i) => b[i] === v);

const MAGIC_SPECS: MagicSpec[] = [
  { exts: ['.mp3'], mime: 'audio/mpeg', detect: b => startsWith(b,[0x49,0x44,0x33]) || (b[0]===0xff && ((b[1] ?? 0)&0xe0)===0xe0) },
  { exts: ['.wav'], mime: 'audio/wav', detect: b => startsWith(b,[0x52,0x49,0x46,0x46]) && startsWith(b.subarray(8),[0x57,0x41,0x56,0x45]) },
  { exts: ['.m4a'], mime: 'audio/mp4', detect: b => startsWith(b.subarray(4),[0x66,0x74,0x79,0x70]) },
  { exts: ['.mp4'], mime: 'video/mp4', detect: b => startsWith(b.subarray(4),[0x66,0x74,0x79,0x70]) },
  { exts: ['.webm'], mime: 'video/webm', detect: b => startsWith(b,[0x1a,0x45,0xdf,0xa3]) },
  { exts: ['.pdf'], mime: 'application/pdf', detect: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) },
  {
    exts: ['.png'],
    mime: 'image/png',
    detect: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { exts: ['.jpg', '.jpeg'], mime: 'image/jpeg', detect: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  {
    exts: ['.webp'],
    mime: 'image/webp',
    detect: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  },
];

export function extOf(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx <= 0 || idx === fileName.length - 1) return '';
  return fileName.slice(idx).toLowerCase();
}
export const isMediaExtension = (ext: string) => ['.mp3','.wav','.m4a','.mp4','.webm'].includes(ext);
export const uploadLimit = (ext: string) => isMediaExtension(ext) ? LIMITS.maxMediaBytes : LIMITS.maxFileBytes;
/** Reject unbounded request bodies before allocating a full upload buffer. */
export async function readBoundedUpload(body:ReadableStream<Uint8Array>|null,limit:number):Promise<Uint8Array>{
  if(!body)return new Uint8Array();
  const reader=body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>limit){await reader.cancel();throw fileTooLarge(limit);}chunks.push(chunk.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}

/** Shared validation for project and private draft uploads; no network or model calls. */
export function validateUploadBytes(ext: string, bytes: Uint8Array): string {
  if (!bytes.length) throw validationFailed('文件不能为空');
  const limit = uploadLimit(ext);
  if (limit !== null && bytes.byteLength > limit) throw fileTooLarge(limit);
  if (isOfficeExtension(ext) && startsWith(bytes,[0x50,0x4b,0x03,0x04])) return OFFICE_PACKAGES[ext].mime;
  const spec = MAGIC_SPECS.find(m => m.exts.includes(ext) && m.detect(bytes));
  if (spec) return spec.mime;
  if (ext === '.txt' || ext === '.md') {
    try { new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
    catch { throw unsupportedMediaType('文本文件不是有效 UTF-8'); }
    return ext === '.md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
  }
  throw unsupportedMediaType('文件头与扩展名不符');
}

/** 步骤一：创建文件记录并分配服务端 R2 key（客户端不能指定对象路径） */
export async function createFileInit(
  env: Env,
  params: { projectId: string; uploaderUserId: string; fileName: string; contentType?: string; contributorIds?: string[]; derivedFromFileId?: string },
): Promise<{ fileId: string; uploadUrl: string }> {
  const ext = extOf(params.fileName);
  if (!(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    throw validationFailed(`不支持的文件扩展名「${ext || '(无)'}」`, {
      allowed: ALLOWED_UPLOAD_EXTENSIONS,
    });
  }
  if (params.derivedFromFileId && params.contributorIds) throw validationFailed('派生文件不能重新指定贡献人');
  const ids = [...new Set(params.contributorIds ?? [params.uploaderUserId])];
  if (!ids.length) throw validationFailed('请选择贡献成员');
  let contributors: Array<{user_id:string;display_name:string}>;
  if (params.derivedFromFileId) {
    const parent = await env.DB.prepare('SELECT 1 FROM files WHERE id=?1 AND project_id=?2 AND deleted_at IS NULL').bind(params.derivedFromFileId,params.projectId).first();
    if (!parent) throw validationFailed('派生原文件不属于当前项目或已删除');
    contributors = (await env.DB.prepare('SELECT user_id,display_name FROM file_contributors WHERE file_id=?1').bind(params.derivedFromFileId).all<{user_id:string;display_name:string}>()).results;
  } else {
    contributors = (await env.DB.prepare(`SELECT m.user_id,u.display_name FROM project_members m JOIN users u ON u.id=m.user_id
      WHERE m.project_id=?1 AND m.user_id IN (SELECT value FROM json_each(?2))`).bind(params.projectId,JSON.stringify(ids)).all<{user_id:string;display_name:string}>()).results;
    if (contributors.length !== ids.length) throw validationFailed('贡献人必须是当前项目成员');
  }
  const fileId = newId();
  const r2Key = `${params.projectId}/${fileId}${ext}`;
  const insert = env.DB.prepare(
    `INSERT INTO files (id, project_id, uploader_user_id, r2_key, mime_declared, ext, status, created_at, original_name)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?8
     WHERE EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=?3)
       AND ((?9 IS NOT NULL AND EXISTS(SELECT 1 FROM files WHERE id=?9 AND project_id=?2 AND deleted_at IS NULL))
         OR (?9 IS NULL AND NOT EXISTS(SELECT 1 FROM json_each(?10) requested WHERE NOT EXISTS(SELECT 1 FROM project_members WHERE project_id=?2 AND user_id=requested.value))))`,
  )
    .bind(fileId, params.projectId, params.uploaderUserId, r2Key, params.contentType ?? null, ext, nowIso(), params.fileName, params.derivedFromFileId ?? null, JSON.stringify(ids));
  const result = await env.DB.batch([insert, ...contributors.map(person => env.DB.prepare(
    `INSERT INTO file_contributors(file_id,user_id,display_name) SELECT ?1,?2,?3 WHERE EXISTS(SELECT 1 FROM files WHERE id=?1)`
  ).bind(fileId,person.user_id,person.display_name))]);
  if (!result[0]?.meta.changes) throw validationFailed('项目成员或原文件已变化，请刷新后重试');
  return {
    fileId,
    uploadUrl: `/api/v1/projects/${params.projectId}/files/${fileId}/content`,
  };
}

/** 隔离暂存：校验失败但字节已接收时落 R2，等待定时回收 */
async function quarantine(env: Env, row: FileRow, bytes: Uint8Array, reason: string): Promise<never> {
  const outputKey = `${row.project_id}/${row.id}.l${row.lifecycle_version}${row.ext}`;
  await env.FILES.put(outputKey, bytes);
  const gcAfter = new Date(Date.now() + LIMITS.quarantineGcHours * 3600_000).toISOString();
  await env.DB.prepare("UPDATE files SET status = 'quarantined', gc_after = ?2, r2_key=?4 WHERE id = ?1 AND status='pending' AND deleted_at IS NULL AND lifecycle_version=?3")
    .bind(row.id, gcAfter,row.lifecycle_version,outputKey)
    .run();
  throw unsupportedMediaType(reason);
}

/**
 * 步骤二：接收内容并校验。按实际上传字节限大小；
 * 核验文件头与扩展名一致性（文本类校验可 UTF-8 解码）；
 * 校验通过才置 available，sha256 与字节数落库。
 */
export async function storeFileContent(
  env: Env,
  params: { projectId: string; fileId: string; bytes: Uint8Array },
): Promise<{ sizeBytes: number; sha256: string; mimeDetected: string }> {
  const row = await env.DB.prepare(
    'SELECT id, project_id, r2_key, ext, status, deleted_at, lifecycle_version FROM files WHERE id = ?1',
  )
    .bind(params.fileId)
    .first<FileRow>();
  if (!row || row.project_id !== params.projectId || row.deleted_at) throw notFound('文件不存在或已移入回收站');
  if (row.status !== 'pending') throw invalidState('文件内容已上传，不能重复上传');
  if(!params.bytes.length)throw validationFailed('文件不能为空');
  const limit = uploadLimit(row.ext);
  if (limit !== null && params.bytes.byteLength > limit) {
    // Media limits remain independent of nullable document upload limits.
    throw fileTooLarge(limit);
  }

  const spec = MAGIC_SPECS.find((m) => m.exts.includes(row.ext) && m.detect(params.bytes));
  let mimeDetected: string;
  if (isOfficeExtension(row.ext)) {
    try { mimeDetected = await validateOfficePackage(row.ext, params.bytes.length, async (offset,length)=>params.bytes.slice(offset,offset+length)); }
    catch { return await quarantine(env,row,params.bytes,`${row.ext.slice(1).toUpperCase()} 包结构无效`); }
  } else if (spec) {
    mimeDetected = spec.mime;
  } else if (row.ext === '.txt' || row.ext === '.md') {
    try {
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(params.bytes);
    } catch {
      return await quarantine(env, row, params.bytes, '文本文件不是有效的 UTF-8 内容');
    }
    mimeDetected = row.ext === '.md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
  } else {
    return await quarantine(env, row, params.bytes, `文件头与扩展名「${row.ext}」不符`);
  }

  const sha = await sha256Hex(params.bytes);
  const outputKey = `${row.project_id}/${row.id}.l${row.lifecycle_version}${row.ext}`;
  await env.FILES.put(outputKey, params.bytes);
  const updated = await env.DB.prepare(
    "UPDATE files SET status = 'available', mime_detected = ?1, size_bytes = ?2, sha256 = ?3, r2_key=?5 WHERE id = ?4 AND status='pending' AND deleted_at IS NULL AND lifecycle_version=?6",
  )
    .bind(mimeDetected, params.bytes.byteLength, sha, row.id, outputKey,row.lifecycle_version)
    .run();
  if(!updated.meta.changes) throw invalidState('文件生命周期已变化，上传结果未应用');
  return { sizeBytes: params.bytes.byteLength, sha256: sha, mimeDetected };
}

/** 下载：调用方已完成项目成员校验；仅 available 状态可读 */
export async function readFileContent(
  env: Env,
  params: { projectId: string; fileId: string; range?: string },
): Promise<{ body: ReadableStream<Uint8Array>; mime: string; headers: Record<string,string>; status: 200 | 206 }> {
  const row = await env.DB.prepare(
    'SELECT id, project_id, r2_key, status, mime_detected, deleted_at, lifecycle_version, original_name FROM files WHERE id = ?1',
  )
    .bind(params.fileId)
    .first<{ id: string; project_id: string; r2_key: string; status: FileStatus; mime_detected: string | null; deleted_at: string|null; lifecycle_version:number; original_name:string|null }>();
  if (!row || row.project_id !== params.projectId || row.deleted_at) throw notFound('文件不存在或已移入回收站');
  if (row.status !== 'available') throw notFound('文件不可用');
  const rangeHeaders = new Headers(); if(params.range) rangeHeaders.set('range',params.range);
  const obj = await env.FILES.get(row.r2_key, params.range ? {range:rangeHeaders} : undefined);
  if (!obj) throw notFound('文件内容缺失');
  const body = obj.body;
  const active=await env.DB.prepare("SELECT 1 FROM files WHERE id=?1 AND project_id=?2 AND deleted_at IS NULL AND lifecycle_version=?3 AND status='available'").bind(row.id,params.projectId,row.lifecycle_version).first();
  if(!active) throw notFound('文件已移入回收站或生命周期已变化');
  const safeName = (row.original_name ?? 'file').replace(/[\r\n\x00-\x1f\x7f\/\\]/g, '_').slice(0, 200);
  const encodedName = encodeURIComponent(safeName).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
  const disposition = /^(?:text\/plain|application\/pdf|image\/|audio\/|video\/)/.test(row.mime_detected ?? '') ? 'inline' : 'attachment';
  const headers:Record<string,string>={'accept-ranges':'bytes','etag':obj.httpEtag, 'content-disposition': disposition + "; filename=\"file\"; filename*=UTF-8''" + encodedName, 'x-content-type-options':'nosniff', 'cross-origin-resource-policy':'same-origin'};
  const range=params.range?obj.range:undefined;
  if(range && 'offset' in range && 'length' in range) {headers['content-range']=`bytes ${range.offset}-${range.offset!+range.length!-1}/${obj.size}`;headers['content-length']=String(range.length);}
  else headers['content-length']=String(obj.size);
  return { body, mime: row.mime_detected ?? 'application/octet-stream',headers,status:range?206:200 };
}
