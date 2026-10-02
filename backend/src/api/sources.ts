import { contributorSchema, fileContributors } from '../services/file-contributors';
import { notificationStatements } from '../services/notifications';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireEnabledAiConfig } from '../ai/config';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireProjectMember, requireUser } from '../core/auth';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, validationFailed } from '../core/errors';
import { LIMITS } from '../core/limits';
import { nextCursor, parsePaging } from '../core/pagination';
import { loadActiveSourceVersion, sourceLifecycleGuard } from '../services/source-lifecycle';
import { changeSourceLifecycle } from '../services/file-lifecycle';
import { createJobAndDispatch } from '../services/jobs';
import { withIdempotency } from '../services/idempotency';
import { projectParams } from './projects';
import { resourcePurposeSchema } from './resources';
import type { ResourcePurpose } from '../services/resources';

const sourceParams = projectParams.extend({ sourceId: z.string().uuid() });
const versionParams = sourceParams.extend({ sourceVersionId: z.string().uuid() });

const createBody = z
  .object({
    kind: z.enum(['file', 'paste', 'web']),
    title: z.string().min(1).max(200).optional(),
    fileId: z.string().uuid().optional(),
    text: z.string().min(1).max(100_000).optional(),
    url: z.string().max(2048).optional(),
    purpose: resourcePurposeSchema.default('reference'),
  })
  .refine((v) => v.kind !== 'file' || !!v.fileId, { message: 'file 来源必须提供 fileId' })
  .refine((v) => v.kind !== 'paste' || !!v.text, { message: 'paste 来源必须提供 text' })
  .refine((v) => v.kind !== 'web' || !!v.url, { message: 'web 来源必须提供 url' });

const sourceSchema = z.object({
  contributors:z.array(contributorSchema).optional(),
  sourceId: z.string().uuid(),
  kind: z.enum(['file', 'paste', 'web']),
  title: z.string(),
  purpose: resourcePurposeSchema,
  revision: z.number().int().positive(),
  currentVersionId: z.string().uuid().nullable(),
  createdAt: z.string(),
  lifecycleVersion:z.number().int(),canDelete:z.boolean(),deletedAt:z.string().nullable(),fileId:z.string().uuid().nullable(),
});
const createResponse = apiEnvelope(
  sourceSchema.extend({ sourceVersionId: z.string().uuid() }),
  'SourceCreateResponse',
);
const listResponse = apiEnvelope(z.object({ items: z.array(sourceSchema), nextCursor: z.string().nullable() }), 'SourceListResponse');

const pageStatusSchema = z.object({
  pageNumber: z.number().int(),
  textStatus: z.enum(['none', 'extracted', 'empty']),
  imageStatus: z.enum(['none', 'uploaded', 'rejected']),
  ocrStatus: z.enum(['none', 'pending', 'ok', 'failed']),
  needsReview: z.boolean(),
});
const versionResponse = apiEnvelope(
  z.object({
    contributors:z.array(contributorSchema).optional(),
    sourceVersionId: z.string().uuid(),
    sourceId: z.string().uuid(),
    revision: z.number().int(),
    origin: z.enum(['file', 'web', 'paste']),
    fileId: z.string().uuid().nullable(),
    status: z.enum(['pending', 'processing', 'ready', 'failed']),
    parseError: z.string().nullable(),
    pageCount: z.number().int().nullable(),
    charCount: z.number().int().nullable(),
    pages: z.array(pageStatusSchema),
    processingJob: z.object({ jobId:z.string().uuid(), status:z.enum(['queued','running','waiting_input']), phase:z.enum(['extract','ocr']) }).nullable().optional(),
  }),
  'SourceVersionResponse',
);

const fragmentsRoute = createRoute({
  method: 'get', path: '/api/v1/projects/{projectId}/sources/{sourceId}/versions/{sourceVersionId}/fragments', tags: ['sources'],
  summary: '来源全文引用片段', request: { params: versionParams, query: z.object({ cursor: z.string().optional(), limit: z.string().optional() }) },
  responses: { 200: { content: { 'application/json': { schema: apiEnvelope(z.object({ items: z.array(z.object({ fragmentId: z.string(), pageNumber: z.number().nullable(), content: z.string(), kind: z.string(), seq: z.number() })), nextCursor: z.string().nullable() }), 'SourceFragmentListResponse') } }, description: '可引用片段' } },
});

