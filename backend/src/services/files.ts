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

/** Shared validation for project and private draft uploads; no network or model calls. */
export function validateUploadBytes(ext: string, bytes: Uint8Array): string {
  if (!bytes.length) throw validationFailed('文件不能为空');
  if (bytes.byteLength > LIMITS.maxFileBytes) throw fileTooLarge(LIMITS.maxFileBytes);
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

  if (params.bytes.byteLength > LIMITS.maxFileBytes) {
    // 超限内容不落 R2；记录保留 pending，允许换更小文件重试
    throw fileTooLarge(LIMITS.maxFileBytes);
  }

  const spec = MAGIC_SPECS.find((m) => m.exts.includes(row.ext) && m.detect(params.bytes));
  let mimeDetected: string;
  if (spec) {
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
  params: { projectId: string; fileId: string },
): Promise<{ body: ArrayBuffer; mime: string }> {
  const row = await env.DB.prepare(
    'SELECT id, project_id, r2_key, status, mime_detected, deleted_at, lifecycle_version FROM files WHERE id = ?1',
  )
    .bind(params.fileId)
    .first<{ id: string; project_id: string; r2_key: string; status: FileStatus; mime_detected: string | null; deleted_at: string|null; lifecycle_version:number }>();
  if (!row || row.project_id !== params.projectId || row.deleted_at) throw notFound('文件不存在或已移入回收站');
  if (row.status !== 'available') throw notFound('文件不可用');
  const obj = await env.FILES.get(row.r2_key);
  if (!obj) throw notFound('文件内容缺失');
  const body = await obj.arrayBuffer();
  const active=await env.DB.prepare("SELECT 1 FROM files WHERE id=?1 AND project_id=?2 AND deleted_at IS NULL AND lifecycle_version=?3 AND status='available'").bind(row.id,params.projectId,row.lifecycle_version).first();
  if(!active) throw notFound('文件已移入回收站或生命周期已变化');
  return { body, mime: row.mime_detected ?? 'application/octet-stream' };
}
