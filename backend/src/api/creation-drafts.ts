import { cancelDraftMediaStatements } from '../services/draft-media-lifecycle';
import { audioStatusSchema, audioResumeSchema } from './audio-schema';
import { resumeWaitingAudioFallback } from '../services/audio-pipeline';
import { registerDraftDocumentRoutes } from './draft-documents';
import { extOf, uploadLimit } from '../services/files';
import { mediaSummarySchema } from '../ai/gemini-media';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { requireUser } from '../core/auth';
import { apiData } from '../core/api';
import { apiEnvelope } from '../core/openapi';
import { newId, nowIso } from '../core/db';
import { invalidState, versionConflict, fileTooLarge } from '../core/errors';
import { LIMITS } from '../core/limits';
import { withIdempotency } from '../services/idempotency';
import { newCreationPayload, creationPayload, creationGoal, creationTask, getDraft, draftView, updateDraft, uploadDraftFile, previewDraft, commitDraft, type DraftRow } from '../services/creation-drafts';
import { enqueueDraftPreview, enqueueDraftContinuation } from '../services/draft-preview-jobs';
import { answerClarification, answerSchema, cancelClarification, clarificationSchema } from '../services/ai-clarifications';
import { loadDraftCheckpoint } from '../services/draft-preview-checkpoints';
import { projectTemplates } from '../services/creation-template';
const base = '/api/v1/creation-drafts';
const params = z.object({
  draftId: z.string().uuid()
});
const revision = z.number().int().min(1);
const fromTemplateBody=z.object({templateId:z.literal('blank')}).strict();
const fileSchema = z.object({
  id: z.string().uuid(), name: z.string(),mediaStatus:z.string().nullable().optional(),mediaJobId:z.string().uuid().nullable().optional(),audio:audioStatusSchema.nullable().optional(),mediaSummary:mediaSummarySchema.nullable().optional(),mediaError:z.string().nullable().optional(), sizeBytes: z.number(), sha256: z.string(), textReady: z.boolean(), textError: z.string().nullable()
});
const schema = z.object({
  id: z.string().uuid(), status: z.enum(['active', 'cancelled', 'committed']), revision, payload: creationPayload, preview: z.object({
    goal:creationGoal.optional(),tasks: z.array(creationTask), mode: z.enum(['ai', 'manual']), configVersionId: z.string().optional()
  }).nullable(), previewRevision: revision.nullable(), previewAttemptId: z.string().uuid().nullable().optional(), previewState: z.string(), clarification: clarificationSchema.nullable(), previewError: z.string().nullable(), files: z.array(fileSchema), removedFiles: z.array(fileSchema), projectId: z.string().nullable(), updatedAt: z.string()
});
const response = apiEnvelope(schema, 'CreationDraftResponse');
const commitResponse = apiEnvelope(z.object({
  projectId: z.string().uuid(), usernameInvitations: z.array(z.string()).optional(), invitations: z.array(z.object({
    label: z.string(), code: z.string(), expiresAt: z.string()
  }))
}), 'CreationCommitResponse');
const json = (schema: z.ZodType) => ({
  content: {
    'application/json': {
      schema
    }
  }, required: true
});
export function registerCreationDraftRoutes(app: OpenAPIHono<AppEnv>) {
  app.use(base, requireUser);
  app.use(base + '/*', requireUser);
  app.use('/api/v1/project-templates',requireUser);
  registerDraftDocumentRoutes(app);
  app.openapi(createRoute({method:'get',path:'/api/v1/project-templates',tags:['creation'],responses:{200:{description:'可用项目模板',content:{'application/json':{schema:apiEnvelope(z.object({items:z.array(z.object({templateId:z.literal('blank'),name:z.string(),description:z.string()}))}),'ProjectTemplateListResponse')}}}}}),async c=>c.json(apiData(c,{items:projectTemplates}),200));
  app.openapi(createRoute({method:'post',path:base+'/from-template',tags:['creation'],request:{body:json(fromTemplateBody)},responses:{201:{description:'私有模板编辑草稿，尚未创建项目',content:{'application/json':{schema:response}}}}}),async c=>{
    const body=fromTemplateBody.parse(c.req.valid('json')),user=c.get('user')!;
    const result=await withIdempotency(c.env,{key:c.req.header('idempotency-key'),required:true,userId:user.id,operation:'creation-draft.from-template',rawBody:JSON.stringify(body)},async()=>{
      const payload=newCreationPayload.parse({name:'未命名项目',workspace:{templateId:body.templateId,materials:[],standards:null}});
      const id=newId(),now=nowIso();
      await c.env.DB.prepare('INSERT INTO project_creation_drafts(id,owner_id,payload_json,project_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)').bind(id,user.id,JSON.stringify(payload),newId(),now).run();
      return {status:201 as const,body:await draftView(c.env,await getDraft(c.env,id,user.id))};
    });return c.json(apiData(c,result.body),201);
  });
  app.openapi(createRoute({
    method: 'post', path: base, tags: ['creation'], request: {
      body: json(newCreationPayload)
    }, responses: {
      201: {
        content: {
          'application/json': {
            schema: response
          }
        }, description: '私有草稿，不创建项目'
      }
    }
  }), async (c) => {
    const body = c.req.valid('json') as z.infer<typeof creationPayload>, user = c.get('user')!;
    const original = await c.req.json();
    const legacyRawBody = ['planningMode','assignmentMode','evaluationMode','progressionMode'].some(key => Object.hasOwn(original, key)) ? undefined : JSON.stringify(creationPayload.parse(original));
    const result = await withIdempotency(c.env, {
      key: c.req.header('idempotency-key'), required: true, userId: user.id, operation: 'creation-draft.create', rawBody: JSON.stringify(body), legacyRawBody
    }, async () => {
      const id = newId(), now = nowIso();
      await c.env.DB.prepare('INSERT INTO project_creation_drafts(id,owner_id,payload_json,project_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)').bind(id, user.id, JSON.stringify(body), newId(), now).run();
      return {
        status: 201 as const, body: await draftView(c.env, await getDraft(c.env, id, user.id))
      };
    });
    return c.json(apiData(c, result.body), 201);
  });
  app.openapi(createRoute({
    method: 'get', path: base, tags: ['creation'], responses: {
      200: {
        content: {
          'application/json': {
            schema: apiEnvelope(z.object({
              items: z.array(schema)
            }), 'CreationDraftListResponse')
          }
        }, description: '当前账户最多20个未完成草稿'
      }
    }
  }), async (c) => {
    const rows = await c.env.DB.prepare("SELECT * FROM project_creation_drafts WHERE owner_id=?1 AND status!='committed' ORDER BY updated_at DESC LIMIT 20").bind(c.get('user')!.id).all<DraftRow>();
    const items = [];
    for (const row of rows.results)
      items.push(await draftView(c.env, row));
    return c.json(apiData(c, {
      items
    }), 200);
  });
  app.openapi(createRoute({
    method: 'get', path: base + '/{draftId}', tags: ['creation'], request: {
      params
    }, responses: {
      200: {
        content: {
          'application/json': {
            schema: response
          }
        }, description: '草稿状态'
      }
    }
  }), async (c) => c.json(apiData(c, await draftView(c.env, await getDraft(c.env, c.req.valid('param').draftId, c.get('user')!.id))), 200));
  app.openapi(createRoute({
    method: 'patch', path: base + '/{draftId}', tags: ['creation'], request: {
      params, body: json(z.object({
        expectedRevision: revision, payload: creationPayload
      }).strict())
    }, responses: {
      200: {
        content: {
          'application/json': {
            schema: response
          }
        }, description: '已保存，旧预览失效'
      }
    }
  }), async (c) => {
    const body = c.req.valid('json') as {
      expectedRevision: number;
      payload: z.infer<typeof creationPayload>;
    };
    return c.json(apiData(c, await updateDraft(c.env, c.req.valid('param').draftId, c.get('user')!.id, body.expectedRevision, body.payload)), 200);
  });
  app.openapi(createRoute({
    method: 'post', path: base + '/{draftId}/state', tags: ['creation'], request: {
      params, body: json(z.object({
        expectedRevision: revision, status: z.enum(['active', 'cancelled'])
      }).strict())
    }, responses: {
      200: {
        content: {
          'application/json': {
            schema: response
          }
        }, description: '取消或恢复；资料保留'
      }
    }
  }), async (c) => {
    const body = c.req.valid('json') as {
      expectedRevision: number;
      status: 'active' | 'cancelled';
    }, id = c.req.valid('param').draftId, user = c.get('user')!.id;
    const row = await getDraft(c.env, id, user);
    if (row.status === 'committed') {
      throw invalidState('已创建项目不能取消草稿');
    }
    if (row.revision !== body.expectedRevision) {
      throw versionConflict(row.revision);
    }
    const changes = await c.env.DB.batch([c.env.DB.prepare("UPDATE project_creation_drafts SET status=?4,revision=revision+1,preview_state='none',preview_waiting_id=NULL,updated_at=?5 WHERE id=?1 AND owner_id=?2 AND revision=?3 AND status!='committed'").bind(id, user, body.expectedRevision, body.status, nowIso()),
      c.env.DB.prepare("UPDATE ai_clarifications SET status='cancelled',revision=revision+1,updated_at=?5 WHERE draft_id=?1 AND owner_id=?2 AND status='pending' AND context_revision=?3 AND EXISTS(SELECT 1 FROM project_creation_drafts d WHERE d.id=?1 AND d.owner_id=?2 AND d.revision=?3+1 AND d.status=?4 AND d.preview_waiting_id IS NULL)").bind(id,user,body.expectedRevision,body.status,nowIso()),...(body.status==='cancelled'?cancelDraftMediaStatements(c.env,{draftId:id,ownerId:user,revision:body.expectedRevision+1,status:'cancelled'}):[])]);
    if (!changes[0]?.meta.changes) {
      throw invalidState('草稿已变化');
    }
    return c.json(apiData(c, await draftView(c.env, await getDraft(c.env, id, user))), 200);
  });
  app.openapi(createRoute({
    method: 'put', path: base + '/{draftId}/files/{fileId}', tags: ['creation'], request: {
      params: params.extend({
        fileId: z.string().uuid()
      }), query: z.object({
        name: z.string().min(1).max(255), expectedRevision: z.string().regex(/^\d+$/)
      })
    }, responses: {
      200: {
        content: {
          'application/json': {
            schema: response
          }
        }, description: '暂存文件和可读取正文'
      }
    }
  }), async (c) => {
    const { draftId, fileId } = c.req.valid('param'), q = c.req.valid('query');
    await getDraft(c.env, draftId, c.get('user')!.id);
    // Read bodies with a hard byte cap before allocating the full upload.
    const reader = c.req.raw.body?.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          size += chunk.value.length;
          if (size > Math.min(10*1024*1024,uploadLimit(extOf(q.name))??Infinity)) {
            await reader.cancel();
            throw fileTooLarge(Math.min(10*1024*1024,uploadLimit(extOf(q.name))??Infinity));
          }
          chunks.push(chunk.value);
        }
      }
      finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return c.json(apiData(c, await uploadDraftFile(c.env, draftId, c.get('user')!.id, Number(q.expectedRevision), fileId, q.name, bytes)), 200);
  });
  app.openapi(createRoute({method:'post',path:base+'/{draftId}/files/{fileId}/media-resume',tags:['creation'],request:{params:params.extend({fileId:z.string().uuid()}),body:json(z.object({jobId:z.string().uuid()}).strict())},responses:{202:{description:'原音频任务已恢复',content:{'application/json':{schema:apiEnvelope(audioResumeSchema,'DraftAudioFallbackResumeResponse')}}}}}),async c=>{
    const p=c.req.valid('param'),body=c.req.valid('json') as {jobId:string},userId=c.get('user')!.id;
    const draft=await getDraft(c.env,p.draftId,userId);
    if(draft.status!=='active')throw invalidState('草稿已取消或创建，不能继续回退');
    const current=await c.env.DB.prepare(`SELECT j.id FROM creation_draft_files f JOIN jobs j ON json_extract(j.input_json,'$.fileId')=f.id WHERE f.id=?1 AND f.draft_id=?2 AND f.removed=0 AND json_extract(j.input_json,'$.operation')='media.draft' ORDER BY j.created_at DESC,j.id DESC LIMIT 1`).bind(p.fileId,p.draftId).first<{id:string}>();
    if(!current || current.id!==body.jobId)throw invalidState('文件任务已变化，请刷新');
    const result=await resumeWaitingAudioFallback(c.env,current.id,userId);
    return c.json(apiData(c,{jobId:result.jobId,status:result.status}),202);
  });
  app.openapi(createRoute({
    method: 'post', path: base + '/{draftId}/files/{fileId}/state', tags: ['creation'], request: {
      params: params.extend({
        fileId: z.string().uuid()
      }), body: json(z.object({
        expectedRevision: revision, removed: z.boolean()
      }).strict())
    }, responses: {
      200: {
        content: {
          'application/json': {
            schema: response
          }
        }, description: '可恢复地移除文件'
      }
    }
  }), async (c) => {
    const { draftId, fileId } = c.req.valid('param'), b = c.req.valid('json') as {
      expectedRevision: number;
      removed: boolean;
    }, user = c.get('user')!.id, row = await getDraft(c.env, draftId, user);
    if (row.status !== 'active' || row.revision !== b.expectedRevision || row.preview_state === 'running') {
      throw invalidState('草稿状态已变化');
    }
    const token = newId();
    const result = await c.env.DB.batch([c.env.DB.prepare("UPDATE project_creation_drafts SET revision=revision+1,preview_state='none',preview_attempt_id=?4,updated_at=?5 WHERE id=?1 AND owner_id=?2 AND revision=?3 AND status='active' AND preview_state!='running' AND EXISTS(SELECT 1 FROM creation_draft_files WHERE id=?6 AND draft_id=?1) AND (?7=1 OR (SELECT COUNT(*) FROM creation_draft_files WHERE draft_id=?1 AND removed=0)<10)").bind(draftId, user, b.expectedRevision, token, nowIso(), fileId, b.removed ? 1 : 0), c.env.DB.prepare('UPDATE creation_draft_files SET removed=?3 WHERE id=?1 AND draft_id=?2 AND EXISTS(SELECT 1 FROM project_creation_drafts WHERE id=?2 AND preview_attempt_id=?4)').bind(fileId, draftId, b.removed ? 1 : 0, token),...(b.removed?cancelDraftMediaStatements(c.env,{draftId,ownerId:user,revision:b.expectedRevision+1,status:'active',token,fileId}):[])]);
    if (!result[0]?.meta.changes) {
      throw invalidState('草稿已变化或文件不存在');
    }
    return c.json(apiData(c, await draftView(c.env, await getDraft(c.env, draftId, user))), 200);
  });
  app.openapi(createRoute({
    method: 'post', path: base + '/{draftId}/preview', tags: ['creation'], request: {
      params, body: json(z.object({
        expectedRevision: revision, mode: z.enum(['ai', 'manual']),goal:creationGoal.optional(),tasks: z.array(creationTask).max(20).default([]), regenerate: z.boolean().default(false),background:z.boolean().optional()
      }).strict())
    }, responses: {
      200: {
        content: {
          'application/json': {
            schema: response
          }
        }, description: '保存拆分预览，可直接复用'
      }
    }
  }), async (c) => {
    const b = c.req.valid('json') as {
      expectedRevision: number;
      mode: 'ai' | 'manual';
      tasks: z.infer<typeof creationTask>[];
      regenerate: boolean;
      goal?:z.infer<typeof creationGoal>;
      background?:boolean;
    };
    if(b.background && b.mode==='ai')return c.json(apiData(c,await enqueueDraftPreview(c.env,c.req.valid('param').draftId,c.get('user')!.id,b.expectedRevision,b.tasks,b.regenerate,b.goal)),200);
    return c.json(apiData(c, await previewDraft(c.env, c.req.valid('param').draftId, c.get('user')!.id, b.expectedRevision, b.mode, b.tasks, b.regenerate,b.goal)), 200);
  });
  const questionParams=params.extend({questionId:z.string().uuid()});
  app.openapi(createRoute({method:'post',path:base+'/{draftId}/clarifications/{questionId}/answer',tags:['creation'],request:{params:questionParams,body:json(answerSchema)},responses:{200:{description:'保存回答并继续原预览',content:{'application/json':{schema:response}}}}}),async c=>{
    const {draftId,questionId}=c.req.valid('param'),userId=c.get('user')!.id,row=await getDraft(c.env,draftId,userId);
    if(!row.preview_attempt_id)throw invalidState('草稿没有可恢复的预览');
    const restored=await loadDraftCheckpoint(c.env,row.preview_attempt_id);
    if(!restored||restored.checkpoint.draftId!==draftId||restored.checkpoint.userId!==userId)throw invalidState('预览恢复内容不存在');
    await answerClarification(c.env,{draftId,userId,attemptId:row.preview_attempt_id,revision:restored.checkpoint.revision},questionId,c.req.valid('json'));
    return c.json(apiData(c,await enqueueDraftContinuation(c.env,draftId,userId,row.preview_attempt_id,questionId)),200);
  });
  app.openapi(createRoute({method:'post',path:base+'/{draftId}/clarifications/{questionId}/cancel',tags:['creation'],request:{params:questionParams,body:json(z.object({expectedRevision:revision}).strict())},responses:{200:{description:'取消本次澄清，可手动修改预览',content:{'application/json':{schema:response}}}}}),async c=>{
    const {draftId,questionId}=c.req.valid('param'),userId=c.get('user')!.id,row=await getDraft(c.env,draftId,userId);
    if(!row.preview_attempt_id)throw invalidState('草稿没有可取消的澄清');
    await cancelClarification(c.env,{draftId,userId,attemptId:row.preview_attempt_id,revision:row.revision},questionId,(c.req.valid('json') as {expectedRevision:number}).expectedRevision);
    return c.json(apiData(c,await draftView(c.env,await getDraft(c.env,draftId,userId))),200);
  });
  app.openapi(createRoute({
    method: 'post', path: base + '/{draftId}/commit', tags: ['creation'], request: {
      params, body: json(z.object({
        expectedRevision: revision, confirmed: z.literal(true), expectedPreviewAttemptId: z.string().uuid().optional()
      }).strict())
    }, responses: {
      201: {
        content: {
          'application/json': {
            schema: commitResponse
          }
        }, description: '原子创建；以草稿ID恢复同一结果'
      }
    }
  }), async (c) => {
    const b = c.req.valid('json') as {
      expectedRevision: number; expectedPreviewAttemptId?: string;
    };
    return c.json(apiData(c, await commitDraft(c.env, c.req.valid('param').draftId, c.get('user')!.id, b.expectedRevision,b.expectedPreviewAttemptId)), 201);
  });
}