const parseResponse = apiEnvelope(
  z.object({ jobId: z.string().uuid(), status: z.string() }),
  'SourceParseResponse',
);

const renderRequestsResponse = apiEnvelope(
  z.object({ items: z.array(z.object({ pageNumber: z.number().int() })) }),
  'RenderRequestsResponse',
);

const pageImagesBody = z.object({
  sourceVersionId: z.string().uuid(),
  images: z
    .array(
      z.object({
        pageNumber: z.number().int().min(1).max(LIMITS.maxPdfPages),
        fileId: z.string().uuid(),
      }),
    )
    .min(1)
    .max(LIMITS.maxPdfPages),
});
const pageImagesResponse = apiEnvelope(
  z.object({
    accepted: z.number().int(),
    remaining: z.number().int(),
    jobId: z.string().uuid().nullable(),
  }),
  'PageImagesResponse',
);

const sourceCreateRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/sources',
  tags: ['sources'],
  summary: '导入来源（文件/粘贴文本/网页链接）并创建来源版本',
  request: { params: projectParams, body: { content: { 'application/json': { schema: createBody } }, required: true } },
  responses: {
    201: { content: { 'application/json': { schema: createResponse } }, description: '已创建' },
    400: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '参数不合法' },
  },
});

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/sources',
  tags: ['sources'],
  summary: '来源列表（游标分页）',
  request: { params: projectParams, query: z.object({ deleted:z.enum(['true','false']).optional(),cursor: z.string().optional(), limit: z.string().optional() }) },
  responses: { 200: { content: { 'application/json': { schema: listResponse } }, description: '列表' } },
});

const versionRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/sources/{sourceId}/versions/{sourceVersionId}',
  tags: ['sources'],
  summary: '来源版本详情（含逐页处理状态）',
  request: { params: versionParams },
  responses: { 200: { content: { 'application/json': { schema: versionResponse } }, description: '版本详情' } },
});

const parseRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/sources/{sourceId}/parse',
  tags: ['sources'],
  summary: '发起解析（异步，202 + jobId）',
  request: { params: sourceParams, body: { content: { 'application/json': { schema: z.object({ sourceVersionId: z.string().uuid().optional() }) } }, required: true } },
  responses: {
    202: { content: { 'application/json': { schema: parseResponse } }, description: '任务已排队' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '状态不允许解析' },
  },
});

const renderRequestsRoute = createRoute({
  method: 'get',
  path: '/api/v1/projects/{projectId}/sources/{sourceId}/render-requests',
  tags: ['sources'],
  summary: '获取需要前端 PDF.js 渲染上传的页码（扫描页）',
  request: { params: sourceParams, query: z.object({ sourceVersionId: z.string().uuid().optional() }) },
  responses: { 200: { content: { 'application/json': { schema: renderRequestsResponse } }, description: '待渲染页码' } },
});

const pageImagesRoute = createRoute({
  method: 'post',
  path: '/api/v1/projects/{projectId}/sources/{sourceId}/page-images',
  tags: ['sources'],
  summary: '上传页面图片（绑定 sourceVersionId+pageNumber），全部就绪后自动触发 OCR',
  request: { params: sourceParams, body: { content: { 'application/json': { schema: pageImagesBody } }, required: true } },
  responses: {
    202: { content: { 'application/json': { schema: pageImagesResponse } }, description: '已接收（可能返回 OCR jobId）' },
    400: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '页码/文件不合法' },
  },
});

interface SourceRow {
  id: string;
  project_id: string;
  kind: 'file' | 'paste' | 'web';
  title: string;
  purpose: ResourcePurpose;
  resource_revision: number;
  current_version_id: string | null;
  created_at: string;
  created_by:string;deleted_at:string|null;lifecycle_version:number;file_id:string|null;
}

