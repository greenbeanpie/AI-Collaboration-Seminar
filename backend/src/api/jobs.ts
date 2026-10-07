import { executionSchema, readExecution, resolveExecutionTarget } from '../services/ai-execution-control';
import { checkpointAttemptIds } from '../services/ai-checkpoints';
import { aiActivitySchema, aiActivityEventsSchema, readActivity, readActivityEvents, recordActivity } from '../services/ai-activity';
import { retryFailedAiJob } from '../services/admin-ai-retries';
import { withIdempotency } from '../services/idempotency';
import type { FeedbackSnapshot } from '../services/project-feedback';
import { currentJobClarification } from '../services/ai-clarifications';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { apiData } from '../core/api';
import { apiErrorEnvelope, apiEnvelope } from '../core/openapi';
import { requireUser } from '../core/auth';
import { invalidState, permissionDenied } from '../core/errors';
import { getJob, tryDispatchJob } from '../services/jobs';
import { assertProfileStamp } from '../services/personal-profiles';

const jobParams = z.object({ jobId: z.string().uuid() });

const jobResponse = apiEnvelope(
  z.object({
    jobId: z.string().uuid(),
    kind: z.string(),
    status: z.enum(['queued', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled']),
    result: z.unknown().nullable(),
    error: z.unknown().nullable(),
    feedbackSnapshot: z.object({versionId:z.string().nullable(),version:z.number(),feedback:z.string(),actorId:z.string().nullable(),createdAt:z.string().nullable()}).optional(),
    attempts: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    finishedAt: z.string().nullable(),
    activity: aiActivitySchema,
    execution: executionSchema.nullable(),
    retry: z.object({ status: z.string(), attempts: z.number().int(), nextAttemptAt: z.string(), originalJobId: z.string().uuid() }).optional(),
  }),
  'JobResponse',
);

const retryResponse = apiEnvelope(z.object({ jobId: z.string().uuid() }), 'JobRetryResponse');

const getRoute = createRoute({
  method: 'get',
  path: '/api/v1/jobs/{jobId}',
  tags: ['jobs'],
  summary: '查询异步任务状态（前端 2s→10s 退避轮询）',
  request: { params: jobParams },
  responses: { 200: { content: { 'application/json': { schema: jobResponse } }, description: '任务状态' } },
});

const retryRoute = createRoute({
  method: 'post',
  path: '/api/v1/jobs/{jobId}/retry',
  tags: ['jobs'],
  summary: '重试失败任务（终态成功/取消不可重试）',
  request: { params: jobParams },
  responses: {
    202: { content: { 'application/json': { schema: retryResponse } }, description: '已重新排队' },
    409: { content: { 'application/json': { schema: apiErrorEnvelope } }, description: '终态不可重试' },
  },
});

export async function authorizedJob(env: import('../env').Env,jobId:string,userId:string){
 const job=await getJob(env,jobId);
 const privateInput=JSON.parse(job.input_json) as {operation?:string;questionId?:string;requestedBy?:string};
 if(privateInput.operation==='project.chat'&&(privateInput.requestedBy!==userId||!await env.DB.prepare('SELECT 1 FROM project_ai_chat_questions WHERE id=?1 AND user_id=?2').bind(privateInput.questionId??null,userId).first()))throw permissionDenied('问答历史不存在或不属于当前用户');
 if(job.project_id){
  const member=await env.DB.prepare('SELECT 1 FROM project_members WHERE project_id=?1 AND user_id=?2').bind(job.project_id,userId).first();
  if(!member)throw permissionDenied('不是项目成员');
 }else if(job.created_by!==userId){
  const input=JSON.parse(job.input_json) as {draftId?:string};
  const owner=input.draftId?await env.DB.prepare("SELECT 1 FROM project_creation_drafts WHERE id=?1 AND owner_id=?2 AND status!='cancelled'").bind(input.draftId,userId).first():null;
  if(!owner)throw permissionDenied('只有草稿拥有者可以读取或继续任务');
 }
 return job;
}
export async function currentSuccessor(env:import('../env').Env,jobId:string){
 const row=await env.DB.prepare(`WITH RECURSIVE chain(id,depth) AS (SELECT ?1,0 UNION ALL SELECT l.retry_job_id,chain.depth+1 FROM admin_ai_retry_links l JOIN chain ON l.parent_job_id=chain.id WHERE chain.depth<128) SELECT id FROM chain ORDER BY depth DESC LIMIT 1`).bind(jobId).first<{id:string}>();
 return row?.id??jobId;
}

export function registerJobRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use('/api/v1/jobs/:jobId', requireUser);
  app.use('/api/v1/jobs/:jobId/*', requireUser);

  app.openapi(getRoute, async (c) => {
    const originalJobId = c.req.valid('param').jobId;
    await authorizedJob(c.env,originalJobId,c.get('user')!.id);
    const job=await authorizedJob(c.env,await currentSuccessor(c.env,originalJobId),c.get('user')!.id);
    const input = JSON.parse(job.input_json) as {operation?:string;profileStamp?:string;feedbackSnapshot?:FeedbackSnapshot};
    if (job.project_id && (job.kind === 'assignment_suggest' || input.operation === 'collaboration.assign')) {
      await assertProfileStamp(c.env,job.project_id,input.profileStamp);
    }
    const clarification=job.status==='waiting_input'?await currentJobClarification(c.env,job.id,c.get('user')!.id):null;
    const retry = await c.env.DB.prepare("SELECT status,attempts,next_attempt_at FROM ai_automatic_retries WHERE target_kind='job' AND target_id=?1 ORDER BY updated_at DESC LIMIT 1").bind(job.id).first<{status:string;attempts:number;next_attempt_at:string}>();
    // A failed attempt with durable recovery pending is still an active logical request.
    // Existing pollers keep following it; the immutable failed attempt remains in D1.
    const status = job.status==='failed' && retry && ['pending','dispatching'].includes(retry.status) ? 'queued' : job.status;
    const activity=await readActivity(c.env,job.id,status);
    if(activity.canResume){
      try{
        const eligibility=await retryFailedAiJob(c.env,job.id,job.updated_at,undefined,{actorId:c.get('user')!.id,allowUncertainDispatch:true,dryRun:true});
        if(eligibility.status!=='queued'){activity.canResume=false;activity.resumeReason=eligibility.reason??'当前任务无法继续，请重新发起';}
      }catch(error){activity.canResume=false;activity.resumeReason=error instanceof Error?error.message:'任务上下文已变化，请重新发起';}
    }
    if(input.operation==='project.chat'&&activity.canResume){
      const chatInput=JSON.parse(job.input_json) as {questionId:string};
      const attempts=await checkpointAttemptIds(c.env,job.id);
      let saved=!!await c.env.DB.prepare('SELECT 1 FROM ai_investigations WHERE job_id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(attempts)).first();
      if(!saved)for(const attempt of attempts){if(await c.env.FILES.head(`ai/project-chat/${chatInput.questionId}/${attempt}.json`)){saved=true;break;}}
      activity.resumeReason=activity.uncertain?'上次模型请求已派发但结果未确认；继续该步骤可能再次计费。':saved?'将复用已保存进度继续。':'尚未保存检查点，继续时将重新执行本轮。';
    }
    if(job.status==='failed' && status==='queued')activity.code='waiting_retry';
    return c.json(
      apiData(c, {
        jobId: job.id,
        kind: job.kind,
        status,
        result: clarification ? {...(job.result_json?JSON.parse(job.result_json):{}),clarification} : job.result_json ? (JSON.parse(job.result_json) as unknown) : null,
        error: job.error_json ? (JSON.parse(job.error_json) as unknown) : null,
        feedbackSnapshot: input.feedbackSnapshot,
        attempts: job.attempts,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
        finishedAt: job.finished_at??null,
        activity,
        execution: await readExecution(c.env,await resolveExecutionTarget(c.env,{kind:'job',id:job.id})),
        ...(retry ? {retry:{status:retry.status,attempts:retry.attempts,nextAttemptAt:retry.next_attempt_at,originalJobId}} : {}),
      }),
      200,
    );
  });

  app.openapi(createRoute({method:'get',path:'/api/v1/jobs/{jobId}/activity-events',tags:['jobs'],summary:'读取 AI 操作记录（包含续跑历史）',request:{params:jobParams,query:z.object({cursor:z.coerce.number().int().min(0).optional(),limit:z.coerce.number().int().min(1).max(100).optional(),order:z.enum(['asc','desc']).optional()})},responses:{200:{description:'安全操作记录',content:{'application/json':{schema:apiEnvelope(aiActivityEventsSchema,'AiActivityEventsResponse')}}}}}),async c=>{
    const original=c.req.valid('param').jobId,user=c.get('user')!;
    await authorizedJob(c.env,original,user.id);
    const id=await currentSuccessor(c.env,original);
    await authorizedJob(c.env,id,user.id);
    const query=c.req.valid('query');
    return c.json(apiData(c,await readActivityEvents(c.env,id,query.cursor,query.limit,query.order)),200);
  });
  app.openapi(retryRoute,async c=>{
    const user=c.get('user')!,requested=c.req.valid('param').jobId;
    const job=await authorizedJob(c.env,requested,user.id);
    const current=await currentSuccessor(c.env,requested);
    if(current!==requested){
      await authorizedJob(c.env,current,user.id);
      return c.json(apiData(c,{jobId:current}),202);
    }
    const requestedActor=(JSON.parse(job.input_json) as {requestedBy?:string}).requestedBy??job.created_by;
    if(requestedActor&&requestedActor!==user.id)throw permissionDenied('仅原请求账户可继续任务');
    if(job.status!=='failed')throw invalidState('仅失败任务可继续');
    const result=await withIdempotency(c.env,{key:c.req.header('idempotency-key'),userId:user.id,operation:'ai.resume:'+requested,rawBody:JSON.stringify({jobId:requested})},async()=>{
      const retry=await retryFailedAiJob(c.env,requested,job.updated_at,undefined,{actorId:user.id,allowUncertainDispatch:true});
      if(retry.status!=='queued'||!retry.jobId){
        const successor=await currentSuccessor(c.env,requested);
        if(successor!==requested){await authorizedJob(c.env,successor,user.id);return {status:202 as const,body:{jobId:successor}};}
        throw invalidState(retry.reason??'任务无法继续，请重新发起');
      }
      await recordActivity(c.env,retry.jobId,'retrying','resumed');
      await tryDispatchJob(c.env,retry.jobId);
      return {status:202 as const,body:{jobId:retry.jobId}};
    });
    return c.json(apiData(c,result.body),202);
  });
}
