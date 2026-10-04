import { effectiveStandardGuardSql } from '../services/effective-standard';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { requireProjectMember, requireUser } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { newId, nowIso } from '../core/db';
import { invalidState, notFound, permissionDenied } from '../core/errors';
import { nextCursor, parsePaging } from '../core/pagination';
import { withIdempotency } from '../services/idempotency';
import { withReservedAiJob } from '../services/budget';
import { createJobAndDispatch } from '../services/jobs';
import { projectGoal, updateGoal, replaceTaskDependencies, saveStandard, standardView, type StandardRow, type StandardsInput } from '../services/project-simplification';
import { assessmentInputs, assessmentView, scoringReportSchema, type AssessmentRow } from '../services/assessments';
import { projectParams } from './projects';
import { correctAssessment, correctionInput } from '../services/assessment-corrections';
import { projectPermissionSql, requireProjectPermission } from '../services/project-permissions';
import { recordEvent } from '../services/events';
import { enqueueStandardsGeneration } from '../services/standards-generation';

const revision=z.number().int().positive();
export const goalSchema=z.object({projectId:z.string().uuid(),title:z.string(),detail:z.string(),revision,graphRevision:revision});
const citation=z.object({sourceVersionId:z.string().uuid(),fragmentId:z.string().uuid(),pageNumber:z.number().int().nullable(),quote:z.string().min(1).max(2000)});
const requirements=z.array(z.object({title:z.string().trim().min(1).max(200),detail:z.string().max(2000).default(''),category:z.enum(['deadline','deliverable','format','scoring','team','other']).default('deliverable'),dimensionKey:z.string().min(1).max(40).optional(),dueDate:z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/),z.string().datetime({offset:true})]).nullable().optional(),duePrecision:z.enum(['date','datetime','unknown']).optional(),citations:z.array(citation).max(20).optional()}).refine(value=>!value.dueDate?.includes('T')||value.duePrecision==='datetime','完整日期时间必须保持 datetime 精度')).max(100);
const weights=z.array(z.object({key:z.string().min(1).max(40),label:z.string().min(1).max(60),weight:z.number().min(0).max(100)})).max(10);
const standardInput=z.object({title:z.string().max(200).optional(),requirements:requirements.optional(),weights:weights.optional(),notes:z.string().max(2000).nullable().optional(),requirementSetIds:z.array(z.string().uuid()).max(50).optional(),rubricVersionId:z.string().uuid().optional(),mappings:z.array(z.object({requirementId:z.string().uuid(),dimensionKey:z.string().min(1).max(40)})).max(100).optional()}).strict().refine(value=>((value.requirements!==undefined&&value.weights!==undefined)||value.rubricVersionId!==undefined)&&((value.requirements!==undefined)===(value.weights!==undefined)),'请填写要求与评分维度，或选择已有要求集和评分版本');
export const standardSchema=z.object({standardsVersionId:z.string().uuid(),projectId:z.string().uuid(),version:revision,title:z.string(),status:z.enum(['draft','confirmed']),active:z.boolean(),revision,requirementSetIds:z.array(z.string().uuid()),rubricVersionId:z.string().uuid(),mappings:z.array(z.object({requirementId:z.string().uuid(),dimensionKey:z.string()})),requirements:z.array(z.object({requirementId:z.string().uuid(),requirementSetId:z.string().uuid(),title:z.string(),detail:z.string(),category:z.string(),dueDate:z.string().nullable(),duePrecision:z.string(),citations:z.array(z.unknown().openapi({description:'固定原文引用；读取时附带可选 sourceId、fileId、fileName、sourceTitle 和归档/不可用状态，不修改历史快照。'}))})),rubric:z.object({rubricVersionId:z.string().uuid(),version:revision,weights,notes:z.string().nullable()}),confirmedAt:z.string().nullable(),createdAt:z.string()});
const assessmentMetadataSchema=z.object({initiatorId:z.string().uuid().optional(),canOperate:z.boolean().optional(),assessmentId:z.string().uuid(),kind:z.enum(['material_review','rehearsal']),status:z.string(),goalRevision:revision.nullable(),goal:goalSchema.nullable(),standardsVersionId:z.string().uuid().nullable(),standardsVersion:revision.nullable(),materialVersionIds:z.array(z.string().uuid()),rehearsalId:z.string().uuid().nullable(),jobId:z.string().uuid().nullable(),jobError:z.string().nullable(),createdAt:z.string(),revision:revision.optional(),origin:z.string().optional(),aiReport:scoringReportSchema.nullable().optional()});
// Historical narrative records keep their original JSON; only new attempts authorize the strict grading contract.
export const assessmentSchema=z.discriminatedUnion('historical',[
  assessmentMetadataSchema.extend({historical:z.literal(false),report:scoringReportSchema.nullable()}),
  assessmentMetadataSchema.extend({historical:z.literal(true),report:z.unknown().nullable()}),
]);
const base='/api/v1/projects/{projectId}';
function endpoint(app:OpenAPIHono<AppEnv>,method:'get'|'post'|'patch'|'put',path:string,name:string,out:z.ZodType,handler:(c:Context<AppEnv>)=>Promise<Response>,body?:z.ZodType,status:200|201|202=200,query?:z.ZodObject){
  const extras:Record<string,z.ZodString>={};for(const match of path.matchAll(/\{(\w+)\}/g))extras[match[1]!]=z.string().uuid();
  app.openapi(createRoute({method,path:base+path,tags:['project-simplification'],request:{params:projectParams.extend(extras),...(body?{body:{required:true,content:{'application/json':{schema:body}}}}:{}),...(query?{query}: {})},responses:{[status]:{description:'成功',content:{'application/json':{schema:apiEnvelope(out,name)}}}}}),(async (c:Context<AppEnv>)=>{
    const response=await handler(c);
    if(method!=='get'&&response.ok&& !path.startsWith('/assessments'))await recordEvent(c.env,{projectId:c.req.param('projectId')!,actorType:'user',actorId:c.get('user')!.id,type:'project.'+name,entityType:'project',entityId:c.req.param('projectId')!,dedupKey:c.req.header('idempotency-key')??c.get('requestId'),payload:{path}});
    return response;
  }) as never);
}
async function assessmentById(c:Context<AppEnv>,id:string){
  const projectId=c.req.param('projectId')!,row=await c.env.DB.prepare('SELECT * FROM assessments WHERE id=?1 AND project_id=?2').bind(id,projectId).first<AssessmentRow>();if(row)return {...await assessmentView(c.env,row),initiatorId:row.created_by,canOperate:row.kind!=='rehearsal'||row.created_by===c.get('user')!.id};
  const review=await c.env.DB.prepare('SELECT * FROM reviews WHERE id=?1 AND project_id=?2').bind(id,projectId).first<{id:string;status:string;report_json:string|null;material_version_ids_json:string;created_at:string}>();
  if(review)return {assessmentId:review.id,kind:'material_review' as const,status:review.status,goalRevision:null,goal:null,standardsVersionId:null,standardsVersion:null,materialVersionIds:JSON.parse(review.material_version_ids_json),rehearsalId:null,report:review.report_json?JSON.parse(review.report_json):null,jobId:null,jobError:null,createdAt:review.created_at,historical:true as const};
  const rehearsal=await c.env.DB.prepare('SELECT * FROM rehearsals WHERE id=?1 AND project_id=?2').bind(id,projectId).first<{id:string;created_by:string;status:string;material_version_ids_json:string;created_at:string}>();if(!rehearsal)throw notFound('评分记录不存在');
  const summary=await c.env.DB.prepare("SELECT content_json FROM rehearsal_turns WHERE rehearsal_id=?1 AND kind='summary' ORDER BY sequence DESC LIMIT 1").bind(id).first<{content_json:string}>();return {initiatorId:rehearsal.created_by,canOperate:rehearsal.created_by===c.get('user')!.id,assessmentId:id,kind:'rehearsal' as const,status:rehearsal.status,goalRevision:null,goal:null,standardsVersionId:null,standardsVersion:null,materialVersionIds:JSON.parse(rehearsal.material_version_ids_json),rehearsalId:id,report:summary?JSON.parse(summary.content_json):null,jobId:null,jobError:null,createdAt:rehearsal.created_at,historical:true as const};
}
export function registerProjectSimplificationRoutes(app:OpenAPIHono<AppEnv>){
  app.use('/api/v1/projects/:projectId/tasks/:taskId/dependencies', requireUser, requireProjectMember());
  for(const path of ['goal','standards','assessments']){app.use(`/api/v1/projects/:projectId/${path}`,requireUser,requireProjectMember());app.use(`/api/v1/projects/:projectId/${path}/*`,requireUser,requireProjectMember());}
  endpoint(app,'get','/goal','ProjectGoalResponse',goalSchema,async c=>c.json(apiData(c,await projectGoal(c.env,c.req.param('projectId')!))));
  endpoint(app,'patch','/goal','ProjectGoalResponse',goalSchema,async c=>c.json(apiData(c,await updateGoal(c.env,c.req.param('projectId')!,c.get('user')!.id,await c.req.json()))),z.object({expectedRevision:revision,title:z.string().trim().min(1).max(200).optional(),detail:z.string().max(12000).optional()}).strict());
  endpoint(app,'put','/tasks/{taskId}/dependencies','TaskDependenciesResponse',z.object({taskId:z.string().uuid(),dependsOnTaskIds:z.array(z.string().uuid()),unfinishedDependencyIds:z.array(z.string().uuid()),graphRevision:revision}),async c=>{const b=await c.req.json();return c.json(apiData(c,await replaceTaskDependencies(c.env,c.req.param('projectId')!,c.get('user')!.id,c.req.param('taskId')!,b.expectedGraphRevision,b.dependsOnTaskIds)));},z.object({expectedGraphRevision:revision,dependsOnTaskIds:z.array(z.string().uuid()).max(1000)}).strict());
  endpoint(app,'get','/standards/current','CurrentStandardResponse',z.object({standard:standardSchema.nullable()}),async c=>{const row=await c.env.DB.prepare('SELECT * FROM standards_versions WHERE project_id=?1 ORDER BY version DESC LIMIT 1').bind(c.req.param('projectId')).first<StandardRow>();return c.json(apiData(c,{standard:row?await standardView(c.env,row):null}));});
  endpoint(app,'get','/standards','StandardsListResponse',z.object({items:z.array(standardSchema)}),async c=>{const rows=await c.env.DB.prepare('SELECT * FROM standards_versions WHERE project_id=?1 ORDER BY version DESC').bind(c.req.param('projectId')).all<StandardRow>();return c.json(apiData(c,{items:await Promise.all(rows.results.map(r=>standardView(c.env,r)))}));});
  endpoint(app,'post','/standards','StandardsResponse',standardSchema,async c=>{const projectId=c.req.param('projectId')!,userId=c.get('user')!.id,body=standardInput.parse(await c.req.json());const result=await withIdempotency(c.env,{key:c.req.header('idempotency-key'),userId,operation:'standard.save',rawBody:JSON.stringify({projectId,body})},async()=>({status:201 as const,body:await saveStandard(c.env,projectId,userId,body)}));return c.json(apiData(c,result.body),201);},standardInput,201);
  endpoint(app,'post','/standards/generate','StandardsGenerateResponse',z.object({jobId:z.string().uuid()}),async c=>{
    const projectId=c.req.param('projectId')!,userId=c.get('user')!.id;
    const result=await withIdempotency(c.env,{key:c.req.header('idempotency-key'),userId,operation:'standards.generate',rawBody:JSON.stringify({projectId})},async()=>({status:202 as const,body:await enqueueStandardsGeneration(c.env,projectId,userId)}));
    return c.json(apiData(c,result.body),202);
  },z.object({}).strict(),202);
  endpoint(app,'patch','/standards/{standardsVersionId}','StandardsResponse',standardSchema,async c=>{const {expectedRevision,...fields}=await c.req.json() as StandardsInput&{expectedRevision:number},projectId=c.req.param('projectId')!,userId=c.get('user')!.id,id=c.req.param('standardsVersionId')!,body=standardInput.parse(fields);const result=await withIdempotency(c.env,{key:c.req.header('idempotency-key'),userId,operation:'standard.edit',rawBody:JSON.stringify({projectId,id,expectedRevision,body})},async()=>({status:200 as const,body:await saveStandard(c.env,projectId,userId,body,id,expectedRevision)}));return c.json(apiData(c,result.body));},z.object({expectedRevision:revision,...standardInput.shape}).strict());
  endpoint(app,'get','/assessments','AssessmentListResponse',z.object({items:z.array(assessmentSchema),nextCursor:z.string().nullable()}),async c=>{
    const paging=parsePaging(c.req.query()),rows=await c.env.DB.prepare(`SELECT id,created_at FROM assessments WHERE project_id=?1 UNION ALL SELECT id,created_at FROM reviews WHERE project_id=?1 UNION ALL SELECT id,created_at FROM rehearsals WHERE project_id=?1 AND NOT EXISTS(SELECT 1 FROM assessments a WHERE a.entity_id=rehearsals.id) ORDER BY created_at DESC,id DESC`).bind(c.req.param('projectId')).all<{id:string;created_at:string}>();
    const eligible=rows.results.filter(r=>!paging.cursor||r.created_at<paging.cursor.createdAt||(r.created_at===paging.cursor.createdAt&&r.id<paging.cursor.id)),page=eligible.slice(0,paging.limit),last=page.at(-1);return c.json(apiData(c,{items:await Promise.all(page.map(r=>assessmentById(c,r.id))),nextCursor:nextCursor(eligible.length>paging.limit,last?{createdAt:last.created_at,id:last.id}:undefined)??null}));
  },undefined,200,z.object({cursor:z.string().optional(),limit:z.string().optional()}));
  endpoint(app,'patch','/assessments/{assessmentId}/scores','AssessmentCorrectionResponse',assessmentSchema,async c=>{const body=await c.req.json(),projectId=c.req.param('projectId')!,id=c.req.param('assessmentId')!,userId=c.get('user')!.id;const result=await withIdempotency(c.env,{key:c.req.header('idempotency-key'),userId,operation:'assessment.correct',rawBody:JSON.stringify({projectId,id,body})},async()=>({status:200 as const,body:await correctAssessment(c.env,projectId,id,userId,body)}));return c.json(apiData(c,result.body));},correctionInput);
  endpoint(app,'get','/assessments/{assessmentId}','AssessmentResponse',assessmentSchema,async c=>c.json(apiData(c,await assessmentById(c,c.req.param('assessmentId')!))));
  const create=z.object({kind:z.enum(['material_review','rehearsal']),standardsVersionId:z.string().uuid().optional(),materialVersionIds:z.array(z.string().uuid()).max(10).default([]),sourceVersionIds:z.array(z.string().uuid()).max(5).default([]),goalRevision:revision.optional()}).strict();
  endpoint(app,'post','/assessments','AssessmentCreateResponse',z.object({assessmentId:z.string().uuid(),jobId:z.string().uuid(),rehearsalId:z.string().uuid().optional()}),async c=>{
    const b=create.parse(await c.req.json()),projectId=c.req.param('projectId')!,userId=c.get('user')!.id;
    const preferredMaterials=[...b.materialVersionIds];
    const found=await c.env.DB.prepare("SELECT id,current_version_id FROM materials WHERE project_id=?1 AND purpose='output' AND current_version_id IS NOT NULL ORDER BY updated_at DESC,id").bind(projectId).all<{id:string;current_version_id:string}>();
    const frozen=new Map(found.results.map(m=>[m.id,m.current_version_id]));
    for(const versionId of preferredMaterials){const material=await c.env.DB.prepare("SELECT m.id,m.purpose FROM material_versions v JOIN materials m ON m.id=v.material_id WHERE v.id=?1 AND m.project_id=?2").bind(versionId,projectId).first<{id:string;purpose:string}>();if(!material)throw notFound('优先参考文档不属于本项目');if(material.purpose==='output')frozen.set(material.id,versionId);}
    const evaluationVersions=[...frozen.values()];
    const result=await withIdempotency(c.env,{key:c.req.header('idempotency-key'),userId,operation:'assessment.create',rawBody:JSON.stringify({projectId,...b})},async()=>{
      const input=await assessmentInputs(c.env,projectId,b.standardsVersionId,evaluationVersions,b.goalRevision,b.sourceVersionIds,preferredMaterials);
      await requireProjectPermission(c.env,projectId,userId,'scoreInitiate');
      return withReservedAiJob(c.env,{projectId,purpose:b.kind==='material_review'?'review_run':'rehearsal_turn',maxCalls:24},async(jobId,configVersionId)=>{
        const id=newId(),rehearsalId=b.kind==='rehearsal'?newId():null,now=nowIso(),batch=[c.env.DB.prepare(`INSERT INTO assessments(id,project_id,kind,entity_id,goal_revision,standards_version_id,inputs_json,status,job_id,created_by,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11 WHERE ${projectPermissionSql('?2','?10','scoreInitiate')} AND ${effectiveStandardGuardSql('?2','?6')}`).bind(id,projectId,b.kind,rehearsalId,input.goal.revision,input.standard.standardsVersionId,JSON.stringify(input),b.kind==='rehearsal'?'active':'pending',jobId,userId,now)];
        if(rehearsalId)batch.push(c.env.DB.prepare(`INSERT INTO rehearsals(id,project_id,scope,material_version_ids_json,status,created_by,created_at,processing_job_id) SELECT ?1,?2,'all',?3,'active',?4,?5,?6 WHERE ${projectPermissionSql('?2','?4','scoreInitiate')} AND EXISTS(SELECT 1 FROM assessments WHERE id=?7 AND project_id=?2 AND job_id=?6)`).bind(rehearsalId,projectId,JSON.stringify(evaluationVersions),userId,now,jobId,id));
        const inserted=await c.env.DB.batch(batch);if(!inserted[0]?.meta.changes)throw permissionDenied('评分发起权限已变化');
        try{await createJobAndDispatch(c.env,{jobId,projectId,kind:rehearsalId?'rehearsal_turn':'review_run',input:rehearsalId?{assessmentId:id,rehearsalId,projectId,phase:'question',configVersionId}:{assessmentId:id,projectId,configVersionId},createdBy:userId});}catch(error){if(!await c.env.DB.prepare('SELECT id FROM jobs WHERE id=?1').bind(jobId).first()){await c.env.DB.prepare('DELETE FROM assessments WHERE id=?1').bind(id).run();if(rehearsalId)await c.env.DB.prepare('DELETE FROM rehearsals WHERE id=?1').bind(rehearsalId).run();}throw error;}
        return {status:202 as const,body:{assessmentId:id,jobId,...(rehearsalId?{rehearsalId}:{})}};
      });
    });return c.json(apiData(c,result.body),202);
  },create,202);
}