interface VersionRow {
  id: string;
  source_id: string;
  revision: number;
  origin: 'file' | 'web' | 'paste';
  file_id: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  parse_error: string | null;
  page_count: number | null;
  char_count: number | null;
}

interface PageRow {
  page_number: number;
  text_status: 'none' | 'extracted' | 'empty';
  image_status: 'none' | 'uploaded' | 'rejected';
  ocr_status: 'none' | 'pending' | 'ok' | 'failed';
  needs_review: number;
}

async function projectSourceVersion(env: AppEnv['Bindings'], projectId: string, sourceId: string, versionId: string): Promise<VersionRow> {
  await loadActiveSourceVersion(env,versionId);
  const version = await env.DB.prepare(
    'SELECT id, source_id, revision, origin, file_id, status, parse_error, page_count, char_count FROM source_versions WHERE id = ?1 AND source_id = ?2 AND project_id = ?3',
  ).bind(versionId, sourceId, projectId).first<VersionRow>();
  if (!version) throw notFound('来源版本不存在');
  return version;
}

const sourceLifecycleBody=z.object({expectedLifecycleVersion:z.number().int().positive()}).strict();
const sourceLifecycleResponse=apiEnvelope(z.object({sourceId:z.string().uuid(),deletedAt:z.string().nullable(),lifecycleVersion:z.number().int()}),'SourceLifecycleResponse');
const deleteSourceRoute=createRoute({method:'delete',path:'/api/v1/projects/{projectId}/sources/{sourceId}',tags:['sources'],summary:'粘贴或网页来源移入回收站，保留历史引用',
  request:{params:sourceParams,body:{required:true,content:{'application/json':{schema:sourceLifecycleBody}}}},responses:{200:{description:'已移入回收站',content:{'application/json':{schema:sourceLifecycleResponse}}}}});
const restoreSourceRoute=createRoute({method:'post',path:'/api/v1/projects/{projectId}/sources/{sourceId}/restore',tags:['sources'],summary:'恢复粘贴或网页来源，不自动启动 AI',
  request:{params:sourceParams,body:{required:true,content:{'application/json':{schema:sourceLifecycleBody}}}},responses:{200:{description:'已恢复',content:{'application/json':{schema:sourceLifecycleResponse}}}}});

