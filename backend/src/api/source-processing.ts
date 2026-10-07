import { aiActivitySchema, readActivity } from '../services/ai-activity';
import { audioStatusSchema, audioResumeSchema } from './audio-schema';
import { readAudioPipelineStatus, resumeWaitingAudioFallback } from '../services/audio-pipeline';
import { mediaSummarySchema } from '../ai/gemini-media';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireProjectMember, requireUser } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope, apiErrorEnvelope } from '../core/openapi';
import { sourceLifecycleGuard } from '../services/source-lifecycle';
import { notFound } from '../core/errors';
import { documentSummarySchema, enqueueSourceSummary } from '../services/source-summary';
import { withIdempotency } from '../services/idempotency';

const params = z.object({ projectId: z.string().uuid(), sourceId: z.string().uuid(), sourceVersionId: z.string().uuid() });
const path = '/api/v1/projects/{projectId}/sources/{sourceId}/versions/{sourceVersionId}/processing';
const response = apiEnvelope(z.object({
  media:z.object({jobId:z.string().uuid().optional(),audio:audioStatusSchema.nullable().optional(),stage:z.string(),summary:mediaSummarySchema.nullable(),error:z.string().nullable(),durationSeconds:z.number().nullable(),completedWindows:z.number().int()}).nullable().optional(),
  processingJobId:z.string().uuid().nullable(),
  activity:aiActivitySchema.nullable(),
  textStatus: z.enum(['pending','processing','waiting_input','ready','failed']),
  requirementsStatus: z.enum(['pending','processing','ready','failed']), requirementsError: z.string().nullable(),
  summaryStatus: z.enum(['pending','queued','running','ready','failed','cancelled']),
  summary: documentSummarySchema.nullable(), summaryError: z.string().nullable(), summaryJobId: z.string().uuid().nullable(),
  summaryRevision: z.number().int(), coveredChars: z.number().int().nullable(), totalChars: z.number().int().nullable(),
}), 'SourceProcessingResponse');
const read = createRoute({ method: 'get', path, tags: ['sources'], summary: '查看正文、要求提取与文件总结的独立状态', request: { params }, responses: { 200: { description: '处理状态', content: { 'application/json': { schema: response } } } } });
const retry = createRoute({ method: 'post', path: `${path}/summary`, tags: ['sources'], summary: '单独生成或重试文件总结（不重复上传、不重新 OCR）', request: { params, body: { required: true, content: { 'application/json': { schema: z.object({ expectedSummaryRevision: z.number().int().nonnegative() }).strict() } } } }, responses: {
  202: { description: '总结已排队', content: { 'application/json': { schema: apiEnvelope(z.object({ jobId: z.string().uuid(), revision: z.number().int() }), 'SourceSummaryStartResponse') } } },
  409: { description: '正文未就绪或总结状态已变化', content: { 'application/json': { schema: apiErrorEnvelope } } },
} });