export function registerSourceRoutes(app: OpenAPIHono<AppEnv>): void {
  // * 通配覆盖 /sources 下所有深度（含 parse / page-images / versions 等）
  app.use('/api/v1/projects/:projectId/sources', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/sources/*', requireUser, requireProjectMember());

  app.openapi(deleteSourceRoute,async c=>{
    c.header('Cache-Control','no-store');const p=c.req.valid('param');
    return c.json(apiData(c,await changeSourceLifecycle(c.env,{...p,actorId:c.get('user')!.id,expectedLifecycleVersion:c.req.valid('json').expectedLifecycleVersion,restore:false})),200);
  });
  app.openapi(restoreSourceRoute,async c=>{
    c.header('Cache-Control','no-store');const p=c.req.valid('param');
    return c.json(apiData(c,await changeSourceLifecycle(c.env,{...p,actorId:c.get('user')!.id,expectedLifecycleVersion:c.req.valid('json').expectedLifecycleVersion,restore:true})),200);
  });

  app.openapi(sourceCreateRoute, async (c) => {
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const user = c.get('user')!;
    const sourceId = newId();
    const versionId = newId();
    const now = nowIso();
    const title =
      body.title ??
      (body.kind === 'file' ? '通知文件' : body.kind === 'web' ? (new URL(body.url!).hostname) : '粘贴文本');

    let fileLifecycleVersion:number|null=null;
    if (body.kind === 'file') {
      const file = await c.env.DB.prepare(
        "SELECT id, project_id, status, ext, deleted_at, lifecycle_version FROM files WHERE id = ?1",
      )
        .bind(body.fileId!)
        .first<{ id: string; project_id: string; status: string; ext: string;deleted_at:string|null;lifecycle_version:number }>();
      if (!file || file.project_id !== member.projectId || file.deleted_at) throw notFound('文件不存在或已移入回收站');
      fileLifecycleVersion=file.lifecycle_version;
      if (file.status !== 'available') throw invalidState('文件尚未上传或不可用');
      if (!['.pdf', '.txt', '.md'].includes(file.ext)) throw validationFailed('来源文件仅支持 PDF/TXT/Markdown');
    }
    if (body.kind === 'web') {
      try {
        new URL(body.url!);
      } catch {
        throw validationFailed('无效的 URL');
      }
    }

    const inserts = [
      c.env.DB.prepare(
        `INSERT INTO sources (id, project_id, kind, title, current_version_id, created_by, created_at, updated_at, purpose) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?10 WHERE ?3!='file' OR EXISTS(SELECT 1 FROM files WHERE id=?8 AND project_id=?2 AND status='available' AND deleted_at IS NULL AND lifecycle_version=?9)`,
      ).bind(sourceId, member.projectId, body.kind, title, versionId, user.id, now,body.fileId??null,fileLifecycleVersion,body.purpose),
      c.env.DB.prepare(
        `INSERT INTO source_versions (id, source_id, project_id, revision, origin, file_id, url, text_r2_key, status, created_at)
         SELECT ?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, 'pending', ?8 WHERE EXISTS(SELECT 1 FROM sources WHERE id=?2)`,
      ).bind(
        versionId,
        sourceId,
        member.projectId,
        body.kind,
        body.fileId ?? null,
        body.url ?? null,
        null,
        now,
      ),
    ];
    if (body.kind === 'paste' && body.text) {
      inserts.push(
        c.env.DB.prepare('UPDATE source_versions SET text_r2_key = ?2 WHERE id = ?1').bind(
          versionId,
          `sources/${versionId}/paste.txt`,
        ),
      );
    }
    inserts.push(...notificationStatements(c.env, { key: `source_added:${sourceId}`, kind: 'source_added', scope: 'project', resourceId: member.projectId, actorId: user.id, now, url: `/app/projects/${member.projectId}/sources`, record: { table: 'sources', id: sourceId } }));
    const created=await c.env.DB.batch(inserts);
    if(!created[0]?.meta.changes) throw invalidState('原文件生命周期已变化，来源未创建');
    if (body.kind === 'paste' && body.text) {
      await c.env.FILES.put(`sources/${versionId}/paste.txt`, body.text);
      await c.env.DB.prepare('UPDATE source_versions SET char_count = ?2 WHERE id = ?1')
        .bind(versionId, body.text.length)
        .run();
    }
    return c.json(
      apiData(c, {
        sourceId,
        sourceVersionId: versionId,
        kind: body.kind,
        title,
        purpose: body.purpose, revision: 1,
        currentVersionId: versionId,
        contributors:await fileContributors(c.env,member.projectId,body.fileId??null),createdAt: now,lifecycleVersion:1,canDelete:true,deletedAt:null,fileId:body.fileId??null,
      }),
      201,
    );
  });

  app.openapi(listRoute, async (c) => {
    const member = c.get('member')!;
    c.header('Cache-Control','no-store');
    const query=c.req.valid('query');const { limit, cursor } = parsePaging(query);
    const rows = await c.env.DB.prepare(
      `SELECT id, project_id, kind, title, purpose, resource_revision, current_version_id, created_at,created_by,deleted_at,lifecycle_version,
        (SELECT file_id FROM source_versions WHERE id=sources.current_version_id) AS file_id FROM sources
       WHERE project_id = ?1 AND (deleted_at IS NOT NULL)=?5
       AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3))
       ORDER BY created_at DESC, id DESC LIMIT ?4`,
    )
      .bind(member.projectId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1,query.deleted==='true'?1:0)
      .all<SourceRow>();
    const hasMore = rows.results.length > limit;
    const items = await Promise.all(rows.results.slice(0, limit).map(async (r) => ({
      contributors:await fileContributors(c.env,member.projectId,r.file_id),
      sourceId: r.id,
      kind: r.kind,
      title: r.title,
      purpose: r.purpose, revision: r.resource_revision + r.lifecycle_version - 1,
      currentVersionId: r.current_version_id,
      createdAt: r.created_at,lifecycleVersion:r.lifecycle_version,canDelete:member.role==='owner'||r.created_by===c.get('user')!.id,deletedAt:r.deleted_at,fileId:r.file_id,
    })));
    const lastItem = items.at(-1);
    return c.json(
      apiData(c, {
        items,
        nextCursor: nextCursor(hasMore, lastItem && { createdAt: lastItem.createdAt, id: lastItem.sourceId }) ?? null,
      }),
      200,
    );
  });

  app.openapi(versionRoute, async (c) => {
    const { sourceId, sourceVersionId } = c.req.valid('param');
    const version = await projectSourceVersion(c.env, c.get('member')!.projectId, sourceId, sourceVersionId);
    const pages = await c.env.DB.prepare(
      'SELECT page_number, text_status, image_status, ocr_status, needs_review FROM source_pages WHERE source_version_id = ?1 ORDER BY page_number',
    )
      .bind(sourceVersionId)
      .all<PageRow>();
    const processingJob = await c.env.DB.prepare(`SELECT id, status, json_extract(input_json,'$.phase') AS phase FROM jobs WHERE project_id = ?1 AND kind IN ('parse_source','ocr_pages','requirement_extract') AND status IN ('queued','running','waiting_input') AND json_extract(input_json,'$.sourceVersionId') = ?2 AND COALESCE(json_extract(input_json,'$.operation'),'') != 'source.summary' ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, updated_at DESC LIMIT 1`).bind(c.get('member')!.projectId,sourceVersionId).first<{id:string;status:'queued'|'running'|'waiting_input';phase:string}>();
    return c.json(
      apiData(c, {
        sourceVersionId: version.id,
        sourceId: version.source_id,
        revision: version.revision,
        origin: version.origin,
        fileId: version.file_id,
        contributors:await fileContributors(c.env,c.get('member')!.projectId,version.file_id),
        status: version.status,
        parseError: version.parse_error,
        pageCount: version.page_count,
        charCount: version.char_count,
        pages: pages.results.map((p) => ({
          pageNumber: p.page_number,
          textStatus: p.text_status,
          imageStatus: p.image_status,
          ocrStatus: p.ocr_status,
          needsReview: p.needs_review === 1,
        })),
        processingJob: processingJob ? { jobId:processingJob.id, status:processingJob.status, phase:processingJob.phase === 'ocr' ? 'ocr' as const : 'extract' as const } : null,
      }),
      200,
    );
  });

  app.openapi(fragmentsRoute, async (c) => {
    const { sourceId, sourceVersionId } = c.req.valid('param');
    await projectSourceVersion(c.env, c.get('member')!.projectId, sourceId, sourceVersionId);
    const query = c.req.valid('query');
    const limit = parsePaging(query).limit;
    const after = Number(query.cursor ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw validationFailed('片段游标无效');
    const rows = await c.env.DB.prepare('SELECT id, page_number, content, kind, seq FROM source_fragments WHERE source_version_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3').bind(sourceVersionId, after, limit + 1).all<{ id: string; page_number: number | null; content: string; kind: string; seq: number }>();
    const page = rows.results.slice(0, limit);
    return c.json(apiData(c, { items: page.map(r => ({ fragmentId: r.id, pageNumber: r.page_number, content: r.content, kind: r.kind, seq: r.seq })), nextCursor: rows.results.length > limit ? String(page.at(-1)!.seq) : null }), 200);
  });

  app.openapi(parseRoute, async (c) => {
    const { sourceId } = c.req.valid('param');
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const source = await c.env.DB.prepare(
      'SELECT id, current_version_id FROM sources WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL',
    )
      .bind(sourceId, member.projectId)
      .first<{ id: string; current_version_id: string | null }>();
    if (!source) throw notFound('来源不存在');
    const versionId = body.sourceVersionId ?? source.current_version_id;
    if (!versionId) throw invalidState('来源没有可解析的版本');
    await projectSourceVersion(c.env, member.projectId, sourceId, versionId);
    const lifecycle=await loadActiveSourceVersion(c.env,versionId);
    await requireEnabledAiConfig(c.env.DB);
    const result = await withIdempotency(c.env, {
      key: c.req.header('idempotency-key'), userId: c.get('user')!.id,
      operation: `source.parse:${member.projectId}:${sourceId}`, rawBody: JSON.stringify(body),
    }, async () => {
      const active = await c.env.DB.prepare("SELECT id FROM jobs WHERE project_id=?1 AND kind IN ('parse_source','ocr_pages','requirement_extract') AND status IN ('queued','running') AND json_extract(input_json,'$.sourceVersionId')=?2 AND COALESCE(json_extract(input_json,'$.operation'),'')!='source.summary' LIMIT 1").bind(member.projectId,versionId).first();
      if (active) throw invalidState('此来源已有解析任务正在运行，请等待或刷新状态');
      // Explicit reread supersedes obsolete scan-page waits; it never replays
      // every source or deletes the original file/results.
      const now = nowIso();
      await c.env.DB.batch([
        c.env.DB.prepare("UPDATE jobs SET status='cancelled',updated_at=?3,finished_at=?3 WHERE project_id=?1 AND kind IN ('parse_source','ocr_pages','requirement_extract') AND status='waiting_input' AND json_extract(input_json,'$.sourceVersionId')=?2 AND COALESCE(json_extract(input_json,'$.operation'),'')!='source.summary'").bind(member.projectId,versionId,now),
        c.env.DB.prepare("UPDATE job_outbox SET status='failed',last_error='SUPERSEDED_SOURCE_REREAD',updated_at=?3 WHERE job_id IN (SELECT id FROM jobs WHERE project_id=?1 AND status='cancelled' AND updated_at=?3 AND json_extract(input_json,'$.sourceVersionId')=?2)").bind(member.projectId,versionId,now),
      ]);
      const jobId = await createJobAndDispatch(c.env, {
        projectId: member.projectId,
        kind: 'parse_source',
        input: { sourceId, sourceVersionId: versionId, sourceLifecycleVersion:lifecycle.lifecycleVersion, phase: 'extract' },
        createdBy: c.get('user')!.id,
      });
      return { status: 202 as const, body: { jobId, status: 'queued' } };
    });
    return c.json(apiData(c, result.body), result.status);
  });

  app.openapi(renderRequestsRoute, async (c) => {
    const { sourceId } = c.req.valid('param');
    const sourceVersionId = c.req.valid('query').sourceVersionId;
    const source = await c.env.DB.prepare('SELECT id, current_version_id FROM sources WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL')
      .bind(sourceId, c.get('member')!.projectId)
      .first<{ id: string; current_version_id: string | null }>();
    if (!source) throw notFound('来源不存在');
    const versionId = sourceVersionId ?? source.current_version_id;
    if (!versionId) throw notFound('来源版本不存在');
    await projectSourceVersion(c.env, c.get('member')!.projectId, sourceId, versionId);
    const pages = await c.env.DB.prepare(
      "SELECT page_number FROM source_pages WHERE source_version_id = ?1 AND text_status = 'none' AND (image_status = 'none' OR ocr_status = 'failed') ORDER BY page_number",
    )
      .bind(versionId)
      .all<{ page_number: number }>();
    return c.json(apiData(c, { items: pages.results.map((p) => ({ pageNumber: p.page_number })) }), 200);
  });

  app.openapi(pageImagesRoute, async (c) => {
    const { sourceId } = c.req.valid('param');
    const body = c.req.valid('json');
    const member = c.get('member')!;
    const source = await c.env.DB.prepare('SELECT id, current_version_id FROM sources WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL')
      .bind(sourceId, member.projectId)
      .first<{ id: string; current_version_id: string | null }>();
    if (!source) throw notFound('来源不存在');
    const versionId = body.sourceVersionId || source.current_version_id;
    if (!versionId) throw invalidState('来源没有版本');
    await projectSourceVersion(c.env, member.projectId, sourceId, versionId);
    const lifecycle=await loadActiveSourceVersion(c.env,versionId);

    const result = await withIdempotency(c.env, {
      key: c.req.header('idempotency-key'), userId: c.get('user')!.id,
      operation: `source.page-images:${member.projectId}:${sourceId}`, rawBody: JSON.stringify(body),
    }, async () => {
      if (new Set(body.images.map(image => image.pageNumber)).size !== body.images.length) {
        throw validationFailed('同一次请求不能重复提交同一页');
      }
      for (const img of body.images) {
        const page = await c.env.DB.prepare(
          'SELECT id, text_status, image_status, ocr_status FROM source_pages WHERE source_version_id = ?1 AND page_number = ?2',
        )
          .bind(versionId, img.pageNumber)
          .first<{ id: string; text_status: string; image_status: string; ocr_status: string }>();
        if (!page) throw validationFailed(`页码 ${img.pageNumber} 不存在（尚未解析或超出页数）`);
        if (page.text_status === 'extracted') throw validationFailed(`页码 ${img.pageNumber} 已有文本层，无需图片`);
        if (page.image_status !== 'none' && page.ocr_status !== 'failed') throw invalidState(`页码 ${img.pageNumber} 的图片已上传`);
        const file = await c.env.DB.prepare("SELECT id, project_id, status, ext, deleted_at, lifecycle_version FROM files WHERE id = ?1")
          .bind(img.fileId)
          .first<{ id: string; project_id: string; status: string; ext: string;deleted_at:string|null;lifecycle_version:number }>();
        if (!file || file.project_id !== member.projectId || file.deleted_at) throw notFound(`页码 ${img.pageNumber} 的图片文件不存在`);
        if (file.status !== 'available') throw invalidState(`页码 ${img.pageNumber} 的图片文件不可用`);
        if (!['.png', '.jpg', '.jpeg', '.webp'].includes(file.ext)) throw validationFailed('页面图片仅支持 PNG/JPEG/WEBP');
      }

      // Validate the whole payload first, then apply every page in one atomic statement.
      // The count guard makes concurrent submissions fail without a partial write.
      const updated = await c.env.DB.prepare(`
        UPDATE source_pages SET
          image_file_id = (SELECT json_extract(value, '$.fileId') FROM json_each(?2)
            WHERE json_extract(value, '$.pageNumber') = source_pages.page_number),
          image_status = 'uploaded', ocr_status = 'pending', updated_at = ?3
        WHERE source_version_id = ?1 AND ${sourceLifecycleGuard('?1','?4')}
          AND NOT EXISTS(SELECT 1 FROM json_each(?2) supplied LEFT JOIN files f ON f.id=json_extract(supplied.value,'$.fileId') WHERE f.id IS NULL OR f.project_id!=?5 OR f.deleted_at IS NOT NULL OR f.status!='available')
          AND page_number IN (SELECT json_extract(value, '$.pageNumber') FROM json_each(?2))
          AND (SELECT COUNT(*) FROM source_pages eligible
            WHERE eligible.source_version_id = ?1 AND (eligible.image_status = 'none' OR eligible.ocr_status = 'failed')
              AND eligible.text_status != 'extracted'
              AND eligible.page_number IN (SELECT json_extract(value, '$.pageNumber') FROM json_each(?2))) = json_array_length(?2)
      `).bind(versionId, JSON.stringify(body.images), nowIso(),lifecycle.lifecycleVersion,member.projectId).run();
      const accepted = updated.meta.changes;
      if (accepted !== body.images.length) throw invalidState('页面状态已发生变化，请刷新后重新提交');

      const remaining = await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM source_pages WHERE source_version_id = ?1 AND text_status = 'none' AND image_status = 'none'",
      )
        .bind(versionId)
        .first<{ n: number }>();

      let jobId: string | null = null;
      if ((remaining?.n ?? 0) === 0 && accepted > 0) {
        jobId = await createJobAndDispatch(c.env, {
          projectId: member.projectId,
          kind: 'ocr_pages',
          input: { sourceId, sourceVersionId: versionId, sourceLifecycleVersion:lifecycle.lifecycleVersion, phase: 'ocr' },
          createdBy: c.get('user')!.id,
        });
      }
      return { status: 202 as const, body: { accepted, remaining: remaining?.n ?? 0, jobId } };
    });
    return c.json(apiData(c, result.body), result.status);
  });
}