export function registerSourceProcessingRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/projects/:projectId/sources/:sourceId/versions/:sourceVersionId/processing/*', requireUser, requireProjectMember());
  app.use('/api/v1/projects/:projectId/sources/:sourceId/versions/:sourceVersionId/processing', requireUser, requireProjectMember());
  const lookup = async (db: D1Database, projectId: string, sourceId: string, versionId: string) => {
    const version = await db.prepare(`SELECT status, char_count, parse_error FROM source_versions WHERE id = ?1 AND source_id = ?2 AND project_id = ?3 AND ${sourceLifecycleGuard('source_versions.id','NULL')}`).bind(versionId, sourceId, projectId).first<{ status: string; char_count: number | null; parse_error: string | null }>();
    if (!version) throw notFound('来源版本不存在');
    return version;
  };
  app.openapi(read, async c => {
    c.header('Cache-Control', 'no-store');
    const p = c.req.valid('param'); const version = await lookup(c.env.DB,p.projectId,p.sourceId,p.sourceVersionId);
    const state = await c.env.DB.prepare('SELECT * FROM source_processing WHERE source_version_id = ?1').bind(p.sourceVersionId).first<{ text_status: 'pending'|'processing'|'waiting_input'|'ready'|'failed'; requirements_status: 'pending'|'processing'|'ready'|'failed'; requirements_error: string|null; summary_status: 'pending'|'queued'|'running'|'ready'|'failed'|'cancelled'; summary_json: string|null; summary_error: string|null; summary_job_id: string|null; summary_revision: number; covered_chars: number|null; total_chars: number|null }>();
    const missing = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM source_pages WHERE source_version_id = ?1 AND text_status = 'none' AND ocr_status != 'ok'").bind(p.sourceVersionId).first<{ n: number }>();
    const textStatus = state?.text_status ?? (missing?.n ? 'waiting_input' : version.char_count ? 'ready' : version.status === 'failed' ? 'failed' : 'pending');
    const mediaState=await c.env.DB.prepare('SELECT job_id,stage,summary_json,error,duration_seconds,windows_json FROM media_processing WHERE source_version_id=?1 ORDER BY created_at DESC LIMIT 1').bind(p.sourceVersionId).first<{job_id:string;stage:string;summary_json:string|null;error:string|null;duration_seconds:number|null;windows_json:string}>();
    const media=mediaState?{jobId:mediaState.job_id,audio:await readAudioPipelineStatus(c.env,mediaState.job_id),stage:mediaState.stage,summary:mediaState.summary_json?mediaSummarySchema.parse(JSON.parse(mediaState.summary_json)):null,error:mediaState.error,durationSeconds:mediaState.duration_seconds,completedWindows:(JSON.parse(mediaState.windows_json) as unknown[]).length}:null;
    const processingJob=await c.env.DB.prepare("SELECT id,status FROM jobs WHERE project_id=?1 AND json_extract(input_json,'$.sourceVersionId')=?2 AND kind IN ('parse_source','ocr_pages','requirement_extract') AND COALESCE(json_extract(input_json,'$.operation'),'') NOT IN ('source.summary','media.summary') ORDER BY created_at DESC,id DESC LIMIT 1").bind(p.projectId,p.sourceVersionId).first<{id:string;status:string}>();
    const summary = state?.summary_json ? documentSummarySchema.safeParse(JSON.parse(state.summary_json)) : null;
    return c.json(apiData(c, { media,processingJobId:processingJob?.id??null,activity:processingJob?await readActivity(c.env,processingJob.id,processingJob.status):null,textStatus, requirementsStatus: state?.requirements_status ?? (version.status === 'ready' ? 'ready' : version.status === 'failed' && textStatus === 'ready' ? 'failed' : 'pending'), requirementsError: state?.requirements_error ?? (textStatus === 'ready' && version.status === 'failed' ? version.parse_error : null), summaryStatus: state?.summary_status ?? 'pending', summary: summary?.success ? summary.data : null, summaryError: state?.summary_error ?? null, summaryJobId: state?.summary_job_id ?? null, summaryRevision: state?.summary_revision ?? 0, coveredChars: state?.covered_chars ?? null, totalChars: state?.total_chars ?? null }),200);
  });
  app.openapi(createRoute({method:'post',path:`${path}/media-resume`,tags:['sources'],summary:'配置 Gemini 后继续音频回退，不重复转录',request:{params,body:{required:true,content:{'application/json':{schema:z.object({jobId:z.string().uuid()}).strict()}}}},responses:{202:{description:'原任务已恢复',content:{'application/json':{schema:apiEnvelope(audioResumeSchema,'AudioFallbackResumeResponse')}}}}}),async c=>{
    c.header('Cache-Control','no-store');
    const p=c.req.valid('param'),body=c.req.valid('json');
    await lookup(c.env.DB,p.projectId,p.sourceId,p.sourceVersionId);
    const current=await c.env.DB.prepare('SELECT job_id FROM media_processing WHERE source_version_id=?1 ORDER BY created_at DESC LIMIT 1').bind(p.sourceVersionId).first<{job_id:string}>();
    if(!current || current.job_id!==body.jobId)throw notFound('音频任务不存在或已被替换');
    const result=await resumeWaitingAudioFallback(c.env,current.job_id,c.get('user')!.id);
    return c.json(apiData(c,{jobId:result.jobId,status:result.status}),202);
  });
  app.openapi(retry, async c => {
    c.header('Cache-Control','no-store');
    const p = c.req.valid('param'); const body = c.req.valid('json'); await lookup(c.env.DB,p.projectId,p.sourceId,p.sourceVersionId);
    const result = await withIdempotency(c.env, { key: c.req.header('idempotency-key'), userId: c.get('user')!.id, operation: `source.summary:${p.projectId}:${p.sourceVersionId}`, rawBody: JSON.stringify(body) }, async () => ({ status: 202 as const, body: await enqueueSourceSummary(c.env,p.sourceVersionId,c.get('user')!.id,body.expectedSummaryRevision) }));
    return c.json(apiData(c,result.body),result.status);
  });
}
